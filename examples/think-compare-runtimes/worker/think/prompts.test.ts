import { describe, expect, test } from "vitest";
import { comparisonFixture } from "../../shared/fixture";
import {
  createRuntimeSystemPrompt,
  createRuntimeToolDescriptions,
  createTaskPrompt,
} from "./prompts";

describe("runtime Think prompts", () => {
  test("gives both runtimes the same coding workflow", () => {
    const workspace = createRuntimeSystemPrompt("workspace");
    const sandbox = createRuntimeSystemPrompt("sandbox");

    for (const prompt of [workspace, sandbox]) {
      expect(prompt).toContain("The project root is /workspace/repo.");
      expect(prompt).toContain("Use whichever tool is fastest and most reliable for the job.");
      expect(prompt).toContain(
        "Use exec to search, list, and inspect before opening individual files",
      );
      expect(prompt).toContain("Use read when you need exact file contents before editing.");
      expect(prompt).toContain("Use edit for targeted changes to existing files.");
      expect(prompt).toContain(
        "Combine multiple replacements for the same file in one edit call when practical.",
      );
      expect(prompt).toContain("Use write for new files or complete rewrites.");
      expect(prompt).toContain(
        "After validation passes, stop editing and summarize the completed work.",
      );
    }
  });

  test("adds Workspace-specific guidance for durable files, worker shell, and container validation", () => {
    const prompt = createRuntimeSystemPrompt("workspace");

    expect(prompt).toContain("Cloudflare Workspace");
    expect(prompt).toContain("durable workspace storage");
    expect(prompt).toContain("Start Workspace discovery with the worker shell");
    expect(prompt).toContain("workspace container is for Node, npm, package scripts");
  });

  test("adds Sandbox-specific guidance for a normal container workflow", () => {
    const prompt = createRuntimeSystemPrompt("sandbox");

    expect(prompt).toContain("Cloudflare Sandbox");
    expect(prompt).toContain("one container-backed project session");
    expect(prompt).toContain("Use exec freely for search, listing, package scripts, tests");
    expect(prompt).toContain("file tools and exec see the same filesystem");
  });

  test("builds an explicit docs task checklist for each runtime", () => {
    const prompt = createTaskPrompt(comparisonFixture);

    expect(prompt).toContain("You are working in a small docs project at /workspace/repo.");
    expect(prompt).toContain(comparisonFixture.task);
    expect(prompt).toContain("Useful source material:");
    expect(prompt).toContain("- /workspace/repo/feature-briefs/smart-request-policies.md");
    expect(prompt).toContain("- /workspace/repo/style-guide.md");
    expect(prompt).toContain(
      "Locate related Workers docs and examples before drafting the new page.",
    );
    expect(prompt).not.toContain("Known project files:");
    expect(prompt).not.toContain("- /workspace/repo/package.json");
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
    expect(workspace.exec).toContain(
      "grep, find, ls, cat, pwd, head, tail, sed, and wc route to the worker shell",
    );
    expect(workspace.exec).toContain("npm, node, npx, pnpm, yarn, vitest, tsc");
    expect(workspace.exec).toContain(
      "After validation passes, summarize the work instead of making extra edits",
    );
    expect(sandbox.read).toContain("Sandbox filesystem");
    expect(sandbox.read).toContain("absolute path under /workspace/repo");
    expect(sandbox.exec).toContain(
      "Use this freely for search, listing, project inspection, package scripts, tests",
    );
    expect(sandbox.exec).toContain("If validation fails, repair the files and rerun the command");
  });
});
