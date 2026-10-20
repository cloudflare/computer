import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { getWorkspace, Workspace, WORKSPACE_ROOT, WorkspaceFileStore } from "./index.js";

describe("the file helper from @cloudflare/computer", () => {
  it("reads missing files as null and writes into new directories", async () => {
    const workspace = new Workspace({ storage: new SQLiteTestStorage() });
    const files = new WorkspaceFileStore(workspace);
    const path = `${WORKSPACE_ROOT}/notes/today.md`;

    await expect(files.readAll(path)).resolves.toBeNull();
    await files.write(path, new TextEncoder().encode("ship it"));
    const written = await files.readAll(path);
    expect(written && new TextDecoder().decode(written)).toBe("ship it");
    await workspace.close();
  });

  it("works on a client that has not loaded yet", async () => {
    const workspace = new Workspace({ storage: new SQLiteTestStorage() });
    const client = getWorkspace({ __getWorkspaceStub: () => Promise.resolve(workspace.stub()) });
    const files = new WorkspaceFileStore(client);
    const path = `${WORKSPACE_ROOT}/a/b.txt`;

    await expect(files.readAll(path)).resolves.toBeNull();
    await files.write(path, new TextEncoder().encode("hello"));
    await expect(files.stat(path)).resolves.toMatchObject({ size: 5 });
    client[Symbol.dispose]();
    await workspace.close();
  });
});
