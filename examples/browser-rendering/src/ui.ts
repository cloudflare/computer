export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Computer Browser</title>
  <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.2/src/regular/style.css">
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0b0d;
      --surface: #121418;
      --ink: #f7f5ef;
      --muted: #9b9da3;
      --line: rgba(255, 255, 255, 0.12);
      --orange: #f6821f;
      --green: #73d69b;
      --red: #ff7b7b;
      --blue: #8cc8ff;
      --radius: 12px;
    }

    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, input { font: inherit; color: inherit; }
    pre, code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; }

    body {
      margin: 0;
      color: var(--ink);
      background: var(--bg);
      font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
    }

    .shell { width: min(1100px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 64px; }
    nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 32px; }
    .brand { display: flex; gap: 10px; align-items: center; font-weight: 700; }
    .brand-mark { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 8px; color: #201308; background: var(--orange); }
    .stack-badge, .status-pill, .result-status { display: inline-flex; gap: 6px; align-items: center; padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; }
    h1 { margin: 0 0 8px; font-size: 40px; line-height: 1.05; letter-spacing: -0.03em; }
    .subtitle { max-width: 60ch; margin: 0 0 20px; color: var(--muted); }

    .app-grid { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(420px, 1.6fr); overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
    .controls { padding: 20px; border-right: 1px solid var(--line); }
    .output { min-width: 0; }
    .section-label { display: flex; gap: 6px; align-items: center; margin: 0 0 10px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .section-label i { color: var(--orange); font-size: 14px; }

    .url-field { position: relative; margin-bottom: 18px; }
    .url-field > i { position: absolute; top: 50%; left: 11px; color: var(--muted); transform: translateY(-50%); }
    input[type="url"] { width: 100%; padding: 11px 12px 11px 34px; border: 1px solid var(--line); border-radius: 10px; outline: none; background: rgba(0, 0, 0, .3); }
    input[type="url"]:focus { border-color: var(--orange); }

    .actions { display: grid; gap: 8px; margin-bottom: 18px; }
    .action { display: grid; grid-template-columns: 32px 1fr 16px; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; align-items: center; text-align: left; cursor: pointer; background: transparent; }
    .action[aria-pressed="true"] { border-color: var(--orange); background: rgba(246, 130, 31, .1); }
    .action-icon { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 8px; color: var(--orange); background: rgba(246, 130, 31, .12); font-size: 17px; }
    .action strong { display: block; font-size: 13px; }
    .action small { display: block; color: var(--muted); font-size: 11px; }
    .action > .ph-check-circle { color: var(--orange); opacity: 0; }
    .action[aria-pressed="true"] > .ph-check-circle { opacity: 1; }

    .run { display: flex; width: 100%; min-height: 42px; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 10px; color: #211306; cursor: pointer; background: var(--orange); font-weight: 700; }
    .run:disabled { cursor: wait; opacity: .7; }
    .run.loading i { animation: spin .9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .run-status { display: flex; min-height: 26px; margin-top: 10px; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
    .run-status.running i { color: var(--orange); }
    .run-status.done i { color: var(--green); }
    .run-status.error i { color: var(--red); }
    .runtime-stack { display: grid; gap: 6px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); }
    .runtime-stack div { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 11px; }
    .runtime-stack b { color: var(--ink); font-weight: 500; }

    .output-head { display: flex; min-height: 56px; padding: 0 18px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); }
    .output-head h2 { margin: 0; font-size: 14px; }
    .output-actions { display: flex; gap: 8px; }
    .icon-button { display: inline-grid; width: 32px; height: 32px; place-items: center; padding: 0; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); cursor: pointer; background: transparent; }
    .empty-state { display: grid; min-height: 320px; padding: 32px; place-items: center; color: var(--muted); text-align: center; }
    .empty-state i { display: block; margin-bottom: 10px; font-size: 34px; }
    .empty-state b { display: block; color: var(--ink); }

    .result { padding: 18px; }
    .result-summary { display: grid; grid-template-columns: 1fr auto; gap: 16px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
    .result-summary h3 { margin: 0 0 4px; font-size: 18px; }
    .result-summary a { color: var(--blue); font-size: 12px; word-break: break-all; text-decoration: none; }
    .result-status { align-self: start; color: var(--green); }
    .error-box { padding: 14px; border: 1px solid rgba(255, 123, 123, .35); border-radius: 10px; color: #ffd0d0; background: rgba(255, 123, 123, .08); }
    .error-box i { margin-right: 6px; }

    .research-result { display: grid; gap: 14px; }
    .research-intro { display: flex; gap: 10px; padding: 12px; border: 1px solid rgba(115, 214, 155, .25); border-radius: 10px; align-items: center; background: rgba(115, 214, 155, .07); }
    .research-intro > i { color: var(--green); font-size: 20px; }
    .research-intro strong { display: block; font-size: 13px; }
    .research-intro span { display: block; color: var(--muted); font-size: 11px; }
    .screenshot-result { overflow: hidden; border: 1px solid var(--line); border-radius: 10px; }
    .screenshot-result img { display: block; width: 100%; max-height: 420px; object-fit: contain; object-position: top; background: white; }
    .content-block { padding: 14px; border: 1px solid var(--line); border-radius: 10px; }
    .content-block h4 { margin: 0 0 8px; font-size: 12px; }
    .excerpt { max-height: 180px; margin: 0; overflow: auto; color: var(--muted); white-space: pre-wrap; font-size: 12px; }
    .item-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .item-list li { display: flex; gap: 8px; color: #d7d7d4; font-size: 12px; }
    .item-list i { color: var(--orange); }

    .workspace-visual { overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: rgba(0, 0, 0, .25); }
    .workspace-visual header { display: flex; min-height: 38px; padding: 0 12px; align-items: center; gap: 8px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11px; letter-spacing: .05em; text-transform: uppercase; }
    .workspace-visual header i { color: var(--orange); }
    .workspace-visual header span { margin-left: auto; letter-spacing: 0; text-transform: none; }
    .workspace-tree-shell { padding: 10px 12px; font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; }
    .tree-row, .tree-file { display: flex; min-height: 24px; align-items: center; gap: 7px; color: #cfd2d8; text-decoration: none; }
    .tree-row i, .tree-file > i { color: var(--orange); font-size: 13px; }
    .tree-indent { margin-left: 6px; padding-left: 16px; border-left: 1px solid var(--line); }
    .tree-run { color: var(--ink); }
    .workspace-tree { display: grid; padding-left: 16px; }
    .tree-file strong { font-weight: 500; }
    .tree-file small { margin-left: auto; color: #73767d; }
    .tree-file .ph-check-circle { margin-left: 4px; color: var(--green); }

    .artifact-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .artifact { display: grid; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); text-decoration: none; }
    .artifact i { margin-bottom: 8px; color: var(--orange); font-size: 18px; }
    .artifact strong { overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
    .artifact span { color: var(--muted); font-size: 10px; }

    .raw-result { margin-top: 14px; border-top: 1px solid var(--line); }
    .raw-result summary { padding-top: 12px; color: var(--muted); cursor: pointer; font-size: 12px; }
    .raw-result pre { max-height: 260px; overflow: auto; }

    .below-grid { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin-top: 16px; align-items: start; }
    .code-panel, .source-button { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
    .code-panel summary { display: flex; min-height: 46px; padding: 0 16px; align-items: center; gap: 8px; cursor: pointer; font-weight: 600; list-style: none; }
    .code-panel summary::-webkit-details-marker { display: none; }
    .code-panel summary .ph-caret-down { margin-left: auto; color: var(--muted); }
    .code-intro { margin: 0; padding: 0 16px 12px; color: var(--muted); font-size: 12px; }
    .code-label { padding: 0 16px 6px; color: var(--orange); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .code-panel pre { margin: 0; padding: 0 16px 16px; overflow: auto; }
    .source-button { display: flex; min-height: 46px; padding: 0 16px; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap; }
    .code-panel summary i, .source-button i { color: var(--orange); }

    dialog { width: min(820px, calc(100% - 32px)); max-height: calc(100vh - 64px); padding: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); color: var(--ink); background: var(--surface); }
    dialog::backdrop { background: rgba(0, 0, 0, .7); }
    .dialog-head { display: flex; min-height: 52px; padding: 0 16px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); }
    .dialog-head h2 { margin: 0; font-size: 14px; }
    dialog pre { max-height: calc(100vh - 140px); margin: 0; padding: 16px; overflow: auto; }

    @media (max-width: 860px) {
      .app-grid, .below-grid { grid-template-columns: 1fr; }
      .controls { border-right: 0; border-bottom: 1px solid var(--line); }
      .artifact-grid { grid-template-columns: 1fr; }
      h1 { font-size: 32px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <nav>
      <div class="brand"><span class="brand-mark"><i class="ph ph-cpu"></i></span>Cloudflare Computer</div>
      <span class="stack-badge"><i class="ph ph-browser"></i> Worker JavaScript + Browser Run</span>
    </nav>

    <header>
      <h1>Browser workspace</h1>
      <p class="subtitle">Run a real Puppeteer task, inspect the result, and keep generated files in one durable Computer workspace.</p>
    </header>

    <section class="app-grid">
      <form id="runner" class="controls">
        <p class="section-label"><i class="ph ph-globe-hemisphere-west"></i> Target</p>
        <div class="url-field">
          <i class="ph ph-link"></i>
          <input id="url" name="url" type="url" value="https://developers.cloudflare.com/agents/" autocomplete="url" spellcheck="false" required aria-label="Target URL">
        </div>

        <p class="section-label"><i class="ph ph-cursor-click"></i> Invocation</p>
        <div class="actions" role="group" aria-label="Invocation path">
          <button class="action" type="button" data-path="javascript" data-label="Run as a module" aria-pressed="true">
            <span class="action-icon"><i class="ph ph-brackets-curly"></i></span>
            <span><strong>JavaScript module</strong><small>withBrowser() in a Dynamic Worker</small></span>
            <i class="ph ph-check-circle"></i>
          </button>
          <button class="action" type="button" data-path="shell" data-label="Run as a command" aria-pressed="false">
            <span class="action-icon"><i class="ph ph-terminal-window"></i></span>
            <span><strong>Shell command</strong><small>browser puppeteer report.js</small></span>
            <i class="ph ph-check-circle"></i>
          </button>
        </div>

        <button id="run" class="run" type="submit"><i class="ph ph-play"></i><span>Run as a module</span></button>
        <div id="status" class="run-status"><i class="ph ph-circle"></i><span>Ready</span></div>

        <div class="runtime-stack" aria-label="Execution stack">
          <div><span>Task</span><b>/workspace/tasks/report.js</b></div>
          <div><span>JavaScript</span><b>Dynamic Worker</b></div>
          <div><span>Chromium</span><b>Browser Run</b></div>
          <div><span>Files</span><b>Durable Workspace</b></div>
        </div>
      </form>

      <section class="output" aria-live="polite">
        <header class="output-head">
          <h2>Result</h2>
          <div class="output-actions"><span id="runtime" class="status-pill">Not run</span></div>
        </header>

        <div id="empty" class="empty-state">
          <div><i class="ph ph-browser"></i><b>Ready to browse</b>Pick an invocation path and run it against the URL.</div>
        </div>

        <div id="result" class="result" hidden>
          <div id="error" class="error-box" hidden><i class="ph ph-warning-circle"></i><span></span></div>

          <div id="result-summary" class="result-summary" hidden>
            <div><h3 id="result-title"></h3><a id="result-url" target="_blank" rel="noreferrer"></a></div>
            <span id="result-status" class="result-status"></span>
          </div>

          <div id="research-result" class="research-result" hidden>
            <div class="research-intro"><i class="ph ph-check-circle"></i><div><strong id="path-summary">Durable research bundle created</strong><span id="path-detail">All three files were written by the shared task module.</span></div></div>
            <section class="content-block"><h4 id="invocation-title">Invocation</h4><pre class="excerpt"><code id="invocation"></code></pre></section>
            <div id="screenshot-result" class="screenshot-result">
              <img id="image" alt="Screenshot captured by Browser Run">
            </div>
            <section class="workspace-visual" aria-label="Durable Workspace files">
              <header><i class="ph ph-hard-drives"></i> Durable workspace <span>DOFS · persisted</span></header>
              <div class="workspace-tree-shell">
                <div class="tree-row"><i class="ph ph-folder-open"></i><strong>/workspace</strong></div>
                <div class="tree-indent">
                  <div class="tree-row"><i class="ph ph-folder-open"></i>browser-runs</div>
                  <div class="tree-indent">
                    <div class="tree-row tree-run"><i class="ph ph-folder-open"></i><span id="workspace-run">run</span></div>
                    <div id="workspace-tree" class="workspace-tree" role="tree"></div>
                  </div>
                </div>
              </div>
            </section>
            <div id="artifacts" class="artifact-grid"></div>
            <section class="content-block"><h4>Extracted summary</h4><div id="research-summary" class="excerpt"></div></section>
            <section class="content-block"><h4>Section map</h4><ul id="research-sections" class="item-list"></ul></section>
          </div>

          <details class="raw-result"><summary>Raw execution result</summary><pre><code id="json"></code></pre></details>
        </div>
      </section>
    </section>

    <section class="below-grid">
      <details class="code-panel" open>
        <summary><i class="ph ph-plugs-connected"></i> Plugin setup <i class="ph ph-caret-down"></i></summary>
        <p class="code-intro">The plugin and the command group are the whole integration. The task module, the report format, and this interface are example code.</p>
        <div class="code-label">Host Worker</div>
        <pre><code>import { puppeteer } from "@cloudflare/computer/plugins/puppeteer";
import browser from "@cloudflare/computer/shell/browser";

new Workspace({
  storage: ctx.storage,
  backends: [
    new WorkerJavaScriptBackend({
      loader: env.LOADER,
      plugins: [puppeteer({ browser: env.BROWSER })],
    }),
    new WorkerShellBackend({
      loader: env.LOADER,
      workspace: { binding: "BrowserWorkspace", id: ctx.id.toString() },
      ctx,
      commands: [browser],
    }),
  ],
});</code></pre>
        <div class="code-label">Task module, stored at /workspace/tasks/report.js</div>
        <pre><code>export default async ({ url, browser }) =&gt; {
  const page = await browser.newPage();
  await page.goto(url);
  return { title: await page.title() };
};</code></pre>
        <div class="code-label">Run it as a module</div>
        <pre><code>import { withBrowser } from "@cloudflare/puppeteer";
import report from "./report.js";

export default (input) =&gt;
  withBrowser((browser) =&gt; report({ ...input, browser }));</code></pre>
        <div class="code-label">Run the same module from the shell</div>
        <pre><code>browser puppeteer --url https://example.com/ report.js</code></pre>
      </details>
      <button id="show-source" class="source-button" type="button"><i class="ph ph-code"></i> Full example task source</button>
    </section>
  </main>

  <dialog id="source-dialog">
    <header class="dialog-head"><h2>Full example task source</h2><button id="close-source" class="icon-button" type="button" aria-label="Close"><i class="ph ph-x"></i></button></header>
    <pre><code id="source">Loading…</code></pre>
  </dialog>

  <script type="module">
    const byId = (id) => document.getElementById(id);
    const runner = byId("runner");
    const urlInput = byId("url");
    const runButton = byId("run");
    const status = byId("status");
    const runtime = byId("runtime");
    const empty = byId("empty");
    const result = byId("result");
    const errorBox = byId("error");
    const summary = byId("result-summary");
    const title = byId("result-title");
    const resultUrl = byId("result-url");
    const resultStatus = byId("result-status");
    const image = byId("image");
    const researchResult = byId("research-result");
    const pathSummary = byId("path-summary");
    const pathDetail = byId("path-detail");
    const invocationTitle = byId("invocation-title");
    const invocation = byId("invocation");
    const workspaceRun = byId("workspace-run");
    const workspaceTree = byId("workspace-tree");
    const artifacts = byId("artifacts");
    const researchSummary = byId("research-summary");
    const researchSections = byId("research-sections");
    const json = byId("json");
    const sourceDialog = byId("source-dialog");
    const source = byId("source");
    const pathButtons = Array.from(document.querySelectorAll(".action"));
    let path = "javascript";
    let sourceLoaded = false;

    function selectPath(button) {
      path = button.dataset.path;
      for (const candidate of pathButtons) {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      }
      runButton.lastElementChild.textContent = button.dataset.label;
    }

    for (const button of pathButtons) {
      button.addEventListener("click", () => selectPath(button));
    }

    function setRunStatus(state, icon, text) {
      status.className = "run-status " + state;
      status.firstElementChild.className = "ph " + icon;
      status.lastElementChild.textContent = text;
    }

    function showResult(visible) {
      researchResult.hidden = !visible;
    }

    function renderSummary(value) {
      title.textContent = value.title || "Untitled page";
      resultUrl.textContent = value.finalUrl || value.requestedUrl || "";
      resultUrl.href = value.finalUrl || value.requestedUrl || "#";
      resultStatus.textContent = value.status == null ? "No response" : "HTTP " + value.status;
      summary.hidden = false;
    }


    function appendListItem(list, icon, text, href) {
      const item = document.createElement("li");
      const glyph = document.createElement("i");
      glyph.className = "ph " + icon;
      const content = href ? document.createElement("a") : document.createElement("span");
      content.textContent = text;
      if (href) {
        content.href = href;
        content.target = "_blank";
        content.rel = "noreferrer";
      }
      item.append(glyph, content);
      list.append(item);
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
    }

    function renderRun(value, payload) {
      showResult(true);
      const shell = payload.path === "shell";
      pathSummary.textContent = shell
        ? "Ran the task from the shell"
        : "Ran the task as a JavaScript module";
      pathDetail.textContent = shell
        ? "The browser command wrapped report.js and dispatched it to the JavaScript backend."
        : "withBrowser() opened the session and report.js wrote the files.";
      invocationTitle.textContent = shell ? "Shell command" : "Executed module";
      invocation.textContent = payload.invocation;
      image.src = value.screenshotPath
        ? "/api/file?path=" + encodeURIComponent(value.screenshotPath) + "&v=" + Date.now()
        : "";
      artifacts.replaceChildren();
      workspaceTree.replaceChildren();
      researchSections.replaceChildren();
      researchSummary.textContent = value.summary || value.description || "No summary returned.";
      const files = value.files || [];
      const directory = files[0]?.path.slice(0, files[0].path.lastIndexOf("/")) || "";
      workspaceRun.textContent = directory.slice(directory.lastIndexOf("/") + 1) || "run";
      for (const file of files) {
        const href = "/api/file?path=" + encodeURIComponent(file.path);
        const fileIcon = file.name.endsWith(".png") ? "ph-image" : file.name.endsWith(".json") ? "ph-brackets-curly" : "ph-file-md";
        const treeLink = document.createElement("a");
        treeLink.className = "tree-file";
        treeLink.href = href;
        treeLink.target = "_blank";
        treeLink.rel = "noreferrer";
        treeLink.setAttribute("role", "treeitem");
        const treeIcon = document.createElement("i");
        treeIcon.className = "ph " + fileIcon;
        const treeName = document.createElement("strong");
        treeName.textContent = file.name;
        const treeSize = document.createElement("small");
        treeSize.textContent = formatBytes(file.bytes);
        const persisted = document.createElement("i");
        persisted.className = "ph ph-check-circle";
        persisted.setAttribute("aria-label", "Persisted");
        treeLink.append(treeIcon, treeName, treeSize, persisted);
        workspaceTree.append(treeLink);

        const link = document.createElement("a");
        link.className = "artifact";
        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer";
        const icon = document.createElement("i");
        icon.className = "ph " + fileIcon;
        const name = document.createElement("strong");
        name.textContent = file.name;
        const size = document.createElement("span");
        size.textContent = formatBytes(file.bytes);
        link.append(icon, name, size);
        artifacts.append(link);
      }
      for (const section of value.sections || []) {
        appendListItem(researchSections, "ph-text-h", section.level.toUpperCase() + " · " + section.text);
      }
    }

    function renderValue(payload) {
      errorBox.hidden = true;
      renderSummary(payload.value);
      renderRun(payload.value, payload);
      json.textContent = JSON.stringify(payload.value, null, 2);
    }

    function renderError(error) {
      showResult(false);
      summary.hidden = true;
      errorBox.hidden = false;
      errorBox.lastElementChild.textContent = error instanceof Error ? error.message : String(error);
      json.textContent = JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2);
    }

    runner.addEventListener("submit", async (event) => {
      event.preventDefault();
      const target = urlInput.value.trim();
      if (!urlInput.reportValidity()) return;
      const submittedPath = path;
      runButton.disabled = true;
      runButton.classList.add("loading");
      runButton.firstElementChild.className = "ph ph-spinner-gap";
      setRunStatus("running", "ph-spinner-gap", "Launching Browser Run…");
      runtime.textContent = "Running";
      empty.hidden = true;
      result.hidden = false;
      errorBox.hidden = true;
      summary.hidden = true;
      showResult(false);
      const started = performance.now();

      try {
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: submittedPath, url: target }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Browser execution failed");
        // Render against the path the request was sent with, not the
        // one selected now, so switching mid-run cannot mislabel it.
        renderValue({ ...payload, path: submittedPath });
        runtime.textContent = Math.round(performance.now() - started) + " ms · exit " + payload.exitCode;
        setRunStatus("done", "ph-check-circle", "Completed in an isolated Worker");
      } catch (error) {
        renderError(error);
        runtime.textContent = "Failed";
        setRunStatus("error", "ph-warning-circle", "Execution failed");
      } finally {
        runButton.disabled = false;
        runButton.classList.remove("loading");
        runButton.firstElementChild.className = "ph ph-play";
      }
    });

    byId("show-source").addEventListener("click", async () => {
      sourceDialog.showModal();
      if (sourceLoaded) return;
      try {
        const response = await fetch("/api/source");
        source.textContent = await response.text();
        sourceLoaded = true;
      } catch {
        source.textContent = "The execution source could not be loaded.";
      }
    });

    byId("close-source").addEventListener("click", () => sourceDialog.close());
    sourceDialog.addEventListener("click", (event) => {
      if (event.target === sourceDialog) sourceDialog.close();
    });
  </script>
</body>
</html>`;
