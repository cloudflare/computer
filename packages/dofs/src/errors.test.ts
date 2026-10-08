import { describe, expect, it } from "vitest";

import { createWorkspaceError } from "./errors.js";
import { WorkspaceFilesystem } from "./fs/filesystem.js";
import { withDB } from "./fs/with-db.js";

describe("createWorkspaceError", () => {
  it("appends the path to a message that doesn't name it", () => {
    expect(createWorkspaceError("ENOENT", "no such path", "/a/b").message).toBe(
      "no such path: /a/b",
    );
  });

  it("names the path once when the message already ends with it", () => {
    expect(createWorkspaceError("ENOENT", "no such path: /a/b", "/a/b").message).toBe(
      "no such path: /a/b",
    );
  });

  it("keeps the path on the error either way", () => {
    expect(createWorkspaceError("ENOENT", "no such path: /a/b", "/a/b")).toMatchObject({
      code: "ENOENT",
      path: "/a/b",
    });
  });

  it("names the path once in a filesystem error", async () => {
    await withDB(async (db) => {
      const fs = new WorkspaceFilesystem(db);
      await expect(fs.readdir("/missing")).rejects.toThrow(/^no such path: \/missing$/);
    });
  });
});
