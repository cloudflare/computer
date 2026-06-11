import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import {
  createRuntimeSystemPrompt,
  createRuntimeToolDescriptions,
  createTaskPrompt,
} from "./prompts";

describe("runtime Think prompts", () => {
  test("gives Workspace practical guidance for direct file tools and process commands", () => {
    const prompt = createRuntimeSystemPrompt("workspace");

    expect(prompt).toContain("Cloudflare Workspace");
    expect(prompt).toContain("The project root is /workspace/repo.");
    expect(prompt).toContain("Use whichever tool is fastest and most reliable for the job.");
    expect(prompt).toContain(
      "Use read, edit, and write with absolute paths under /workspace/repo for exact file access and precise changes.",
    );
    expect(prompt).toContain("Use exec for docs validation or preview after content changes");
  });

  test("gives Sandbox practical guidance for a normal container workflow", () => {
    const prompt = createRuntimeSystemPrompt("sandbox");

    expect(prompt).toContain("Cloudflare Sandbox");
    expect(prompt).toContain("The project root is /workspace/repo.");
    expect(prompt).toContain("Use whichever tool is fastest and most reliable for the job.");
    expect(prompt).toContain(
      "Use exec freely for project inspection, search, package scripts, tests",
    );
    expect(prompt).toContain("exec runs commands inside the sandbox container");
  });

  test("builds an explicit docs task checklist for each runtime", () => {
    const prompt = createTaskPrompt(comparisonFixture);

    expect(prompt).toContain("You are working in a small docs project at /workspace/repo.");
    expect(prompt).toContain(comparisonFixture.task);
    expect(prompt).toContain("Read first:");
    expect(prompt).toContain("- /workspace/repo/feature-briefs/smart-request-policies.md");
    expect(prompt).toContain("- /workspace/repo/style-guide.md");
    expect(prompt).toContain("Acceptance criteria:");
    expect(prompt).toContain("Create /workspace/repo/docs/workers/smart-request-policies.md.");
    expect(prompt).toContain("Include the exact header name `x-bypass-token`.");
    expect(prompt).toContain("Include the exact phrase `Enterprise report exports`.");
    expect(prompt).toContain(
      "Add `/workers/smart-request-policies/` to the Workers section in docs-nav.json.",
    );
    expect(prompt).toContain("Update README.md with `smart-request-policies`");
    expect(prompt).toContain("Run `npm run check` from /workspace/repo after writing changes.");
    expect(prompt).toContain(
      "If validation fails, use every reported failure as a repair checklist and rerun validation.",
    );
  });

  test("tunes tool descriptions to the runtime boundary", () => {
    const workspace = createRuntimeToolDescriptions("workspace");
    const sandbox = createRuntimeToolDescriptions("sandbox");

    expect(workspace.read).toContain("Workspace file tools");
    expect(workspace.read).toContain("absolute path under /workspace/repo");
    expect(workspace.exec).toContain("does not need a container");
    expect(workspace.exec).toContain("If validation fails, repair the files and rerun the command");
    expect(sandbox.read).toContain("Sandbox filesystem");
    expect(sandbox.read).toContain("absolute path under /workspace/repo");
    expect(sandbox.exec).toContain(
      "Use this freely for project inspection, search, package scripts, tests",
    );
    expect(sandbox.exec).toContain("If validation fails, repair the files and rerun the command");
  });
});
