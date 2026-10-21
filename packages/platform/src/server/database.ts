import { mapConcurrent } from "./concurrency"
import { randomUUID } from "node:crypto"

import { Database, type SQLQueryBindings } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

export interface DocumentIntegration {
  initialize(database: Database, initial?: boolean): void
  validateCollection(collection: string): void
  tracks(collection: string): boolean
  changed(database: Database, collection: string, path: string, before: DocumentData | undefined, after: DocumentData | undefined): void
  deletingTree(database: Database, prefix: string, client: DatabaseClient, deleteDocument: (path: string) => Promise<void>): Promise<void>
}

const integrations = new Set<DocumentIntegration>()
export function installDocumentIntegration(value: DocumentIntegration) {
  if (integrations.has(value)) return
  if (database || schemaReady) throw new Error("Install document integration before opening the database.")
  integrations.add(value)
}

/** Explicit startup composition; all owners share the same queue/transaction.
 * Installation is additive and identity-idempotent so an owner's standalone
 * tools can initialize it again without replacing another owner's callbacks.
 */
export function installDocumentIntegrations(values: readonly DocumentIntegration[]) {
  if ((database || schemaReady) && values.some(value => !integrations.has(value))) throw new Error("Install document integration before opening the database.")
  for (const value of values) integrations.add(value)
}

// Accept arbitrary object-shaped documents so domain interfaces do not need
// storage-only index signatures; JSON is the runtime validation boundary.
export type DocumentData = Record<string, unknown>

type FieldPathToken = { readonly kind: "document-id" }
type FieldOperation =
  | { readonly kind: "increment"; readonly amount: number }
  | { readonly kind: "maximum"; readonly value: number | string }
  | { readonly kind: "delete" }
  | { readonly kind: "server-timestamp" }
  | { readonly kind: "array-union"; readonly values: unknown[] }
  | { readonly kind: "array-remove"; readonly values: unknown[] }

const DOCUMENT_ID: FieldPathToken = Object.freeze({ kind: "document-id" })

export const FieldPath = {
  documentId(): FieldPathToken {
    return DOCUMENT_ID
  },
}

export const FieldValue = {
  increment(amount: number): FieldOperation {
    if (!Number.isFinite(amount)) throw new Error("FieldValue.increment requires a finite number.")
    return { kind: "increment", amount }
  },
  maximum(value: number | string): FieldOperation {
    return { kind: "maximum", value }
  },
  delete(): FieldOperation {
    return { kind: "delete" }
  },
  serverTimestamp(): FieldOperation {
    return { kind: "server-timestamp" }
  },
  arrayUnion(...values: unknown[]): FieldOperation {
    return { kind: "array-union", values }
  },
  arrayRemove(...values: unknown[]): FieldOperation {
    return { kind: "array-remove", values }
  },
}

export type SetOptions = { merge?: boolean }
export type WhereOperator = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not-in" | "array-contains" | "array-contains-any"
export type OrderDirection = "asc" | "desc"

type Filter = { field: string | FieldPathToken; operator: WhereOperator; value: unknown }
type Ordering = { field: string | FieldPathToken; direction: OrderDirection }

let database: Database | undefined
let schemaReady: Promise<void> | undefined
/** Offline owner preparation must finish before this process opens its runtime DB. */
export function assertLocalDatabaseClosed() {
  if (database || schemaReady) throw new Error("Offline persistence preparation requires the runtime database to be closed.")
}
export function getDatabase() {
  if (database) return database
  const path = process.env.SQLITE_PATH || join(process.env.RAWROUTE_DATA_DIR || "data", "rawroute.sqlite")
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const connection = new Database(path, { create: true })
  try {
    if (path !== ":memory:") chmodSync(path, 0o600)
    connection.run("PRAGMA journal_mode = WAL")
    connection.run("PRAGMA synchronous = FULL")
    connection.run("PRAGMA busy_timeout = 5000")
    database = connection
    return connection
  } catch (error) {
    connection.close()
    throw error
  }
}

export type DatabaseClient = { query: typeof executeQuery }
function executeQuery(sql: string, parameters: unknown[] = []) {
  const statement = getDatabase().query(sql.replace(/\$(\d+)/g, "?$1"))
  const bindings = parameters as SQLQueryBindings[]
  const rows = /^\s*(SELECT|WITH)/i.test(sql)
    ? statement.all(...bindings) as Array<{ path: string; collection_path: string; document_id: string; data?: DocumentData }>
    : (statement.run(...bindings), [])
  for (const row of rows) if (typeof row.data === "string") row.data = JSON.parse(row.data) as DocumentData
  return Promise.resolve({ rows })
}

async function ensureSchema() {
  if (schemaReady) return schemaReady
  schemaReady = (async () => {
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS rawroute_documents (
        path TEXT PRIMARY KEY,
        collection_path TEXT NOT NULL,
        document_id TEXT NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await executeQuery("CREATE INDEX IF NOT EXISTS rawroute_documents_collection_idx ON rawroute_documents (collection_path)")
    await executeQuery("CREATE INDEX IF NOT EXISTS rawroute_documents_collection_document_idx ON rawroute_documents (collection_path, document_id)")
    await executeQuery("CREATE INDEX IF NOT EXISTS rawroute_documents_updated_idx ON rawroute_documents (updated_at)")
    for (const integration of integrations) integration.initialize(getDatabase(), true)
  })().catch((error) => {
    schemaReady = undefined
    throw error
  })
  return schemaReady
}

function assertPath(value: string, label: string) {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("//")) throw new Error(`Invalid ${label}.`)
  return value
}

function normalizeCollectionPath(path: string) {
  return assertPath(path, "collection path")
}

function normalizeDocumentId(id: string) {
  return assertPath(id, "document ID").replaceAll("/", "_")
}

function documentPath(collectionPath: string, id: string) {
  return `${collectionPath}/${id}`
}

function collectionPathForDocument(path: string) {
  const separator = path.lastIndexOf("/")
  if (separator < 1 || separator === path.length - 1) throw new Error("Invalid document path.")
  return path.slice(0, separator)
}

function documentIdForPath(path: string) {
  return path.slice(path.lastIndexOf("/") + 1)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function fieldName(field: string | FieldPathToken) {
  if (typeof field !== "string") return undefined
  if (!field || !field.split(".").every((part) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(part))) throw new Error(`Unsupported document field: ${field}`)
  return field
}

function fieldExpression(field: string | FieldPathToken) {
  if (field === DOCUMENT_ID || (typeof field === "object" && field.kind === "document-id")) return "document_id"
  const name = fieldName(field)
  if (!name) throw new Error("Invalid document field.")
  return `json_extract(data, '$.${name}')`
}

function jsonValue(value: unknown) {
  // Canonical object-key order gives extracted objects structural equality.
  const serialized = JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
      : entry)
  return serialized === undefined ? "null" : serialized
}

function jsonFieldExpression(field: string | FieldPathToken) {
  if (field === DOCUMENT_ID || (typeof field === "object" && field.kind === "document-id")) return undefined
  const name = fieldName(field)
  if (!name) throw new Error("Invalid document field.")
  return `json_extract(data, '$.${name}')`
}

function jsonComparison(expression: string, typeExpression: string, value: unknown, parameters: unknown[]) {
  if (value === null || value === undefined) return `${typeExpression} = 'null'`
  if (typeof value === "boolean") return `${typeExpression} = '${value ? "true" : "false"}'`
  const type = typeof value === "number" ? "IN ('integer', 'real')"
    : typeof value === "string" ? "= 'text'"
    : Array.isArray(value) ? "= 'array'" : "= 'object'"
  return `(${typeExpression} ${type} AND ${expression} = ${jsonParameter(parameters, value)})`
}

function jsonParameter(parameters: unknown[], value: unknown) {
  parameters.push(typeof value === "object" && value !== null ? jsonValue(value) : value === true ? 1 : value === false ? 0 : value ?? null)
  return `$${parameters.length}`
}

function textParameter(parameters: unknown[], value: unknown) {
  parameters.push(value === null || value === undefined ? null : String(value))
  return `$${parameters.length}`
}

function applyFilterSql(filters: Filter[], parameters: unknown[], where: string[]) {
  for (const filter of filters) {
    const expression = fieldExpression(filter.field)
    const jsonExpression = jsonFieldExpression(filter.field)
    const typeExpression = jsonExpression ? `json_type(data, '$.${fieldName(filter.field)}')` : ""
    if (filter.operator === "in" || filter.operator === "not-in" || filter.operator === "array-contains-any") {
      if (!Array.isArray(filter.value)) throw new Error(`${filter.operator} requires an array.`)
      if (filter.operator === "array-contains-any" && !jsonExpression) throw new Error("array-contains-any cannot target the document ID.")
      const comparisons = filter.value.map((value) => {
        if (filter.operator === "array-contains-any") return `(${typeExpression} = 'array' AND EXISTS (SELECT 1 FROM json_each(${jsonExpression}) WHERE ${jsonComparison("value", "type", value, parameters)}))`
        if (!jsonExpression) return `document_id = ${textParameter(parameters, value)}`
        return jsonComparison(jsonExpression, typeExpression, value, parameters)
      })
      if (!comparisons.length) where.push(filter.operator === "not-in" ? "TRUE" : "FALSE")
      else if (filter.operator === "not-in") where.push(`NOT (${comparisons.join(" OR ")})`)
      else where.push(`(${comparisons.join(" OR ")})`)
      continue
    }
    if (filter.operator === "array-contains") {
      if (!jsonExpression) throw new Error("array-contains cannot target the document ID.")
      where.push(`(${typeExpression} = 'array' AND EXISTS (SELECT 1 FROM json_each(${jsonExpression}) WHERE ${jsonComparison("value", "type", filter.value, parameters)}))`)
      continue
    }
    if (filter.operator === "==" || filter.operator === "!=") {
      if (!jsonExpression) {
        const placeholder = textParameter(parameters, filter.value)
        where.push(`document_id ${filter.operator === "==" ? "=" : "<>"} ${placeholder}`)
      } else {
        const comparison = jsonComparison(jsonExpression, typeExpression, filter.value, parameters)
        where.push(filter.operator === "==" ? comparison : `(${typeExpression} IS NOT NULL AND NOT (${comparison}))`)
      }
      continue
    }
    const placeholder = textParameter(parameters, filter.value)
    if (!jsonExpression || typeof filter.value === "string") where.push(`${expression} ${filter.operator} ${placeholder}`)
    else if (typeof filter.value === "number") where.push(`typeof(${jsonExpression}) IN ('integer', 'real') AND ${jsonExpression} ${filter.operator} CAST(${placeholder} AS REAL)`)
    else if (typeof filter.value === "boolean") where.push(`${jsonExpression} ${filter.operator} ${jsonParameter(parameters, filter.value)}`)
    else throw new Error(`Unsupported range filter value for ${filter.operator}.`)
  }
}

function orderExpressions(field: string | FieldPathToken, direction: OrderDirection) {
  const normalizedDirection = direction === "desc" ? "DESC" : "ASC"
  if (!jsonFieldExpression(field)) return [`document_id ${normalizedDirection}`]
  const expression = jsonFieldExpression(field)!
  return [`${expression} ${normalizedDirection} NULLS LAST`]
}

function operation(value: unknown): value is FieldOperation {
  return Boolean(value && typeof value === "object" && "kind" in value && [
    "increment", "maximum", "delete", "server-timestamp", "array-union", "array-remove",
  ].includes((value as { kind?: unknown }).kind as string))
}

function sameJson(left: unknown, right: unknown) {
  return jsonValue(left) === jsonValue(right)
}

function applyValue(previous: unknown, value: unknown): unknown {
  if (!operation(value)) return clone(value)
  if (value.kind === "delete") return undefined
  if (value.kind === "server-timestamp") return new Date().toISOString()
  if (value.kind === "increment") return (typeof previous === "number" ? previous : 0) + value.amount
  if (value.kind === "maximum") {
    if (typeof previous === "number" && typeof value.value === "number") return Math.max(previous, value.value)
    if (typeof previous === "string" && typeof value.value === "string") return previous > value.value ? previous : value.value
    return value.value
  }
  const previousArray = Array.isArray(previous) ? [...previous] : []
  if (value.kind === "array-union") {
    for (const item of value.values) if (!previousArray.some((candidate) => sameJson(candidate, item))) previousArray.push(clone(item))
    return previousArray
  }
  return previousArray.filter((candidate) => !value.values.some((item) => sameJson(candidate, item)))
}

function applyData(existing: DocumentData | undefined, input: object, merge: boolean) {
  const next: DocumentData = merge && existing ? clone(existing) : {}
  for (const [key, value] of Object.entries(input)) {
    const resolved = applyValue(next[key], value)
    if (resolved === undefined) delete next[key]
    else next[key] = resolved
  }
  return next
}

function conflictError(message: string) {
  return Object.assign(new Error(message), { code: "DOCUMENT_EXISTS" })
}

class LocalDocumentSnapshot<T extends DocumentData = DocumentData> {
  readonly exists: boolean
  readonly id: string
  readonly ref: LocalDocumentReference
  private readonly value: T | undefined

  constructor(ref: LocalDocumentReference, value: T | undefined) {
    this.ref = ref
    this.id = ref.id
    this.value = value === undefined ? undefined : clone(value)
    this.exists = value !== undefined
  }

  // The document boundary is intentionally untyped; callers validate
  // each document against its domain shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data(): any {
    return this.value === undefined ? undefined : clone(this.value)
  }
}

export class LocalQuerySnapshot<T extends DocumentData = DocumentData> {
  readonly docs: Array<LocalDocumentSnapshot<T>>
  readonly empty: boolean
  readonly size: number

  constructor(docs: Array<LocalDocumentSnapshot<T>>) {
    this.docs = docs
    this.empty = docs.length === 0
    this.size = docs.length
  }
}

export type Transaction = LocalTransaction
export type DocumentSnapshot = LocalDocumentSnapshot
export type QuerySnapshot<T extends DocumentData = DocumentData> = LocalQuerySnapshot<T>

export class LocalQuery {
  protected readonly filters: Filter[]
  protected readonly orderings: Ordering[]
  protected readonly maximum?: number
  protected readonly suppressDefaultOrder: boolean

  constructor(filters: Filter[] = [], orderings: Ordering[] = [], maximum?: number, suppressDefaultOrder = false) {
    this.filters = filters
    this.orderings = orderings
    this.maximum = maximum
    this.suppressDefaultOrder = suppressDefaultOrder
  }

  where(field: string | FieldPathToken, operator: WhereOperator, value: unknown): this {
    return this.copy({ filters: [...this.filters, { field, operator, value }] }) as this
  }

  orderBy(field: string | FieldPathToken, direction: OrderDirection = "asc"): this {
    return this.copy({ orderings: [...this.orderings, { field, direction }] }) as this
  }

  limit(maximum: number): this {
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Query limit must be a non-negative integer.")
    return this.copy({ maximum }) as this
  }

  withoutDefaultOrder(): this {
    return this.copy({ suppressDefaultOrder: true }) as this
  }

  protected copy(changes: { filters?: Filter[]; orderings?: Ordering[]; maximum?: number; suppressDefaultOrder?: boolean }): LocalQuery {
    return new LocalQuery(
      changes.filters || this.filters,
      changes.orderings || this.orderings,
      changes.maximum === undefined ? this.maximum : changes.maximum,
      changes.suppressDefaultOrder === undefined ? this.suppressDefaultOrder : changes.suppressDefaultOrder,
    )
  }

  protected queryParts(collectionPath: string) {
    const parameters: unknown[] = [collectionPath]
    const where = ["collection_path = $1"]
    applyFilterSql(this.filters, parameters, where)
    const order = this.orderings.length
      ? ` ORDER BY ${this.orderings.flatMap((entry) => orderExpressions(entry.field, entry.direction)).join(", ")}, document_id ASC`
      : this.suppressDefaultOrder ? "" : " ORDER BY document_id ASC"
    const limit = this.maximum === undefined ? "" : ` LIMIT ${this.maximum}`
    return { parameters, sql: `SELECT path, document_id, data FROM rawroute_documents WHERE ${where.join(" AND ")}${order}${limit}` }
  }

  async get(client?: DatabaseClient): Promise<LocalQuerySnapshot> {
    const execute = async (queryClient: DatabaseClient) => {
      const parts = this.queryParts(this.collectionPath())
      const result = await queryClient.query(parts.sql, parts.parameters)
      return new LocalQuerySnapshot(result.rows.map((row) => new LocalDocumentSnapshot(new LocalDocumentReference(row.path), row.data as DocumentData)))
    }
    if (client) return execute(client)
    return withTransaction(execute)
  }

  protected collectionPath(): string {
    throw new Error("Query has no collection path.")
  }
}

export class LocalCollectionReference extends LocalQuery {
  readonly path: string

  constructor(path: string, filters: Filter[] = [], orderings: Ordering[] = [], maximum?: number, suppressDefaultOrder = false) {
    super(filters, orderings, maximum, suppressDefaultOrder)
    this.path = normalizeCollectionPath(path)
  }

  doc(id?: string) {
    const documentId = normalizeDocumentId(id || randomUUID())
    return new LocalDocumentReference(documentPath(this.path, documentId))
  }

  protected copy(changes: { filters?: Filter[]; orderings?: Ordering[]; maximum?: number; suppressDefaultOrder?: boolean }) {
    return new LocalCollectionReference(
      this.path,
      changes.filters || this.filters,
      changes.orderings || this.orderings,
      changes.maximum === undefined ? this.maximum : changes.maximum,
      changes.suppressDefaultOrder === undefined ? this.suppressDefaultOrder : changes.suppressDefaultOrder,
    )
  }

  protected collectionPath() {
    return this.path
  }
}

export class LocalDocumentReference {
  readonly path: string
  readonly id: string

  constructor(path: string) {
    this.path = assertPath(path, "document path")
    this.id = documentIdForPath(path)
  }

  get parent() {
    return new LocalCollectionReference(collectionPathForDocument(this.path))
  }

  collection(path: string) {
    return new LocalCollectionReference(`${this.path}/${normalizeCollectionPath(path)}`)
  }

  async get() {
    return withTransaction(async (client) => readDocument(client, this))
  }

  async set(data: object, options: SetOptions = {}) {
    return withTransaction(async (client) => writeDocument(client, this, data, options.merge === true, false))
  }

  async create(data: object) {
    return withTransaction(async (client) => writeDocument(client, this, data, false, true))
  }

  async update(data: object) {
    return withTransaction(async (client) => {
      const current = await readDocument(client, this)
      if (!current.exists) throw new Error(`Document ${this.path} does not exist.`)
      await writeDocument(client, this, data, true, false)
    })
  }

  async delete() {
    return withTransaction(client => deleteDocument(client, this))
  }
}

export class LocalTransaction {
  private readonly operations: Array<(client: DatabaseClient) => Promise<void>> = []

  constructor(private readonly client: DatabaseClient) {}

  async get(reference: LocalDocumentReference): Promise<LocalDocumentSnapshot>
  async get(reference: LocalQuery): Promise<LocalQuerySnapshot>
  async get(reference: LocalDocumentReference | LocalQuery): Promise<LocalDocumentSnapshot | LocalQuerySnapshot> {
    if (reference instanceof LocalDocumentReference) return readDocument(this.client, reference)
    return reference.get(this.client)
  }

  set(reference: LocalDocumentReference, data: object, options: SetOptions = {}) {
    this.operations.push((client) => writeDocument(client, reference, data, options.merge === true, false))
  }

  create(reference: LocalDocumentReference, data: object) {
    this.operations.push((client) => writeDocument(client, reference, data, false, true))
  }

  update(reference: LocalDocumentReference, data: object) {
    this.operations.push(async (client) => {
      const snapshot = await readDocument(client, reference)
      if (!snapshot.exists) throw new Error(`Document ${reference.path} does not exist.`)
      await writeDocument(client, reference, data, true, false)
    })
  }

  delete(reference: LocalDocumentReference) {
    this.operations.push(client => deleteDocument(client, reference))
  }

  async commit() {
    await mapConcurrent(this.operations, 1, (operation) => operation(this.client))
    this.operations.length = 0
  }
}

class LocalWriteBatch {
  private readonly operations: Array<(client: DatabaseClient) => Promise<void>> = []

  set(reference: LocalDocumentReference, data: object, options: SetOptions = {}) {
    this.operations.push((client) => writeDocument(client, reference, data, options.merge === true, false))
    return this
  }

  create(reference: LocalDocumentReference, data: object) {
    this.operations.push((client) => writeDocument(client, reference, data, false, true))
    return this
  }

  delete(reference: LocalDocumentReference) {
    this.operations.push(client => deleteDocument(client, reference))
    return this
  }

  async commit() {
    await withTransaction(async (client) => {
      await mapConcurrent(this.operations, 1, (operation) => operation(client))
    })
    this.operations.length = 0
  }
}

async function readDocument(client: DatabaseClient, reference: LocalDocumentReference): Promise<LocalDocumentSnapshot> {
  await ensureSchema()
  const result = await client.query("SELECT data FROM rawroute_documents WHERE path = $1", [reference.path])
  return new LocalDocumentSnapshot(reference, result.rows[0]?.data as DocumentData | undefined)
}

async function writeDocument(client: DatabaseClient, reference: LocalDocumentReference, data: object, merge: boolean, createOnly: boolean) {
  const queryClient = client
  await ensureSchema()
  const collection = collectionPathForDocument(reference.path)
  for (const integration of integrations) integration.validateCollection(collection)
  const tracked = [...integrations].filter(integration => integration.tracks(collection))
  const existing = merge || createOnly || tracked.length ? await readDocument(queryClient, reference) : undefined
  if (createOnly && existing?.exists) throw conflictError(`Document ${reference.path} already exists.`)
  const before = existing?.data()
  const next = applyData(before, data, merge)
  await queryClient.query(`
    INSERT INTO rawroute_documents (path, collection_path, document_id, data, updated_at)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP
  `, [reference.path, collectionPathForDocument(reference.path), reference.id, jsonValue(next)])
  for (const integration of tracked) integration.changed(getDatabase(), collection, reference.path, before, next)
}

async function deleteDocument(client: DatabaseClient, reference: LocalDocumentReference) {
  const collection = collectionPathForDocument(reference.path)
  for (const integration of integrations) integration.validateCollection(collection)
  const tracked = [...integrations].filter(integration => integration.tracks(collection))
  const before = tracked.length ? (await readDocument(client, reference)).data() : undefined
  await client.query("DELETE FROM rawroute_documents WHERE path = $1", [reference.path])
  if (before) for (const integration of tracked) integration.changed(getDatabase(), collection, reference.path, before, undefined)
}

// Async document callbacks must hold the connection exclusively across awaits.
// Every public read/write joins this queue, preventing another request from
// observing or committing an in-progress transaction on the shared connection.
let transactionTail: Promise<void> = Promise.resolve()
export async function withTransaction<T>(callback: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const previous = transactionTail
  let release!: () => void
  transactionTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    await ensureSchema()
    const connection = getDatabase()
    for (const integration of integrations) integration.initialize(connection)
    connection.run("BEGIN IMMEDIATE")
    try {
      const result = await callback({ query: executeQuery })
      connection.run("COMMIT")
      return result
    } catch (error) {
      connection.run("ROLLBACK")
      throw error
    }
  } finally {
    release()
  }
}

export class SqliteDatabase {
  collection(path: string) {
    return new LocalCollectionReference(path)
  }

  batch() {
    return new LocalWriteBatch()
  }

  async runTransaction<T>(callback: (transaction: LocalTransaction) => Promise<T>) {
    return withTransaction(async (client) => {
      const transaction = new LocalTransaction(client)
      const result = await callback(transaction)
      await transaction.commit()
      return result
    })
  }

  async recursiveDelete(reference: LocalCollectionReference | LocalDocumentReference, options: { preserveRoot?: boolean } = {}) {
    await withTransaction(async (client) => {
      await ensureSchema()
      const prefix = reference instanceof LocalCollectionReference ? reference.path : reference.path
      await mapConcurrent([...integrations], 1, integration => integration.deletingTree(getDatabase(), prefix, client, (path) => deleteDocument(client, new LocalDocumentReference(path))))
      // `LIKE` treats `%` and `_` in a document path as wildcards. Use a
      // literal prefix test so deleting one collection/document cannot touch a
      // similarly named sibling path.
      await client.query(options.preserveRoot ? "DELETE FROM rawroute_documents WHERE substr(path, 1, length($2)) = $2 AND path != $1" : "DELETE FROM rawroute_documents WHERE path = $1 OR substr(path, 1, length($2)) = $2", [prefix, `${prefix}/`])
    })
  }
}

let sqliteDatabase: SqliteDatabase | undefined

export function getSqliteDatabase() {
  return sqliteDatabase ||= new SqliteDatabase()
}

export async function ensureLocalDatabase() {
  await ensureSchema()
  for (const integration of integrations) integration.initialize(getDatabase())
}

export async function localDatabaseHealth() {
  try {
    await ensureSchema()
    await withTransaction((client) => client.query("SELECT 1"))
    return true
  } catch {
    return false
  }
}

export async function closeLocalDatabase() {
  await transactionTail
  if (!database) return
  database.close()
  database = undefined
  schemaReady = undefined
  sqliteDatabase = undefined
}

export async function listLocalDocuments(collectionPath?: string) {
  await ensureSchema()
  const result = await withTransaction((client) => collectionPath
    ? client.query("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE collection_path = $1 ORDER BY path", [collectionPath])
    : client.query("SELECT path, collection_path, document_id, data FROM rawroute_documents ORDER BY path"))
  return result.rows as Array<{ path: string; collection_path: string; document_id: string; data: DocumentData }>
}
