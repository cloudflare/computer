import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";

function App() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState("Not run yet");
  const add = (message: string) =>
    setLog((current) => [...current, `${new Date().toISOString()} ${message}`]);

  useAgent({
    agent: "repro-agent",
    name: "demo",
    onOpen: () => add("WebSocket connected"),
    onClose: () => add("WebSocket closed"),
    onMessage: (event) => add(`WebSocket message: ${event.data}`),
  });

  const trigger = async () => {
    setRunning(true);
    setLog([]);
    setVerdict("Running...");
    add("Triggering root-directory git init/add/commit flow on a fresh DO...");
    try {
      const instance = `run-${crypto.randomUUID()}`;
      const response = await fetch(`/agents/repro-agent/${instance}/run`, { method: "POST" });
      const text = await response.text();
      add(`HTTP ${response.status}`);
      try {
        const result = JSON.parse(text) as {
          afterInit?: { head?: { ok?: boolean } };
          commit?: { ok?: boolean };
          [key: string]: unknown;
        };
        const observedBug = result.afterInit?.head?.ok === false || result.commit?.ok === false;
        setVerdict(
          observedBug
            ? "BUG REPRODUCED: HEAD is missing or commit failed"
            : "BUG NOT OBSERVED: HEAD persisted and commit succeeded",
        );
        for (const [key, value] of Object.entries(result)) {
          add(`${key}: ${JSON.stringify(value)}`);
        }
      } catch {
        setVerdict(`Unexpected HTTP ${response.status} response`);
        add(text);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVerdict(`Request failed: ${message}`);
      add(`fetch failed: ${message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <main style={{ fontFamily: "monospace", padding: 16, maxWidth: 1000 }}>
      <h1>cloudflare/computer #133 minimal reproduction</h1>
      <p>
        Expected: <code>git.init()</code> creates <code>.git/HEAD</code>, then a first
        commit succeeds. Reported bug: init resolves but HEAD is absent and commit throws a
        <code>startsWith</code> TypeError.
      </p>
      <p><strong>Status: {verdict}</strong></p>
      <button disabled={running} onClick={trigger}>
        {running ? "Running..." : "Trigger bug"}
      </button>
      <pre style={{ whiteSpace: "pre-wrap", border: "1px solid #aaa", padding: 12 }}>
        {log.length ? log.join("\n") : "Press Trigger bug to run against the DO-backed workspace."}
      </pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
