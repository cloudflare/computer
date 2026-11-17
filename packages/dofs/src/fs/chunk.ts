// Fixed chunk size. Lives on its own so modules that writeFile.ts
// imports, such as refs.ts, can use it without an import cycle.
export const CHUNK_SIZE = 512 * 1024;
