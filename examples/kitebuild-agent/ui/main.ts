// The page: a task box that streams the agent's steps, and a terminal on
// the same Workspace to check its work. It keeps no history; a reload starts
// a new conversation, while the Workspace's files stay.

import { createTerminal } from "./terminal";

type AgentEvent =
  | { type: "text"; text: string }
  | { type: "call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "result"; id: string; output: string; isError: boolean }
  | { type: "done"; reply: string }
  | { type: "error"; message: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const workspace = $<HTMLInputElement>("workspace");
const taskForm = $<HTMLFormElement>("task-form");
const task = $<HTMLTextAreaElement>("task");
const run = $<HTMLButtonElement>("run");
const log = $<HTMLOListElement>("log");

const base = () => `/c/${encodeURIComponent(workspace.value.trim() || "demo")}`;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

// One line per tool call, showing what it did: the command for exec,
// the path for file tools.
function describe(name: string, args: Record<string, unknown>): string {
  if (name === "exec" && typeof args.command === "string") return `$ ${args.command}`;
  const target = args.path ?? args.pattern ?? "";
  return `${name} ${typeof target === "string" ? target : JSON.stringify(target)}`.trim();
}

const calls = new Map<string, HTMLDetailsElement>();

function show(event: AgentEvent): void {
  if (event.type === "text") {
    log.append(element("li", "text", event.text));
  } else if (event.type === "call") {
    const item = element("li", "call");
    const details = document.createElement("details");
    details.append(element("summary", "", describe(event.name, event.arguments)));
    item.append(details);
    log.append(item);
    calls.set(event.id, details);
  } else if (event.type === "result") {
    const details = calls.get(event.id);
    if (details === undefined) return;
    details.append(element("pre", "", event.output || "(no output)"));
    if (event.isError) details.classList.add("failed");
    details.classList.add("finished");
  } else if (event.type === "done") {
    log.append(element("li", "reply", event.reply));
  } else {
    log.append(element("li", "error", event.message));
  }
  log.lastElementChild?.scrollIntoView({ block: "end" });
}

taskForm.addEventListener("submit", (submit) => {
  submit.preventDefault();
  void runTask();
});

async function runTask(): Promise<void> {
  const text = task.value.trim();
  if (text === "") return;
  run.disabled = true;
  run.textContent = "Working…";
  log.append(element("li", "task", text));
  try {
    const response = await fetch(`${base()}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: text, stream: true }),
    });
    if (!response.ok || response.body === null) {
      show({ type: "error", message: `${response.status} ${await response.text()}` });
      return;
    }
    // Newline-delimited JSON: one event per line, as the agent works.
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += value;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") show(JSON.parse(line) as AgentEvent);
    }
  } catch (error) {
    show({ type: "error", message: String(error) });
  } finally {
    run.disabled = false;
    run.textContent = "Run";
  }
}

createTerminal($("terminal"), base);
