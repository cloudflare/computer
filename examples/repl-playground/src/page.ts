// Browser UI for repl-playground, served at "/" to Access-authenticated
// visitors. Same-origin fetches carry the Access cookie, so the injected JWT
// authorizes the API calls — no bearer token needed in the browser.
//
// All rendering uses textContent/DOM construction (no innerHTML with data),
// so cell code, logs, and capability values can't inject markup.
export const PLAYGROUND_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>repl-playground</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #101418; color: #d6dde4; max-width: 100rem; margin: 2rem auto; padding: 0 1rem; }
  #wrap { display: flex; gap: 1.4rem; align-items: flex-start; }
  #main { flex: 1; min-width: 0; }
  #side { width: 26rem; flex: none; position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow-y: auto; }
  #side h2 { font-size: .95rem; color: #7a8794; margin: .2rem 0 .6rem; }
  #side details { background: #151b21; border: 1px solid #232b33; border-radius: 6px; padding: .45rem .7rem; margin-bottom: .5rem; }
  #side summary { color: #d6dde4; font-weight: bold; font-size: .95em; }
  #side .desc { color: #9db2c4; font-size: .88em; margin: .35rem 0; }
  #side pre { font-size: .82em; overflow-x: auto; white-space: pre; }
  #side .example { margin-top: .3rem; }
  #side .example code { display: block; background: #1a2412; border: 1px solid #2c3a20; border-radius: 4px; padding: .35rem .5rem; font-size: .82em; color: #a9c98a; cursor: pointer; white-space: pre-wrap; word-break: break-word; }
  #side .example code:hover { background: #223016; }
  #side .example .try { color: #7a8794; font-size: .78em; }
  @media (max-width: 68rem) { #wrap { flex-direction: column; } #side { position: static; width: 100%; max-height: none; } }
  #about { background: #151b21; border: 1px solid #232b33; border-radius: 6px; padding: .5rem .9rem; margin: .8rem 0 1rem; }
  #about summary { cursor: pointer; color: #d6dde4; font-weight: bold; }
  #about p { color: #b6c2cd; font-size: 14px; margin: .6rem 0; max-width: 62rem; }
  #about b { color: #d6dde4; }
  #about code { background: #0b0e11; border: 1px solid #1d242c; border-radius: 3px; padding: 0 .3rem; }
  #about pre { max-width: 62rem; overflow-x: auto; white-space: pre; }
  #about pre code { background: none; border: none; padding: 0; }
  #about a { color: #86b9e8; }
  h1 { font-size: 1.1rem; } h1 span { color: #7a8794; font-weight: normal; }
  label { color: #7a8794; margin-right: .35rem; }
  input { background: #1a2027; color: inherit; border: 1px solid #2c353f; border-radius: 4px; padding: .25rem .5rem; width: 8rem; }
  textarea { width: 100%; min-height: 9rem; background: #1a2027; color: inherit; border: 1px solid #2c353f; border-radius: 4px; padding: .6rem; font: inherit; box-sizing: border-box; }
  button { background: #23303c; color: #d6dde4; border: 1px solid #33414e; border-radius: 4px; padding: .3rem .8rem; cursor: pointer; margin: .15rem .2rem .15rem 0; }
  button:hover { background: #2c3c4a; }
  #run { background: #2d5a3c; border-color: #3a7350; }
  .row { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin: .6rem 0; }
  .hint { color: #7a8794; font-size: .85em; }
  #out { margin-top: .8rem; }
  .card { background: #151b21; border: 1px solid #232b33; border-radius: 6px; padding: .7rem .9rem; margin-bottom: .7rem; }
  .card-head { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; margin-bottom: .4rem; }
  .badge { border-radius: 4px; padding: 0 .45rem; font-weight: bold; font-size: .85em; }
  .badge.ok { background: #1d3a28; color: #7fd89a; }
  .badge.err { background: #42201f; color: #f09a93; }
  .meta { color: #7a8794; font-size: .85em; }
  .chip { background: #23303c; color: #9db2c4; border-radius: 999px; padding: 0 .55rem; font-size: .8em; }
  .chip.kind { background: #4a3320; color: #e6b478; }
  .sect { color: #7a8794; font-size: .75em; text-transform: uppercase; letter-spacing: .08em; margin: .6rem 0 .2rem; }
  pre { background: #0b0e11; border: 1px solid #1d242c; border-radius: 4px; padding: .55rem .7rem; margin: .2rem 0; white-space: pre-wrap; word-break: break-word; }
  pre.plain { background: none; border: none; padding: .1rem 0; }
  .logline { display: flex; gap: .5rem; align-items: baseline; padding: .05rem 0; }
  .lvl { width: 3.2rem; flex: none; text-align: right; font-size: .8em; color: #7a8794; }
  .lvl.warn { color: #e6c078; } .lvl.error { color: #f09a93; } .lvl.info { color: #86b9e8; } .lvl.debug { color: #5c6873; }
  .errbox { border-left: 3px solid #b3554e; padding-left: .7rem; margin: .3rem 0; }
  .errbox .name { color: #f09a93; font-weight: bold; }
  .trace { color: #7a8794; font-size: .85em; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border-bottom: 1px solid #232b33; padding: .3rem .6rem; text-align: left; }
  th { color: #7a8794; font-weight: normal; font-size: .85em; }
  details { margin-top: .4rem; }
  summary { cursor: pointer; color: #7a8794; font-size: .85em; }
  .dim { color: #7a8794; }
</style>
</head>
<body>
<h1>repl-playground <span>— durable REPL sessions (@cloudflare/computer)</span></h1>
<details id="about">
  <summary>What is this? — the short version</summary>
  <p>An experimental JavaScript REPL for agents, built on <code>@cloudflare/computer</code>.
  Think long-lived code-mode: variables, functions and data carry over between calls, even after a restart.</p>
  <p>Instead of keeping a JavaScript process alive, we save the code that ran successfully and the
  results of its external calls. Each new call starts in a fresh isolate and replays that code to
  rebuild the session. API calls get their saved results back — we don't actually make those calls
  again during replay. Between calls, the session is just stored data.</p>
  <p>You choose what the code can access. Here's how you'd create a REPL in your Worker,
  using an existing workspace and your own CRM object:</p>
  <pre><code>import { capability } from "@cloudflare/computer";

const session = workspace.repl("main", {
  loader: env.LOADER,
  capabilities: { crm: capability(myCrm) },
});

await session.eval("const customers = await crm.customers.list()");
const result = await session.eval("customers.length");</code></pre>
  <p>It's the same broad record-and-replay idea as
  <a href="https://docs.temporal.io/workflows" target="_blank" rel="noreferrer">Temporal</a> or
  <a href="https://developers.cloudflare.com/workflows/" target="_blank" rel="noreferrer">Workflows</a>,
  but applied to code an agent adds as it goes.</p>
  <p>To try it here, run <code>help()</code> or pick a sidebar example. Then hit <b>restart</b>
  and reuse a variable — <b>counts</b> shows whether any new external calls happened.</p>
</details>
<div id="wrap">
<div id="main">
<div class="row">
  <span><label for="ws">workspace</label><input id="ws" value="default"></span>
  <span><label for="session">session</label><input id="session" value="main"></span>
</div>
<textarea id="code" spellcheck="false" placeholder="help()"></textarea>
<div class="row">
  <button id="run">Run (⌘⏎)</button>
  <button data-view="history">history</button>
  <button data-view="sessions">sessions</button>
  <button data-view="counts">counts</button>
  <button data-view="outbox">outbox</button>
  <button data-post="restart">restart</button>
  <button data-post="reset">reset</button>
  <span class="hint">restart = simulated eviction (state survives via replay); reset = wipe workspace</span>
</div>
<div id="out"><div class="dim">Try: help()</div></div>
</div>
<aside id="side">
  <h2>granted capabilities</h2>
  <div id="grants" class="dim">loading…</div>
</aside>
</div>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const ws = () => $("ws").value || "default";
const sess = () => $("session").value || "main";

function el(tag, cls, ...kids) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...kids);
  return node;
}
function pretty(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function show(...nodes) { const out = $("out"); out.replaceChildren(...nodes); }
function chips(items, cls) { return items.map((g) => el("span", cls || "chip", g)); }
function rawDetails(data) {
  return el("details", "", el("summary", "", "raw JSON"), el("pre", "", JSON.stringify(data, null, 2)));
}

// ── eval result ────────────────────────────────────────────────────────────
function renderEval(data) {
  const card = el("div", "card");
  card.append(el("div", "card-head",
    el("span", "badge " + (data.ok ? "ok" : "err"), data.ok ? "ok" : "error"),
    el("span", "meta", "cell " + data.executionCount + " · " + data.ms + "ms · session " + data.session + " · ws " + data.ws),
  ));
  if (data.error) {
    const box = el("div", "errbox", el("div", "", el("span", "name", data.error.name + ": "), data.error.message));
    if (data.error.kind) box.append(el("div", "", el("span", "chip kind", data.error.kind)));
    if (data.error.traceback) box.append(el("pre", "trace", data.error.traceback));
    card.append(el("div", "sect", "error"), box);
  }
  const entries = (data.logs && data.logs.entries) || [];
  if (entries.length > 0) {
    card.append(el("div", "sect", "console"));
    for (const entry of entries) {
      card.append(el("div", "logline", el("span", "lvl " + entry.level, entry.level), el("span", "", entry.text)));
    }
    if (data.logs.dropped) card.append(el("div", "dim", "… " + data.logs.dropped + " entries dropped"));
  }
  if (Array.isArray(data.results) && data.results.length > 0) {
    card.append(el("div", "sect", "results"));
    for (const entry of data.results) {
      card.append(el("pre", "", "value" in entry ? pretty(entry.value) : entry.text));
    }
  }
  if ("value" in data) {
    card.append(el("div", "sect", "value"));
    // Strings render raw (help() output etc.); everything else pretty JSON.
    card.append(el("pre", typeof data.value === "string" ? "plain" : "", pretty(data.value)));
  } else if (data.ok && (!data.results || data.results.length === 0)) {
    card.append(el("div", "sect", "value"), el("div", "dim", "undefined"));
  }
  card.append(rawDetails(data));
  show(card);
}

// ── history ────────────────────────────────────────────────────────────────
function renderHistory(data) {
  const cells = data.cells || [];
  if (cells.length === 0) {
    return show(el("div", "dim", "No committed cells in session \\"" + data.session + "\\" yet."));
  }
  const byCell = new Map();
  for (const effect of data.effects || []) {
    if (!byCell.has(effect.cell)) byCell.set(effect.cell, []);
    byCell.get(effect.cell).push(effect);
  }
  const header = el("div", "row",
    el("span", "meta", "session " + data.session + " · " + cells.length + " committed cells (failed evals are never committed)"));
  const nodes = [header];
  for (const cell of cells) {
    const card = el("div", "card");
    card.append(el("div", "card-head",
      el("span", "badge ok", "cell " + cell.seq),
      el("span", "meta", new Date(cell.at).toLocaleString()),
      ...chips(cell.grants || []),
    ));
    card.append(el("pre", "", cell.code));
    const effects = byCell.get(cell.seq) || [];
    if (effects.length > 0) {
      const detail = el("details", "", el("summary", "", effects.length + " recorded effect" + (effects.length === 1 ? "" : "s") + " (replayed from the log, never re-fired)"));
      for (const effect of effects) {
        detail.append(el("div", "logline", el("span", "lvl", "#" + effect.call), el("span", "chip", effect.kind), el("span", "dim", " " + effect.value)));
      }
      card.append(detail);
    }
    nodes.push(card);
  }
  nodes.push(rawDetails(data));
  show(...nodes);
}

// ── simple table views ─────────────────────────────────────────────────────
function renderTable(rows, columns) {
  const table = el("table", "");
  table.append(el("tr", "", ...columns.map((c) => el("th", "", c))));
  for (const row of rows) table.append(el("tr", "", ...row.map((v) => el("td", "", String(v)))));
  return table;
}
function renderSessions(data) {
  const rows = (data.sessions || []).map((s) => [s.session, s.cells, new Date(s.lastActivity).toLocaleString()]);
  show(rows.length === 0 ? el("div", "dim", "No sessions yet.") : el("div", "card", renderTable(rows, ["session", "cells", "last activity"])), rawDetails(data));
}
function renderCounts(data) {
  const rows = Object.entries(data.counts || {});
  show(el("div", "card",
    el("div", "meta", "live capability calls since last worker restart — replayed cells add nothing here"),
    renderTable(rows, ["counter", "count"])), rawDetails(data));
}
function renderOutbox(data) {
  const messages = data.outbox || [];
  if (messages.length === 0) return show(el("div", "dim", "Outbox is empty."));
  const nodes = messages.map((m, i) => {
    const card = el("div", "card");
    card.append(el("div", "card-head", el("span", "badge ok", "#" + (i + 1)), el("span", "", m.subject), el("span", "meta", "→ " + m.to + " · " + new Date(m.at).toLocaleString())));
    if (m.body) card.append(el("pre", "plain", m.body));
    return card;
  });
  show(...nodes, rawDetails(data));
}

// ── wiring ─────────────────────────────────────────────────────────────────
async function getJson(path) {
  const res = await fetch(path);
  return res.json();
}
async function run() {
  show(el("div", "dim", "running…"));
  const res = await fetch("/eval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ws: ws(), code: $("code").value, sessionName: sess() }),
  });
  renderEval(await res.json());
}
$("run").addEventListener("click", run);
$("code").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); });

const views = {
  history: async () => renderHistory(await getJson("/history?effects=1&session=" + encodeURIComponent(sess()) + "&ws=" + encodeURIComponent(ws()))),
  sessions: async () => renderSessions(await getJson("/sessions?ws=" + encodeURIComponent(ws()))),
  counts: async () => renderCounts(await getJson("/counts?ws=" + encodeURIComponent(ws()))),
  outbox: async () => renderOutbox(await getJson("/outbox?ws=" + encodeURIComponent(ws()))),
};
for (const button of document.querySelectorAll("button[data-view]")) {
  button.addEventListener("click", () => views[button.dataset.view]());
}
// ── grants sidebar ──────────────────────────────────────────────────────
async function loadGrants() {
  try {
    const data = await getJson("/grants");
    const container = $("grants");
    container.classList.remove("dim");
    container.replaceChildren(...data.grants.map((grant, i) => {
      const detail = el("details", "");
      if (i === 0) detail.open = true;
      const code = el("code", "", grant.example);
      code.title = "click to insert into the code box";
      code.addEventListener("click", () => {
        const box = $("code");
        box.value = box.value.trim() === "" ? grant.example : box.value + "\\n" + grant.example;
        box.focus();
      });
      detail.append(
        el("summary", "", grant.name),
        el("div", "desc", grant.description),
        el("pre", "", grant.decl),
        el("div", "example", el("div", "try", "try (click to insert):"), code),
      );
      return detail;
    }));
  } catch {
    $("grants").textContent = "failed to load grants";
  }
}
loadGrants();

for (const button of document.querySelectorAll("button[data-post]")) {
  button.addEventListener("click", async () => {
    if (button.dataset.post === "reset" && !confirm("Wipe this workspace — sessions, files, CRM, outbox?")) return;
    const res = await fetch("/" + button.dataset.post, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ws: ws() }),
    });
    show(el("div", "card", el("pre", "plain", JSON.stringify(await res.json()))));
  });
}
</script>
</body>
</html>`;
