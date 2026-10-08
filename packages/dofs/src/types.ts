export interface SQLCursorLike<Row extends object = Record<string, unknown>> {
  toArray(): Row[];
}

export interface SQLStorageLike {
  // Not generic: the Workers runtime's `exec` constrains its row type in
  // a way a generic signature here can't accept. Database casts rows to
  // the shape each query selects.
  exec(query: string, ...bindings: unknown[]): SQLCursorLike;
}

export interface DurableObjectStorageLike {
  sql: SQLStorageLike;
  transaction?<T>(closure: () => T | Promise<T>): T | Promise<T>;
  transactionSync?<T>(closure: () => T): T;
}

// A Durable Object's `ctx.storage` has to satisfy DurableObjectStorageLike
// as it is, without a cast. This fails to compile if the types drift.
type Assert<T extends true> = T;
type _DurableObjectStorageFits = Assert<
  DurableObjectStorage extends DurableObjectStorageLike ? true : false
>;
