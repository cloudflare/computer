import type { RuntimeId } from "../../shared/events";
import type { ComparisonFixture } from "../../shared/fixture";

export type RuntimeToolDescriptions = {
  read: string;
  write: string;
  edit: string;
  exec: string;
};

export function createRuntimeSystemPrompt(runtime: RuntimeId): string {
  return runtime === "workspace" ? workspaceSystemPrompt() : sandboxSystemPrompt();
}

export function createTaskPrompt(fixture: ComparisonFixture): string {
  const root = fixture.root.replace(/\/+$/, "");
  return [
    `You are working in a small docs project at ${root}.`,
    "",
    "Goal:",
    fixture.task,
    "",
    "Read first:",
    `- ${root}/feature-briefs/smart-request-policies.md`,
    `- ${root}/style-guide.md`,
    `- ${root}/docs-nav.json`,
    `- relevant existing docs under ${root}/docs/workers/`,
    "",
    "Known project files:",
    ...fixture.files.map((file) => `- ${root}/${file.path}`),
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
      exec: "Run a shell command through the Workspace environment. Reading and writing files does not need a container; exec starts or uses the container for docs validation or preview after content changes. Set cwd to /workspace/repo for project commands. If validation fails, repair the files and rerun the command.",
    };
  }

  return {
    read: "Read a UTF-8 text file from the Sandbox filesystem. Use an absolute path under /workspace/repo when you need exact file contents.",
    write:
      "Create or overwrite a text file in the Sandbox filesystem. Use an absolute path under /workspace/repo. This replaces the whole file, so use it for new files or full-file rewrites.",
    edit: "Apply exact text replacements to a file in the Sandbox filesystem. Use an absolute path under /workspace/repo. Each oldText must match exactly one current region in the file; read the file first if you need exact text.",
    exec: "Run a shell command inside the Sandbox container. Use this freely for project inspection, search, package scripts, tests, and other shell-native workflows. Set cwd to /workspace/repo for project commands. If validation fails, repair the files and rerun the command.",
  };
}

function workspaceSystemPrompt(): string {
  return [
    "You are an expert coding agent working in a Cloudflare Workspace.",
    "",
    "Environment:",
    "- The project root is /workspace/repo.",
    "- Use whichever tool is fastest and most reliable for the job.",
    "- Use read, edit, and write with absolute paths under /workspace/repo for exact file access and precise changes.",
    "- Known project files are listed in the task prompt, so shell discovery is usually unnecessary.",
    "- File tools operate on durable workspace storage and do not need a container.",
    "- Use exec for docs validation or preview after content changes are in place.",
    "- Set cwd to /workspace/repo for project commands.",
    "- Treat validation failures as actionable repair checklists, then rerun validation when possible.",
    "",
    "Workflow:",
    "1. Inspect the project files before editing.",
    "2. Use edit for targeted changes to existing files.",
    "3. Use write only for new files or complete rewrites.",
    "4. Keep changes minimal and focused on the task.",
    "5. Finish with a concise summary of the change and verification.",
  ].join("\n");
}

function sandboxSystemPrompt(): string {
  return [
    "You are an expert coding agent working inside a Cloudflare Sandbox.",
    "",
    "Environment:",
    "- The project root is /workspace/repo.",
    "- Files are available inside the sandbox filesystem.",
    "- Use whichever tool is fastest and most reliable for the job.",
    "- Use read, edit, and write with absolute paths under /workspace/repo for exact file access and precise changes.",
    "- Use exec freely for project inspection, search, package scripts, tests, and other shell-native workflows.",
    "- File tools and exec operate on the same seeded project session.",
    "- exec runs commands inside the sandbox container.",
    "- Set cwd to /workspace/repo for project commands.",
    "- Treat validation failures as actionable repair checklists, then rerun validation when possible.",
    "",
    "Workflow:",
    "1. Inspect the project files before editing.",
    "2. Use edit for targeted changes to existing files.",
    "3. Use write only for new files or complete rewrites.",
    "4. Keep changes minimal and focused on the task.",
    "5. Finish with a concise summary of the change and verification.",
  ].join("\n");
}
