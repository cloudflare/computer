import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../../workspace.js";
import { createPiTools } from "./index.js";

// Only read shapes its own model output, so a failing formatter is
// simulated by replacing it.
vi.mock("../common/fs/read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../common/fs/read.js")>();
  return {
    ...actual,
    readModelOutput: () => () => {
      throw new Error("formatter exploded");
    },
  };
});

describe("createPiTools model output", () => {
  it("returns a failing formatter as an error result rather than throwing", async () => {
    const workspace = new Workspace({ storage: new SQLiteTestStorage() });
    const tools = createPiTools({ workspace });
    await tools.execute({ id: "1", name: "write", arguments: { path: "/w/a.txt", content: "hi" } });

    const result = await tools.execute({ id: "2", name: "read", arguments: { path: "/w/a.txt" } });

    expect(result).toEqual({
      content: [{ type: "text", text: "formatter exploded" }],
      isError: true,
    });
    await workspace.close();
  });
});
