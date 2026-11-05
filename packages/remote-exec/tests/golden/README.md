# Golden messages

Cross-language checks for the session protocol (`packages/remote-exec/schema/exec.capnp`).

- `requests.json` describes requests. TypeScript encodes them into `requests/<name>.bin`
  (`packages/computer/src/remote-exec/messages.test.ts`); Rust decodes those files and compares
  (`packages/remote-exec/src/proto.rs` tests).
- `responses.json` describes responses. Rust encodes them into `responses/<name>.bin`;
  TypeScript decodes those files and compares.

Each side also checks that its own encoding still matches the committed bytes. After a schema
change, regenerate with `UPDATE_GOLDEN=1` on both sides:
`UPDATE_GOLDEN=1 npm run test:rust --workspace @cloudflare/remote-exec` and
`UPDATE_GOLDEN=1 npm test --workspace @cloudflare/computer -- src/remote-exec/messages.test.ts`.
Bytes are hex in the JSON (`hash`, `data`, `token`).
