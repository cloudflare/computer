// Lazy-load target for `loadCreatePatch` in ./index.ts. Importing
// `diff` dynamically there would make the bundler build a namespace
// object inside the `diff` chunk the agent tools share, and the
// helper for that lives in the isomorphic-git chunk, so `./tools`
// would pull in isomorphic-git statically. A dynamic import of this
// module gets a chunk of its own with plain ESM exports instead.
export { createPatch } from "diff";
