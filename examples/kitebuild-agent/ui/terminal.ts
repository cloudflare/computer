// The page's terminal: xterm.js in front of POST /c/<name>/exec. Each
// command runs to the end on the Kitebuild machine, with its output
// streamed as it is written; Ctrl-C stops it. There is no input while a
// command runs, so programs that read the keyboard, such as vi, don't
// work here. `cd <dir>` on its own changes the directory commands run in.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type ExecEvent = { type: "stdout" | "stderr"; data: string } | { type: "exit"; code: number };

export function createTerminal(element: HTMLElement, base: () => string): void {
  const term = new Terminal({ convertEol: true, fontSize: 13, theme: { background: "#1d1d1b" } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(element);
  new ResizeObserver(() => fit.fit()).observe(element);

  let cwd = "/workspace";
  let line = "";
  let running: AbortController | undefined;
  let runningId = "";
  const prompt = () => term.write(`\x1b[32m${cwd}\x1b[0m $ `);

  // Runs a command and writes its output as it arrives. Returns its stdout.
  async function exec(command: string, show: boolean): Promise<string> {
    running = new AbortController();
    runningId = crypto.randomUUID();
    let stdout = "";
    try {
      const response = await fetch(`${base()}/exec`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command,
          cwd,
          id: runningId,
          stream: true,
          env: { FORCE_COLOR: "1" },
        }),
        signal: running.signal,
      });
      // An error reply is plain text or JSON, not the event stream.
      if (!response.ok || response.body === null) {
        term.write(`\x1b[31m${response.status}: ${await response.text()}\x1b[0m\n`);
        return "";
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = "";
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        const lines = (buffered + read.value).split("\n");
        buffered = lines.pop() ?? "";
        for (const text of lines) {
          const event = JSON.parse(text) as ExecEvent;
          if (event.type === "exit") {
            if (event.code !== 0) term.write(`\x1b[2m[exit ${event.code}]\x1b[0m\n`);
          } else {
            if (event.type === "stdout") stdout += event.data;
            if (show || event.type === "stderr") term.write(event.data);
          }
        }
      }
    } catch (error) {
      if (!running.signal.aborted) term.write(`${String(error)}\n`);
    } finally {
      running = undefined;
    }
    return stdout;
  }

  async function submit(command: string): Promise<void> {
    const cd = command.match(/^cd(?:\s+(\S+))?$/);
    if (cd) {
      const dir = (await exec(`cd ${cd[1] ?? "/workspace"} && pwd`, false)).trim();
      if (dir) cwd = dir;
    } else if (command) {
      await exec(command, true);
    }
    if (term.buffer.active.cursorX !== 0) term.write("\n");
    prompt();
  }

  term.onData((data) => {
    if (data === "\x03") {
      if (running) {
        // Stop the command on the machine, then stop reading its output.
        void fetch(`${base()}/kill`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: runningId }),
        });
        running.abort();
      }
      term.write("^C\n");
      if (!running) {
        line = "";
        prompt();
      }
    } else if (running) {
      // No input while a command runs.
    } else if (data === "\r") {
      term.write("\n");
      void submit(line.trim());
      line = "";
    } else if (data === "\x7f") {
      if (line === "") return;
      line = line.slice(0, -1);
      term.write("\b \b");
    } else if (!data.startsWith("\x1b")) {
      const text = [...data].filter((char) => char >= " ").join("");
      line += text;
      term.write(text);
    }
  });

  prompt();
  term.focus();
}
