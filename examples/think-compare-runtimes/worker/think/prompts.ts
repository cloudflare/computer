import type { RuntimeId } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";

export type RuntimeToolDescriptions = {
  read: string;
  write: string;
  edit: string;
  exec: string;
};

export function createRuntimeSystemPrompt(runtime: RuntimeId): string {
  return runtime === "workspace"
    ? [sharedCodingPrompt(), workspaceRuntimePrompt()].join("\n\n")
    : [sharedCodingPrompt(), sandboxRuntimePrompt()].join("\n\n");
}

export function createTaskPrompt(fixture: ComparisonFixture): string {
  const root = fixture.root.replace(/\/+$/, "");
  return [
    `You are working in a small docs project at ${root}.`,
    "",
    "Goal:",
    fixture.task,
    "",
    "Useful source material:",
    `- ${root}/feature-briefs/smart-request-policies.md`,
    `- ${root}/style-guide.md`,
    `- ${root}/docs-nav.json`,
    `- existing docs and examples under ${root}/docs/workers/`,
    "",
    "Locate related Workers docs and examples before drafting the new page.",
    "",
    "Acceptance criteria:",
    `- Create ${root}/docs/workers/smart-request-policies.md.`,
    "- Start the new page with YAML frontmatter containing `title`, `description`, and `lastUpdated`.",
    "- Describe Smart Request Policies clearly for Workers developers.",
    "- Include the exact header name `x-bypass-token`.",
    "- Include the exact phrase `Enterprise report exports`.",
    "- Include a TypeScript Worker example in the new page.",
    "- Mention that beta policies do not replace application authorization.",
    "- Add `/workers/smart-request-policies/` to the Workers section in docs-nav.json.",
    "- Update README.md with `smart-request-policies` so maintainers can find the new page.",
    `- Run \`npm run check\` from ${root} after writing changes.`,
    "- If validation fails, use every reported failure as a repair checklist and rerun validation.",
    "",
    "Before editing, inspect the source material and search or list related docs and examples as needed.",
    "Finish by summarizing what changed and how you verified it.",
  ].join("\n");
}

export function createRuntimeToolDescriptions(runtime: RuntimeId): RuntimeToolDescriptions {
  if (runtime === "workspace") {
    return {
      read: "Read a UTF-8 text file with Workspace file tools. Use an absolute path under /workspace/repo when you need exact file contents. Workspace file tools read durable workspace storage and do not need a container.",
      write:
        "Create or overwrite a text file with Workspace file tools. Use an absolute path under /workspace/repo. This replaces the whole file, so use it for new files or full-file rewrites.",
      edit: "Apply exact text replacements with Workspace file tools. Use an absolute path under /workspace/repo. Each oldText must match exactly one current region in the file; read the file first if you need exact text.",
      exec: "Run a shell command through the Workspace environment. grep, find, ls, cat, pwd, head, tail, sed, and wc route to the worker shell for fast text inspection. npm, node, npx, pnpm, yarn, vitest, tsc, and executable project scripts route to the workspace container for package/runtime work. cwd defaults to /workspace/repo and must stay under /workspace/repo. If validation fails, repair the files and rerun the command. After validation passes, summarize the work instead of making extra edits.",
    };
  }

  return {
    read: "Read a UTF-8 text file from the Sandbox filesystem. Use an absolute path under /workspace/repo when you need exact file contents.",
    write:
      "Create or overwrite a text file in the Sandbox filesystem. Use an absolute path under /workspace/repo. This replaces the whole file, so use it for new files or full-file rewrites.",
    edit: "Apply exact text replacements to a file in the Sandbox filesystem. Use an absolute path under /workspace/repo. Each oldText must match exactly one current region in the file; read the file first if you need exact text.",
    exec: "Run a shell command inside the Sandbox container. Use this freely for search, listing, project inspection, package scripts, tests, and other shell-native workflows. cwd defaults to /workspace/repo and must stay under /workspace/repo. If validation fails, repair the files and rerun the command.",
  };
}

function sharedCodingPrompt(): string {
  return [
    "You are an expert coding agent working on a small docs project.",
    "",
    "Shared workflow:",
    "- The project root is /workspace/repo.",
    "- Use whichever tool is fastest and most reliable for the job.",
    "- Use exec to search, list, and inspect before opening individual files when shell commands answer faster.",
    "- Use read when you need exact file contents before editing.",
    "- Use edit for targeted changes to existing files.",
    "- Combine multiple replacements for the same file in one edit call when practical.",
    "- Use write for new files or complete rewrites.",
    "- Keep changes minimal and focused on the task.",
    "- Treat validation failures as actionable repair checklists, then rerun validation when possible.",
    "- After validation passes, stop editing and summarize the completed work.",
  ].join("\n");
}

function workspaceRuntimePrompt(): string {
  return [
    "Runtime: Cloudflare Workspace.",
    "- Workspace file tools read and write durable workspace storage directly.",
    "- Start Workspace discovery with the worker shell for grep, find, ls, cat, pwd, head, tail, sed, and wc.",
    "- The workspace container is for Node, npm, package scripts, tests, and executable project scripts.",
    "- Prefer file tools for exact edits and the worker shell for fast discovery; use the container when the command needs a real runtime or package install context.",
  ].join("\n");
}

function sandboxRuntimePrompt(): string {
  return [
    "Runtime: Cloudflare Sandbox.",
    "- Files and commands run in one container-backed project session.",
    "- Sandbox file tools and exec see the same filesystem.",
    "- Use exec freely for search, listing, package scripts, tests, and other shell-native workflows.",
    "- Use read and edit when exact file contents or precise replacements are clearer than shell output.",
  ].join("\n");
}
