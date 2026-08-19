import { useState } from "react";
import { createRoot } from "react-dom/client";

interface RunResult {
  packageVersion: string;
  image: string;
  ok: boolean;
  elapsedMs: number;
  result?: unknown;
  error?: string;
}

function App() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const add = (message: string) =>
    setLog((lines) => [...lines, `${new Date().toISOString()} ${message}`]);

  async function trigger() {
    setRunning(true);
    add("trigger: calling getWorkspace() then runtime.exec(); this can take ~60s when the bug reproduces");
    try {
      const response = await fetch(`/api/run?fresh=${crypto.randomUUID()}`);
      const body = (await response.json()) as RunResult;
      add(`HTTP ${response.status}: ${JSON.stringify(body)}`);
      add(body.ok ? "PASS: workspace transport connected and exec completed" : "BUG: workspace transport never connected");
    } catch (error) {
      add(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main style={{ fontFamily: "monospace", padding: 16, maxWidth: 1000 }}>
      <h1>#114: release-branch deployed Container dial-back probe</h1>
      <p>
        Expected: <code>getWorkspace()</code> connects and <code>runtime.exec()</code> prints
        <code> transport-ok</code>. This uses the release-branch 0.3.0 package and its renamed
        <code> /api</code> WebSocket endpoint.
      </p>
      <button disabled={running} onClick={trigger}>
        {running ? "Waiting for deployed Container…" : "Trigger bug"}
      </button>
      <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
