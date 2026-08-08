declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean })
    prepare(sql: string): {
      iterate(...parameters: unknown[]): Iterable<Record<string, unknown>>
    }
    close(): void
  }
}
