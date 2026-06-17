/**
 * TriageWorkflow — drives the agent through one explore + one
 * structure step, as described in `docs/think/workflows.md`.
 *
 * Pipeline:
 *
 *   1. fetch-issue      (deterministic GitHub REST call)
 *   2. set-phase-explore
 *   3. explore           (agent turn with full toolset — model decides
 *                         whether to attempt a fix or just gather
 *                         findings, depending on how big the change
 *                         looks)
 *   4. set-phase-structure
 *   5. structure         (tool-less `step.prompt` that coerces the
 *                         explore turn's text into the final schema)
 *   6. build-patch       (`git diff HEAD` inside the container)
 *   7. publish-artifact  (optional Artifacts repo + review branch)
 *   8. notify-done       (terminal payload, message ends in DONE)
 *
 * The explore step swallows budget exhaustion: if the agent ran out
 * of steps or the model stream errored on context overflow, the
 * workflow skips structure and posts a `DONE` carrying whatever
 * partial text we have. That keeps the demo from wedging when the
 * agent hits a wall mid-thought.
 */

import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import type { AgentWorkflowEvent } from "agents/workflows";
import { z } from "zod";
import type { AgentTurnResult, ArtifactPublication, TriageAgent } from "./agent.js";

export interface TriageWorkflowParams {
  issueUrl: string;
}

const triageSchema = z.object({
  attemptedFix: z
    .boolean()
    .describe("True if the agent edited files. False for findings-only runs."),
  commitSubject: z
    .string()
    .describe(
      "One-line imperative subject. For findings-only runs prefix with " +
        "'investigate:' or 'docs:' so the workflow can use it as the headline.",
    ),
  commitBody: z
    .string()
    .describe(
      "One or two paragraphs of context: the fix, or the findings. " + "No marketing voice.",
    ),
  filesChanged: z
    .array(z.string())
    .describe("Absolute paths of files edited. Empty for findings-only runs."),
  testsRun: z
    .array(z.string())
    .describe("Verification commands run, in order. May be empty if no fix was attempted."),
  nextSteps: z
    .array(z.string())
    .describe("Concrete next steps a human should take. Empty if the fix is complete."),
});

type TriageOut = z.infer<typeof triageSchema>;

export class TriageWorkflow extends ThinkWorkflow<TriageAgent, TriageWorkflowParams> {
  async run(
    event: AgentWorkflowEvent<TriageWorkflowParams>,
    step: ThinkWorkflowStep,
  ): Promise<void> {
    const { issueUrl } = event.payload;

    // 1. fetch-issue — durable, deterministic; safe to replay.
    const issue = await step.do("fetch-issue", async () => {
      return fetchIssue(issueUrl);
    });
    console.log(`[wf] fetched issue ${issue.repo}#${issue.number}`);

    // 2. explore — the agent runs its full agentic loop. Budget
    //    exhaustion is folded into the returned `status`; on a
    //    non-`ok` outcome we bail to notify-done with what we have.
    await step.do("set-phase-explore", () => this.agent.setPhase("explore"));
    const exploreResult: AgentTurnResult = await step.do("explore", async () => {
      const r = await this.agent.runAgentTurn(
        [
          `You are triaging GitHub issue ${issue.repo}#${issue.number}.`,
          `Title: ${issue.title}`,
          `URL: ${issueUrl}`,
          "",
          "Issue body:",
          issue.body || "(empty)",
          "",
          `Clone the repo (\`${issue.repo}\`) into /workspace/repo with`,
          '`exec({ command: "git clone --depth=1 https://github.com/<repo> /workspace/repo", backend: "shell" })`,',
          "then explore it. Decide whether the issue is",
          "small enough to fix in a handful of edits with a way to",
          "verify it. If yes, apply the minimal fix and run the",
          "project's tests / typecheck via `exec` to confirm. If no,",
          "do NOT edit anything and write up findings + next steps",
          "instead.",
          "",
          "When you are done, follow the response format in your",
          "system prompt.",
        ].join("\n"),
      );
      // Re-pack as a plain object so the Workflows step framework's
      // `Serializable<T>` constraint doesn't fail on the RPC-stub
      // shape that comes back across the agent stub boundary.
      return { status: r.status, text: r.text, reason: r.reason };
    });
    console.log(
      `[wf] explore done status=${exploreResult.status} chars=${exploreResult.text.length}`,
    );

    // 3. If the agent burned its budget, skip structuring and
    //    short-circuit with a clear DONE that carries the partial
    //    text. We still emit a patch in case it managed to write
    //    files before stalling.
    if (exploreResult.status !== "ok") {
      const patch = await step.do("build-patch-partial", async () => {
        return this.agent.gitDiff();
      });
      const artifact: ArtifactPublication | null = await step.do(
        "publish-artifact-partial",
        async () => {
          const published = await this.agent.publishArtifact({
            repoUrl: `https://github.com/${issue.repo}.git`,
            issueNumber: issue.number,
            patch,
            commitSubject: `partial: ${exploreResult.status}`,
            commitBody: exploreResult.reason,
          });
          return published ? plainArtifactPublication(published) : null;
        },
      );
      await step.do("notify-done-partial", async () => {
        const head = exploreResult.status === "out-of-steps" ? "Budget exhausted" : "Run failed";
        const message = [
          `${head}: ${exploreResult.reason}.`,
          exploreResult.text ? `Partial output:\n${exploreResult.text}` : null,
          artifactSummary(artifact),
          "DONE",
        ]
          .filter(Boolean)
          .join("\n\n");
        await this.agent.postWebhook({
          message,
          patch,
          commit: {
            subject: `partial: ${exploreResult.status}`,
            body: exploreResult.reason,
          },
        });
      });
      return;
    }

    // 4. structure — tool-less coercion into the zod schema.
    await step.do("set-phase-structure", () => this.agent.setPhase("structure"));
    const triage: TriageOut = await step.prompt("structure", {
      prompt: [
        "Restructure the following triage report into the required JSON",
        "schema. Do not invent files or commands; only restate what is",
        "there. If the agent did not attempt a fix, set `attemptedFix:",
        "false`, leave `filesChanged` and `testsRun` empty, and put the",
        "recommended actions into `nextSteps`.",
        "",
        exploreResult.text,
      ].join("\n"),
      output: triageSchema,
      timeout: "30 minutes",
    });
    console.log(`[wf] structure done: ${JSON.stringify(triage).slice(0, 300)}`);

    // 5. build-patch — ask the agent for the unified diff.
    const patch = await step.do("build-patch", async () => {
      return this.agent.gitDiff();
    });
    console.log(`[wf] patch length=${patch.length}`);

    // 6. publish-artifact — if Artifacts is configured, import the
    //    source repository, commit the working tree to a review
    //    branch, and push it to the artifact repo.
    const artifact: ArtifactPublication | null = await step.do("publish-artifact", async () => {
      const published = await this.agent.publishArtifact({
        repoUrl: `https://github.com/${issue.repo}.git`,
        issueNumber: issue.number,
        patch,
        commitSubject: triage.commitSubject,
        commitBody: triage.commitBody,
      });
      return published ? plainArtifactPublication(published) : null;
    });

    // 7. notify-done — terminal payload with a DONE-suffixed message.
    await step.do("notify-done", async () => {
      const verb = patch.trim()
        ? "Patch ready"
        : triage.attemptedFix
          ? "Fix attempted, no diff captured"
          : "Findings only";
      const parts = [`${verb}: ${triage.commitSubject}.`, artifactSummary(artifact), "DONE"];
      const message = parts.filter(Boolean).join("\n\n");
      await this.agent.postWebhook({
        message,
        patch,
        commit: { subject: triage.commitSubject, body: triage.commitBody },
      });
    });
  }
}

function plainArtifactPublication(artifact: ArtifactPublication): ArtifactPublication {
  return {
    repo: artifact.repo,
    remote: artifact.remote,
    branch: artifact.branch,
    shareLink: artifact.shareLink,
  };
}

function artifactSummary(artifact: ArtifactPublication | null): string | null {
  if (!artifact) return null;
  return `Artifact: ${artifact.shareLink}\nBranch: ${artifact.branch}`;
}

// ── GitHub REST helper ─────────────────────────────────────────────

interface IssueRef {
  repo: string;
  number: number;
  title: string;
  body: string;
}

/**
 * Parse `https://github.com/<owner>/<repo>/issues/<n>` and fetch the
 * issue body. Public API; no auth header. Failures surface to the
 * workflow as a thrown error inside `step.do`, which Workflows
 * retries with backoff.
 */
async function fetchIssue(issueUrl: string): Promise<IssueRef> {
  const match = issueUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\b/);
  if (!match) {
    throw new Error(`Not a recognised GitHub issue URL: ${issueUrl}`);
  }
  const [, owner, name, num] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${name}/issues/${num}`;
  const res = await fetch(apiUrl, {
    headers: {
      "user-agent": "cloudflare-think-example/0.0",
      accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${apiUrl}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    title?: string;
    body?: string | null;
  };
  return {
    repo: `${owner}/${name}`,
    number: Number(num),
    title: json.title ?? "(no title)",
    body: json.body ?? "",
  };
}
