import { randomUUID } from "node:crypto"

import { Pool, type PoolClient } from "pg"

// Firestore accepted arbitrary object-shaped documents. Keep that boundary
// permissive so existing domain interfaces do not need storage-only index
// signatures; JSONB is still the runtime validation boundary.
export type DocumentData = Record<string, unknown>

type FieldPathToken = { readonly kind: "document-id" }
type FieldOperation =
  | { readonly kind: "increment"; readonly amount: number }
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

function databaseUrl() {
  return process.env.DATABASE_URL || "postgresql://rawroute:rawroute@rawroute-postgres:5432/rawroute"
}

function maxPoolSize() {
  const parsed = Number(process.env.DATABASE_POOL_MAX || 20)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 20
}

let pool: Pool | undefined
let schemaReady: Promise<void> | undefined

function getPool() {
  if (pool) return pool
  pool = new Pool({
    connectionString: databaseUrl(),
    max: maxPoolSize(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
  })
  pool.on("error", () => undefined)
  return pool
}

async function ensureSchema() {
  if (schemaReady) return schemaReady
  schemaReady = (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS rawroute_documents (
        path TEXT PRIMARY KEY,
        collection_path TEXT NOT NULL,
        document_id TEXT NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await getPool().query("CREATE INDEX IF NOT EXISTS rawroute_documents_collection_idx ON rawroute_documents (collection_path)")
    await getPool().query("CREATE INDEX IF NOT EXISTS rawroute_documents_updated_idx ON rawroute_documents (updated_at)")
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
  const path = name.split(".").map((part) => part.replaceAll("'", "''")).join(",")
  return `data #>> '{${path}}'`
}

function jsonValue(value: unknown) {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? "null" : serialized
}

function jsonFieldExpression(field: string | FieldPathToken) {
  if (field === DOCUMENT_ID || (typeof field === "object" && field.kind === "document-id")) return undefined
  const name = fieldName(field)
  if (!name) throw new Error("Invalid document field.")
  const path = name.split(".").map((part) => part.replaceAll("'", "''")).join(",")
  return `data #> '{${path}}'`
}

function jsonParameter(parameters: unknown[], value: unknown) {
  parameters.push(jsonValue(value))
  return `$${parameters.length}::jsonb`
}

function textParameter(parameters: unknown[], value: unknown) {
  parameters.push(value === null || value === undefined ? null : String(value))
  return `$${parameters.length}`
}

function applyFilterSql(filters: Filter[], parameters: unknown[], where: string[]) {
  for (const filter of filters) {
    const expression = fieldExpression(filter.field)
    const jsonExpression = jsonFieldExpression(filter.field)
    if (filter.operator === "in" || filter.operator === "not-in" || filter.operator === "array-contains-any") {
      if (!Array.isArray(filter.value)) throw new Error(`${filter.operator} requires an array.`)
      if (filter.operator === "array-contains-any" && !jsonExpression) throw new Error("array-contains-any cannot target the document ID.")
      const comparisons = filter.value.map((value) => {
        if (filter.operator === "array-contains-any") return `${jsonExpression} @> ${jsonParameter(parameters, [value])}`
        if (!jsonExpression) return `document_id = ${textParameter(parameters, value)}`
        return `${jsonExpression} = ${jsonParameter(parameters, value)}`
      })
      if (!comparisons.length) where.push(filter.operator === "not-in" ? "TRUE" : "FALSE")
      else if (filter.operator === "not-in") where.push(`NOT (${comparisons.join(" OR ")})`)
      else where.push(`(${comparisons.join(" OR ")})`)
      continue
    }
    if (filter.operator === "array-contains") {
      if (!jsonExpression) throw new Error("array-contains cannot target the document ID.")
      where.push(`${jsonExpression} @> ${jsonParameter(parameters, [filter.value])}`)
      continue
    }
    if (filter.operator === "==" || filter.operator === "!=") {
      if (!jsonExpression) {
        const placeholder = textParameter(parameters, filter.value)
        where.push(`document_id ${filter.operator === "==" ? "=" : "<>"} ${placeholder}`)
      } else {
        const placeholder = jsonParameter(parameters, filter.value)
        where.push(`${jsonExpression} ${filter.operator === "==" ? "=" : "<>"} ${placeholder}`)
      }
      continue
    }
    const placeholder = textParameter(parameters, filter.value)
    if (!jsonExpression || typeof filter.value === "string") where.push(`${expression} ${filter.operator} ${placeholder}`)
    else if (typeof filter.value === "number") where.push(`jsonb_typeof(${jsonExpression}) = 'number' AND (${jsonExpression} #>> '{}')::numeric ${filter.operator} ${placeholder}::numeric`)
    else if (typeof filter.value === "boolean") where.push(`jsonb_typeof(${jsonExpression}) = 'boolean' AND (${jsonExpression} #>> '{}')::boolean ${filter.operator} ${placeholder}::boolean`)
    else throw new Error(`Unsupported range filter value for ${filter.operator}.`)
  }
}

function orderExpressions(field: string | FieldPathToken, direction: OrderDirection) {
  const normalizedDirection = direction === "desc" ? "DESC" : "ASC"
  if (!jsonFieldExpression(field)) return [`document_id ${normalizedDirection}`]
  const expression = jsonFieldExpression(field)!
  return [
    `CASE WHEN jsonb_typeof(${expression}) = 'number' THEN (${expression} #>> '{}')::numeric END ${normalizedDirection} NULLS LAST`,
    `CASE WHEN jsonb_typeof(${expression}) <> 'number' THEN ${expression} #>> '{}' END ${normalizedDirection} NULLS LAST`,
  ]
}

function operation(value: unknown): value is FieldOperation {
  return Boolean(value && typeof value === "object" && "kind" in value && [
    "increment", "delete", "server-timestamp", "array-union", "array-remove",
  ].includes((value as { kind?: unknown }).kind as string))
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function applyValue(previous: unknown, value: unknown): unknown {
  if (!operation(value)) return clone(value)
  if (value.kind === "delete") return undefined
  if (value.kind === "server-timestamp") return new Date().toISOString()
  if (value.kind === "increment") return (typeof previous === "number" ? previous : 0) + value.amount
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

function postgresErrorCode(error: unknown) {
  return (error as { code?: unknown } | null)?.code
}

function conflictError(message: string) {
  return Object.assign(new Error(message), { code: 6 })
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

  // Firestore's data() boundary is intentionally untyped; callers validate
  // each document against its domain shape just as they did before migration.
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

export type Firestore = LocalFirestore
export type Transaction = LocalTransaction
export type DocumentSnapshot = LocalDocumentSnapshot
export type QuerySnapshot<T extends DocumentData = DocumentData> = LocalQuerySnapshot<T>

export class LocalQuery {
  protected readonly filters: Filter[]
  protected readonly orderings: Ordering[]
  protected readonly maximum?: number

  constructor(filters: Filter[] = [], orderings: Ordering[] = [], maximum?: number) {
    this.filters = filters
    this.orderings = orderings
    this.maximum = maximum
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

  protected copy(changes: { filters?: Filter[]; orderings?: Ordering[]; maximum?: number }): LocalQuery {
    return new LocalQuery(changes.filters || this.filters, changes.orderings || this.orderings, changes.maximum === undefined ? this.maximum : changes.maximum)
  }

  protected queryParts(collectionPath: string) {
    const parameters: unknown[] = [collectionPath]
    const where = ["collection_path = $1"]
    applyFilterSql(this.filters, parameters, where)
    const order = this.orderings.length
      ? ` ORDER BY ${this.orderings.flatMap((entry) => orderExpressions(entry.field, entry.direction)).join(", ")}, document_id ASC`
      : " ORDER BY document_id ASC"
    const limit = this.maximum === undefined ? "" : ` LIMIT ${this.maximum}`
    return { parameters, sql: `SELECT path, document_id, data FROM rawroute_documents WHERE ${where.join(" AND ")}${order}${limit}` }
  }

  async get(client?: PoolClient): Promise<LocalQuerySnapshot> {
    const execute = async (queryClient: PoolClient) => {
      const parts = this.queryParts(this.collectionPath())
      const result = await queryClient.query(parts.sql, parts.parameters)
      return new LocalQuerySnapshot(result.rows.map((row) => new LocalDocumentSnapshot(new LocalDocumentReference(row.path), row.data as DocumentData)))
    }
    if (client) return execute(client)
    return withTransaction(execute, "READ COMMITTED")
  }

  protected collectionPath(): string {
    throw new Error("Query has no collection path.")
  }
}

export class LocalCollectionReference extends LocalQuery {
  readonly path: string

  constructor(path: string, filters: Filter[] = [], orderings: Ordering[] = [], maximum?: number) {
    super(filters, orderings, maximum)
    this.path = normalizeCollectionPath(path)
  }

  doc(id?: string) {
    const documentId = normalizeDocumentId(id || randomUUID())
    return new LocalDocumentReference(documentPath(this.path, documentId))
  }

  protected copy(changes: { filters?: Filter[]; orderings?: Ordering[]; maximum?: number }) {
    return new LocalCollectionReference(this.path, changes.filters || this.filters, changes.orderings || this.orderings, changes.maximum === undefined ? this.maximum : changes.maximum)
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
    return withTransaction(async (client) => readDocument(client, this), "READ COMMITTED")
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
    return withTransaction(async (client) => {
      await ensureSchema()
      await client.query("DELETE FROM rawroute_documents WHERE path = $1", [this.path])
    })
  }
}

export class LocalTransaction {
  private readonly operations: Array<(client: PoolClient) => Promise<void>> = []

  constructor(private readonly client: PoolClient) {}

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
    this.operations.push(async (client) => {
      await ensureSchema()
      await client.query("DELETE FROM rawroute_documents WHERE path = $1", [reference.path])
    })
  }

  async commit() {
    for (const operation of this.operations) await operation(this.client)
    this.operations.length = 0
  }
}

class LocalWriteBatch {
  private readonly operations: Array<(client: PoolClient) => Promise<void>> = []

  set(reference: LocalDocumentReference, data: object, options: SetOptions = {}) {
    this.operations.push((client) => writeDocument(client, reference, data, options.merge === true, false))
    return this
  }

  create(reference: LocalDocumentReference, data: object) {
    this.operations.push((client) => writeDocument(client, reference, data, false, true))
    return this
  }

  delete(reference: LocalDocumentReference) {
    this.operations.push(async (client) => {
      await ensureSchema()
      await client.query("DELETE FROM rawroute_documents WHERE path = $1", [reference.path])
    })
    return this
  }

  async commit() {
    await withTransaction(async (client) => {
      for (const operation of this.operations) await operation(client)
    })
    this.operations.length = 0
  }
}

async function readDocument(client: PoolClient, reference: LocalDocumentReference): Promise<LocalDocumentSnapshot> {
  await ensureSchema()
  const result = await client.query("SELECT data FROM rawroute_documents WHERE path = $1", [reference.path])
  return new LocalDocumentSnapshot(reference, result.rows[0]?.data as DocumentData | undefined)
}

async function writeDocument(client: PoolClient, reference: LocalDocumentReference, data: object, merge: boolean, createOnly: boolean) {
  const queryClient = client
  await ensureSchema()
  const existing = await readDocument(queryClient, reference)
  if (createOnly && existing.exists) throw conflictError(`Document ${reference.path} already exists.`)
  const next = applyData(existing.data(), data, merge)
  await queryClient.query(`
    INSERT INTO rawroute_documents (path, collection_path, document_id, data, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, NOW())
    ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `, [reference.path, collectionPathForDocument(reference.path), reference.id, JSON.stringify(next)])
}

async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>, isolation: "SERIALIZABLE" | "READ COMMITTED" = "SERIALIZABLE"): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await ensureSchema()
    const client = await getPool().connect()
    try {
      // Firestore transactions retry when a document read/write races with a
      // concurrent transaction. SERIALIZABLE gives the local adapter the same
      // all-or-nothing conflict behavior instead of allowing lost updates.
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)
      try {
        const result = await callback(client)
        await client.query("COMMIT")
        return result
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        const code = postgresErrorCode(error)
        if ((code === "40001" || code === "40P01") && attempt < 4) continue
        throw error
      }
    } finally {
      client.release()
    }
  }
  throw new Error("Local database transaction retry limit exceeded.")
}

export class LocalFirestore {
  collection(path: string) {
    return new LocalCollectionReference(path)
  }

  batch() {
    return new LocalWriteBatch()
  }

  async runTransaction<T>(callback: (transaction: LocalTransaction) => Promise<T>) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await withTransaction(async (client) => {
          const transaction = new LocalTransaction(client)
          const result = await callback(transaction)
          await transaction.commit()
          return result
        })
      } catch (error) {
        const code = postgresErrorCode(error)
        if ((code !== "40001" && code !== "40P01") || attempt === 4) throw error
      }
    }
    throw new Error("Local database transaction retry limit exceeded.")
  }

  async recursiveDelete(reference: LocalCollectionReference | LocalDocumentReference) {
    await withTransaction(async (client) => {
      await ensureSchema()
      const prefix = reference instanceof LocalCollectionReference ? reference.path : reference.path
      // `LIKE` treats `%` and `_` in a document path as wildcards. Use a
      // literal prefix test so deleting one collection/document cannot touch a
      // similarly named sibling path.
      await client.query("DELETE FROM rawroute_documents WHERE path = $1 OR position($2 in path) = 1", [prefix, `${prefix}/`])
    })
  }
}

let localFirestore: LocalFirestore | undefined

export function getLocalFirestore() {
  return localFirestore ||= new LocalFirestore()
}

export async function ensureLocalDatabase() {
  await ensureSchema()
}

export async function localDatabaseHealth() {
  try {
    await ensureSchema()
    await getPool().query("SELECT 1")
    return true
  } catch {
    return false
  }
}

export async function closeLocalDatabase() {
  if (!pool) return
  await pool.end()
  pool = undefined
  schemaReady = undefined
  localFirestore = undefined
}

export async function listLocalDocuments(collectionPath?: string) {
  await ensureSchema()
  const result = collectionPath
    ? await getPool().query("SELECT path, collection_path, document_id, data FROM rawroute_documents WHERE collection_path = $1 ORDER BY path", [collectionPath])
    : await getPool().query("SELECT path, collection_path, document_id, data FROM rawroute_documents ORDER BY path")
  return result.rows as Array<{ path: string; collection_path: string; document_id: string; data: DocumentData }>
}

export async function upsertLocalDocument(path: string, data: DocumentData) {
  const reference = new LocalDocumentReference(path)
  await reference.set(data)
}

export async function upsertLocalDocuments(documents: Array<{ path: string; data: object }>) {
  if (!documents.length) return
  await withTransaction(async (client) => {
    for (const document of documents) await writeDocument(client, new LocalDocumentReference(document.path), document.data, false, false)
  })
}

export async function deleteLocalDocuments(paths: string[]) {
  if (!paths.length) return
  await withTransaction(async (client) => {
    await ensureSchema()
    await client.query("DELETE FROM rawroute_documents WHERE path = ANY($1::text[])", [paths])
  })
}
