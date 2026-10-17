/**
 * The page `machine ui` serves: one self-contained document, with no outside
 * scripts, styles, or fonts, so it works offline and loads nothing but its own
 * data. The token lets only this page answer a run.
 */
export function runUiPage(token: string): string {
  return page.replace("__MACHINES_UI_TOKEN__", token);
}

// The page script avoids template literals so that it can sit inside this one.
const page = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Machines</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --panel-2: #f0f2f5; --ink: #16181d; --muted: #646b78; --faint: #9aa1ad;
  --line: #e1e4ea; --edge: #c3c8d2; --accent: #4f5bd5; --accent-soft: rgba(79, 91, 213, 0.12);
  --agent: #7c4dcc; --human: #c77700; --operation: #1f7a99; --final: #2f8f4e; --group: #8a8f99;
  --succeeded: #2f8f4e; --cancelled: #887135;
  --running: #2f6fdb; --waiting: #c77700; --sleeping: #657aaa; --completed: #2f8f4e; --failed: #cc3a3a; --lost: #8a8f99;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.08);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1e222b; --ink: #e8eaef; --muted: #9aa1ad; --faint: #6b7280;
    --line: #2a2f3a; --edge: #3d4452; --accent: #8b94ff; --accent-soft: rgba(139, 148, 255, 0.16);
    --agent: #b18cff; --human: #f0a531; --operation: #4fb3d4; --final: #5cc282; --group: #8a8f99;
    --succeeded: #5cc282; --cancelled: #d4b765;
    --running: #6c9dff; --waiting: #f0a531; --sleeping: #94a8d4; --completed: #5cc282; --failed: #ff6b6b; --lost: #8a8f99;
    --shadow: none;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--ink); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
button { font: inherit; color: inherit; }
.top { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5; }
.brand { font-weight: 650; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.brand .logo { color: var(--accent); }
.brand .project { color: var(--muted); font-weight: 500; }
.counts { display: flex; gap: 8px; flex-wrap: wrap; flex: 1; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; background: var(--panel-2); color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.chip b { color: var(--ink); font-weight: 600; }
.live { font-size: 12.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.live::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--faint); }
.live.on::before { background: var(--completed); box-shadow: 0 0 0 3px rgba(47, 143, 78, 0.18); }
.layout { display: grid; grid-template-columns: 300px minmax(0, 1fr) 340px; gap: 16px; padding: 16px; align-items: start; }
@media (max-width: 1250px) { .layout { grid-template-columns: 280px minmax(0, 1fr); } .panels { grid-column: 1 / -1; } }
@media (max-width: 780px) { .layout { grid-template-columns: minmax(0, 1fr); padding: 12px 16px; } .top { flex-wrap: wrap; } }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
.runs { display: flex; flex-direction: column; gap: 14px; position: sticky; top: 64px; max-height: calc(100vh - 80px); overflow: auto; }
@media (max-width: 780px) { .runs { position: static; max-height: none; } }
.section-title { font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin: 0 4px 6px; display: flex; justify-content: space-between; }
.run { width: 100%; text-align: left; border: 1px solid var(--line); background: var(--panel); border-radius: 10px; padding: 9px 11px; cursor: pointer; display: grid; grid-template-columns: 10px minmax(0, 1fr); gap: 4px 9px; margin-bottom: 6px; box-shadow: var(--shadow); }
.run:hover { border-color: var(--edge); }
.run.selected { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.run .dot { margin-top: 6px; }
.run .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run .sub { grid-column: 2; color: var(--muted); font-size: 12.5px; display: flex; gap: 6px; flex-wrap: wrap; }
.run .child { grid-column: 2; font-size: 12px; color: var(--faint); }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; background: var(--lost); }
.dot.running { background: var(--running); box-shadow: 0 0 0 3px rgba(47, 111, 219, 0.18); }
.dot.waiting { background: var(--waiting); animation: pulse 1.6s ease-in-out infinite; }
.dot.sleeping { background: var(--sleeping); }
.dot.completed { background: var(--completed); }
.dot.failed { background: var(--failed); }
.dot.ok { background: var(--completed); } .dot.warn { background: var(--waiting); } .dot.bad { background: var(--failed); } .dot.active { background: var(--running); } .dot.idle { background: var(--faint); }
@keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(199, 119, 0, 0.18); } }
.empty { color: var(--muted); padding: 18px; text-align: center; font-size: 13px; }
.detail { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.head { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.head h1 { font-size: 18px; margin: 0; line-height: 1.3; overflow-wrap: anywhere; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; background: var(--panel-2); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--muted); font-size: 12.5px; }
.meta b { color: var(--ink); font-weight: 600; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.banner { padding: 10px 14px; border-radius: 10px; font-size: 13px; }
.banner.limit { background: rgba(199, 119, 0, 0.1); border: 1px solid rgba(199, 119, 0, 0.35); }
.banner.sleeping { background: var(--panel-2); border: 1px solid var(--line); }
.banner.error { background: rgba(204, 58, 58, 0.08); border: 1px solid rgba(204, 58, 58, 0.35); white-space: pre-wrap; overflow-wrap: anywhere; }
.ask { padding: 14px 16px; border-color: var(--waiting); box-shadow: 0 0 0 3px rgba(199, 119, 0, 0.12); display: flex; flex-direction: column; gap: 10px; }
.ask h2, .block h2 { font-size: 13px; margin: 0; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.prompt { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; background: var(--panel-2); border-radius: 8px; padding: 10px 12px; font-size: 13.5px; }
.choices { display: flex; flex-wrap: wrap; gap: 8px; }
.btn { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
.btn:hover { border-color: var(--accent); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn:disabled { opacity: 0.5; cursor: default; }
textarea { width: 100%; min-height: 70px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--panel); color: var(--ink); font: inherit; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.hint { color: var(--muted); font-size: 12.5px; }
.block { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.graph-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.tools { display: flex; gap: 6px; }
.tools .btn { padding: 2px 9px; }
.graph { position: relative; height: clamp(420px, calc(100vh - 250px), 760px); border-radius: 10px; background: var(--panel-2); overflow: hidden; touch-action: none; cursor: grab; }
.graph.dragging { cursor: grabbing; }
.graph.none { height: auto; cursor: default; }
.graph svg { width: 100%; height: 100%; display: block; }
.node rect.base { fill: var(--panel); }
.node rect.box { fill: var(--panel); stroke: var(--line); stroke-width: 1.2; }
.node.visited rect.box { fill: var(--accent-soft); }
.node.current rect.box { stroke: var(--accent); stroke-width: 2.6; }
.node.current.failed rect.box { stroke: var(--failed); }
.node.current.waiting rect.box { stroke: var(--waiting); }
.node.current.completed rect.box { stroke: var(--completed); }
.node .halo { fill: none; stroke: var(--accent); stroke-width: 6; opacity: 0.25; animation: halo 1.8s ease-in-out infinite; }
@keyframes halo { 50% { opacity: 0.05; } }
.node text { fill: var(--ink); font-size: 12.5px; font-weight: 600; }
.node text.kind { fill: var(--muted); font-size: 10.5px; font-weight: 500; }
.node .badge { fill: var(--accent); }
.node text.count { fill: #fff; font-size: 10px; font-weight: 700; }
.node.unreached { opacity: 0.55; }
.edge path { fill: none; stroke: var(--edge); stroke-width: 1.3; }
.edge.terminal path { stroke-dasharray: 3 4; opacity: 0.7; }
.edge.visited path { stroke: var(--accent); stroke-width: 2.4; opacity: 1; stroke-dasharray: none; }
.edge.next path { stroke: var(--accent); stroke-dasharray: 5 5; animation: dash 1s linear infinite; opacity: 1; }
@keyframes dash { to { stroke-dashoffset: -20; } }
.edge text { font-size: 10.5px; fill: var(--muted); paint-order: stroke; stroke: var(--panel-2); stroke-width: 4px; stroke-linejoin: round; }
.edge.visited text, .edge.next text { fill: var(--accent); font-weight: 600; }
.edge:hover path { stroke: var(--ink); }
.trail { display: flex; flex-direction: column; max-height: 320px; overflow: auto; }
.step { display: grid; grid-template-columns: 82px 1fr auto; gap: 10px; padding: 5px 2px; border-bottom: 1px dashed var(--line); font-size: 13px; align-items: baseline; }
.step:last-child { border-bottom: 0; }
.step .t { color: var(--faint); font-size: 12px; }
.step .d { color: var(--muted); font-size: 12px; }
.step.now .s { color: var(--accent); font-weight: 650; }
.note { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.panels { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
@media (max-width: 1250px) { .panels { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); align-items: start; } }
.panel { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.panel h3 { margin: 0; font-size: 13.5px; display: flex; justify-content: space-between; gap: 8px; }
.panel h3 span { color: var(--faint); font-weight: 500; font-size: 12px; }
.panel .summary { color: var(--muted); font-size: 12.5px; }
.items { display: flex; flex-direction: column; gap: 2px; }
.item { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 2px 8px; padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.item:last-child { border-bottom: 0; }
.item .dot { margin-top: 6px; }
.item .text { overflow-wrap: anywhere; }
.item .text a { color: inherit; text-decoration: none; border-bottom: 1px solid var(--edge); }
.item .text a:hover { color: var(--accent); border-color: var(--accent); }
.item .detail { grid-column: 2 / 4; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.item .detail:hover { -webkit-line-clamp: unset; }
.items { max-height: 420px; overflow: auto; }
.item .at { color: var(--faint); font-size: 12px; white-space: nowrap; }
.panel .error { color: var(--failed); font-size: 12.5px; overflow-wrap: anywhere; }
.subruns { display: flex; flex-direction: column; gap: 4px; }
.subrun { display: flex; gap: 8px; align-items: center; font-size: 13px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
.subrun:hover { background: var(--panel-2); }
</style>
</head>
<body>
<header class="top">
  <div class="brand"><span class="logo">&#9670;</span> Machines <span class="project" id="project"></span></div>
  <div class="counts" id="counts"></div>
  <div class="live" id="live">connecting</div>
</header>
<div class="layout">
  <aside class="runs" id="runs"></aside>
  <main class="detail" id="detail"></main>
  <section class="panels" id="panels"></section>
</div>
<script>
"use strict";
var TOKEN = "__MACHINES_UI_TOKEN__";
var data = null;
var selected = decodeURIComponent(location.hash.slice(1)) || null;
var views = {};
var layouts = {};
var drafts = {};
var sending = false;

function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) for (var key in attrs) {
    var value = attrs[key];
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") el.textContent = value;
    else if (key === "class") el.className = value;
    else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
  return el;
}
function append(el, child) {
  if (child === undefined || child === null || child === false) return;
  if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
  el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
}
function s(tag, attrs) {
  var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  if (attrs) for (var key in attrs) {
    if (attrs[key] === undefined || attrs[key] === null) continue;
    if (key === "text") el.textContent = attrs[key]; else if (key === "class") el.setAttribute("class", attrs[key]); else el.setAttribute(key, attrs[key]);
  }
  for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.appendChild(arguments[i]);
  return el;
}

function duration(ms) {
  if (!(ms >= 0)) return "";
  var sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + "s";
  var min = Math.floor(sec / 60);
  if (min < 60) return min + "m " + String(sec % 60).padStart(2, "0") + "s";
  var hr = Math.floor(min / 60);
  if (hr < 48) return hr + "h " + String(min % 60).padStart(2, "0") + "m";
  return Math.floor(hr / 24) + "d";
}
function ago(iso) { var t = Date.parse(iso); return isNaN(t) ? "" : duration(Date.now() - t) + " ago"; }
function clock(iso) { var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function live(iso, suffix) { return h("span", { "data-since": iso, "data-suffix": suffix || "", text: duration(Date.now() - Date.parse(iso)) + (suffix || "") }); }
function active(run) { return run.status === "running" || run.status === "waiting"; }
function sleepingForAnswer(run) { return run.status === "sleeping" && !run.due && run.human && run.human.requestId; }
function needsAnswer(run) { return run.status === "waiting" || (sleepingForAnswer(run) && run.human.answer === undefined); }
function wakesWith(run) { return run.continuedBy === "host" ? "when its host continues it" : "with machine continue " + run.id; }
function sleepNote(run) {
  if (run.status !== "sleeping") return "";
  if (run.due) return "due " + clock(run.due) + (Date.now() >= Date.parse(run.due) ? " (due now)" : "");
  return sleepingForAnswer(run) && run.human.answer !== undefined ? "answered" : "input needed";
}
function title(run) { return run.label || run.machine; }

function paths(value) {
  if (typeof value !== "string" || value === "") return [];
  if (value.charAt(0) !== "{") return [value];
  try { return flatten(JSON.parse(value)); } catch (e) { return [value]; }
}
function flatten(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  var out = [];
  Object.keys(value).forEach(function (key) {
    var below = flatten(value[key]);
    if (below.length === 0) out.push(key); else below.forEach(function (p) { out.push(key + "." + p); });
  });
  return out;
}
function stateText(run) { return paths(run.state).join(", "); }

function connect() {
  var source = new EventSource("/api/events");
  var liveEl = document.getElementById("live");
  source.onopen = function () { liveEl.textContent = "live"; liveEl.className = "live on"; };
  source.onerror = function () { liveEl.textContent = "reconnecting"; liveEl.className = "live"; };
  source.onmessage = function (event) { data = JSON.parse(event.data); render(); };
}

function render() {
  if (!data) return;
  document.getElementById("project").textContent = data.project.name;
  document.title = "Machines · " + data.project.name;
  var runs = data.runs;
  var byId = {};
  runs.forEach(function (r) { byId[r.id] = r; });
  if (!selected || !byId[selected]) {
    var pick = runs.filter(function (r) { return !r.parent || !byId[r.parent]; });
    var first = pick.find(needsAnswer) || pick.find(function (r) { return r.status === "running"; }) || pick[0];
    selected = first ? first.id : null;
  }
  // Sub-runs are counted with the run that started them.
  renderCounts(runs.filter(function (r) { return !r.parent || !byId[r.parent]; }));
  renderRuns(runs, byId);
  renderDetail(selected ? byId[selected] : null, runs, byId);
  renderPanels(data.panels);
}

function renderCounts(runs) {
  var count = function (status) { return runs.filter(function (r) { return r.status === status; }).length; };
  var day = Date.now() - 24 * 3600 * 1000;
  var failed = runs.filter(function (r) { return r.status === "failed" && Date.parse(r.updatedAt) > day; }).length;
  var el = document.getElementById("counts");
  el.replaceChildren.apply(el, [
    h("span", { class: "chip" }, h("span", { class: "dot running" }), h("b", { text: String(count("running")) }), "running"),
    h("span", { class: "chip" }, h("span", { class: "dot waiting" }), h("b", { text: String(runs.filter(needsAnswer).length) }), "waiting on you"),
    count("sleeping") ? h("span", { class: "chip" }, h("span", { class: "dot sleeping" }), h("b", { text: String(count("sleeping")) }), "sleeping") : null,
    failed ? h("span", { class: "chip" }, h("span", { class: "dot failed" }), h("b", { text: String(failed) }), "failed today") : null,
    count("lost") ? h("span", { class: "chip" }, h("span", { class: "dot" }), h("b", { text: String(count("lost")) }), "lost") : null
  ].filter(Boolean));
}

function renderRuns(runs, byId) {
  var top = runs.filter(function (r) { return !r.parent || !byId[r.parent]; });
  var children = {};
  runs.forEach(function (r) { if (r.parent && byId[r.parent]) (children[r.parent] = children[r.parent] || []).push(r); });
  var groups = [
    ["Waiting on you", top.filter(needsAnswer)],
    ["Running", top.filter(function (r) { return r.status === "running"; })],
    ["Sleeping", top.filter(function (r) { return r.status === "sleeping" && !needsAnswer(r); })],
    ["Lost", top.filter(function (r) { return r.status === "lost"; })],
    ["Finished", top.filter(function (r) { return r.status === "completed" || r.status === "failed"; })],
  ];
  var el = document.getElementById("runs");
  var sections = groups.filter(function (g) { return g[1].length; }).map(function (g) {
    return h("div", null, h("div", { class: "section-title" }, h("span", { text: g[0] }), h("span", { text: String(g[1].length) })),
      g[1].map(function (r) { return runCard(r, children[r.id] || []); }));
  });
  if (sections.length === 0) sections = [h("div", { class: "card empty" }, "No published runs yet. Runs started by machine run, Dispatch, MCP, or Pi appear here as they start.", h("div", { class: "mono", text: data.directory }))];
  el.replaceChildren.apply(el, sections);
}

function runCard(run, kids) {
  var running = kids.filter(active);
  return h("button", { class: "run" + (run.id === selected ? " selected" : ""), onclick: function () { select(run.id); } },
    h("span", { class: "dot " + (needsAnswer(run) ? "waiting" : run.status) }),
    h("span", { class: "title", title: title(run), text: title(run) }),
    h("span", { class: "sub" }, [run.label ? run.machine : null, stateText(run) || null].filter(Boolean).concat([""]).join(" · "),
      run.status === "sleeping" ? h("span", { text: sleepNote(run) }) : active(run) ? live(run.startedAt) : h("span", { text: ago(run.updatedAt) })),
    sleepingForAnswer(run) ? h("span", { class: "child", text: run.human.prompt + " · request: " + run.human.requestId }) : null,
    kids.length ? h("span", { class: "child", text: kids.length + " sub-run" + (kids.length > 1 ? "s" : "") + (running.length ? ", " + running.length + " active" : "") }) : null);
}

function select(id) {
  selected = id;
  history.replaceState(null, "", "#" + encodeURIComponent(id));
  render();
}

var statusWords = { running: "Running", waiting: "Waiting on you", sleeping: "Sleeping", completed: "Completed", failed: "Failed", lost: "Lost: its process is gone" };

function renderDetail(run, runs, byId) {
  var el = document.getElementById("detail");
  if (!run) { el.replaceChildren(h("div", { class: "card empty" }, "Select a run to see its Machine.")); return; }
  var parts = [];
  var agent = run.agent ? [run.agent.harness, run.agent.model, run.agent.thinking].filter(Boolean).join(" · ") : "";
  parts.push(h("div", { class: "card head" },
    h("div", { class: "row" }, h("span", { class: "pill" }, h("span", { class: "dot " + run.status }), statusWords[run.status] || run.status),
      run.parent && byId[run.parent] ? h("button", { class: "btn", onclick: function () { select(run.parent); }, text: "↑ parent run" }) : null),
    h("h1", { text: title(run) }),
    h("div", { class: "meta" },
      h("span", null, "Machine ", h("b", { text: run.machine })),
      stateText(run) ? h("span", null, "State ", h("b", { text: stateText(run) }), run.stateSince && active(run) ? h("span", null, " for ", live(run.stateSince)) : null) : null,
      agent ? h("span", null, "Agent ", h("b", { text: agent })) : null,
      h("span", null, "Started ", h("b", { text: clock(run.startedAt) })),
      h("span", null, active(run) ? "Running for " : "Took ", active(run) ? live(run.startedAt) : h("b", { text: duration(Date.parse(run.updatedAt) - Date.parse(run.startedAt)) }))),
    h("div", { class: "meta mono", title: run.path, text: run.cwd })));
  if (run.limit) parts.push(h("div", { class: "banner limit" }, "Waiting for an Agent usage limit: " + run.limit.text + (run.limit.until ? " (until " + clock(run.limit.until) + ")" : "")));
  if (run.status === "sleeping") {
    var note = run.due ? "Sleeping until " + clock(run.due) + (Date.now() >= Date.parse(run.due) ? " (due now)" : "")
      : sleepingForAnswer(run) && run.human.answer !== undefined ? "Answer recorded. The run wakes " + wakesWith(run) + "."
      : "Sleeping for an answer. After it is recorded, the run wakes " + wakesWith(run) + ".";
    parts.push(h("div", { class: "banner sleeping", text: note, title: run.due || "" }));
    if (sleepingForAnswer(run) && !needsAnswer(run)) parts.push(h("div", { class: "card block" },
      h("h2", { text: "Recorded request" }), h("div", { class: "prompt", text: run.human.prompt }),
      h("div", { class: "hint mono", text: "request: " + run.human.requestId }),
      run.human.choices ? h("div", { class: "hint", text: "choices: " + run.human.choices.join(", ") }) : null));
  }
  if (needsAnswer(run) && run.human) parts.push(askCard(run));
  parts.push(graphCard(run));
  var kids = runs.filter(function (r) { return r.parent === run.id; });
  if (kids.length) parts.push(h("div", { class: "card block" }, h("h2", { text: "Sub-runs" }), h("div", { class: "subruns" }, kids.map(function (k) {
    return h("div", { class: "subrun", onclick: function () { select(k.id); } }, h("span", { class: "dot " + k.status }), h("span", { text: title(k) }), h("span", { class: "hint", text: stateText(k) }));
  }))));
  if (run.trail && run.trail.length) parts.push(trailCard(run));
  if (run.error) parts.push(h("div", { class: "banner error", text: run.error }));
  if (run.note) parts.push(h("div", { class: "card block" }, h("h2", { text: "Result" }), h("div", { class: "note", text: run.note })));
  var keep = document.activeElement && document.activeElement.tagName === "TEXTAREA" ? document.activeElement : null;
  if (keep && el.contains(keep)) {
    // Someone is typing an answer: leave the page as it is until they stop.
    return;
  }
  el.replaceChildren.apply(el, parts);
  drawGraph(run);
}

function askCard(run) {
  var human = run.human;
  var sleeping = run.status === "sleeping";
  var key = run.id + ":" + (human.requestId || "");
  var status = h("div", { class: "hint" });
  var card = h("div", { class: "card ask" }, h("h2", { text: "The run is asking" }), h("div", { class: "prompt", text: human.prompt }));
  if (run.answeredBy === "host") {
    card.appendChild(h("div", { class: "hint", text: "This run is answered through the program hosting it, such as Dispatch or an MCP session. Answer it there." }));
    return card;
  }
  if (!human.requestId) {
    card.appendChild(h("div", { class: "hint", text: "This run takes its answer only from the terminal it runs in." }));
    return card;
  }
  function submit(text, question) {
    if (sending || !text.trim()) return;
    sending = true;
    status.textContent = "Sending…";
    card.querySelectorAll("button, textarea").forEach(function (b) { b.disabled = true; });
    fetch("/api/respond", { method: "POST", headers: { "content-type": "application/json", "x-machines-ui": TOKEN },
      body: JSON.stringify({ runId: run.id, requestId: human.requestId, response: text, question: question }) })
      .then(function (r) { return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || r.statusText); }); })
      .then(function () { delete drafts[key]; status.textContent = sleeping ? "Answer recorded. The run wakes " + wakesWith(run) + "." : "The run took it."; })
      .catch(function (e) { status.textContent = e.message; card.querySelectorAll("button, textarea").forEach(function (b) { b.disabled = false; }); })
      .finally(function () { sending = false; });
  }
  if (human.choices && human.choices.length) {
    card.appendChild(h("div", { class: "choices" }, human.choices.map(function (c) {
      return h("button", { class: "btn", text: c, onclick: function () { submit(c, false); } });
    })));
  } else {
    var box = h("textarea", { placeholder: "Your answer", oninput: function () { drafts[key] = box.value; },
      onblur: function () { setTimeout(render, 0); } });
    box.value = drafts[key] || "";
    var asQuestion = h("input", { type: "checkbox", id: "q" });
    card.appendChild(box);
    if (human.suggestions && human.suggestions.length) card.appendChild(h("div", { class: "choices" }, human.suggestions.map(function (c) {
      return h("button", { class: "btn", text: c, onclick: function () { box.value = c; drafts[key] = c; box.focus(); } });
    })));
    card.appendChild(h("div", { class: "row" },
      h("button", { class: "btn primary", text: "Send", onmousedown: function (e) { e.preventDefault(); }, onclick: function () { submit(box.value, human.discussion && !sleeping ? asQuestion.checked : false); } }),
      human.discussion && !sleeping ? h("label", { class: "hint" }, asQuestion, " Ask a question instead of answering") : null));
  }
  card.appendChild(status);
  card.appendChild(h("div", { class: "hint mono", text: "machine respond " + run.id + " " + human.requestId + " <response>" }));
  return card;
}

function trailCard(run) {
  var trail = run.trail;
  var end = active(run) ? Date.now() : Date.parse(run.updatedAt);
  var rows = trail.map(function (step, i) {
    var next = i + 1 < trail.length ? Date.parse(trail[i + 1].at) : end;
    var current = i === trail.length - 1 && active(run);
    return h("div", { class: "step" + (current ? " now" : "") },
      h("span", { class: "t", text: clock(step.at) }), h("span", { class: "s", text: step.state }),
      h("span", { class: "d" }, current ? live(step.at) : duration(next - Date.parse(step.at))));
  }).reverse();
  return h("div", { class: "card block" }, h("h2", { text: "Path so far · " + trail.length + " step" + (trail.length > 1 ? "s" : "") }), h("div", { class: "trail" }, rows));
}

/* ---------- graph ---------- */

var NODE_W = 172, NODE_H = 46, GAP_X = 34, RANK_GAP = 84, PAD = 40, LANES = 130;

function layout(graph) {
  var states = graph.states;
  var byId = {};
  states.forEach(function (st) { byId[st.id] = st; });
  var out = {}, incoming = {};
  states.forEach(function (st) { out[st.id] = []; incoming[st.id] = []; });
  graph.edges.forEach(function (e) { if (byId[e.from] && byId[e.to]) { out[e.from].push(e); incoming[e.to].push(e); } });
  var mark = {}, back = new Set(), order = [], discovered = [];
  function dfs(id) {
    mark[id] = 1; discovered.push(id);
    out[id].forEach(function (e) {
      if (e.to === e.from || mark[e.to] === 1) back.add(e);
      else if (!mark[e.to]) dfs(e.to);
    });
    mark[id] = 2; order.push(id);
  }
  var reached = {};
  if (graph.initial && byId[graph.initial]) dfs(graph.initial);
  discovered.forEach(function (id) { reached[id] = true; });
  states.forEach(function (st) { if (!mark[st.id]) dfs(st.id); });
  var rank = {};
  states.forEach(function (st) { rank[st.id] = 0; });
  order.slice().reverse().forEach(function (id) {
    out[id].forEach(function (e) { if (!back.has(e)) rank[e.to] = Math.max(rank[e.to], rank[id] + 1); });
  });
  // Move a state down to just above its nearest next state, so its edges stay short; the first state stays on top.
  order.forEach(function (id) {
    var below = out[id].filter(function (e) { return !back.has(e); }).map(function (e) { return rank[e.to] - 1; });
    if (below.length && incoming[id].length) rank[id] = Math.max(rank[id], Math.min.apply(null, below));
  });
  var max = 0;
  states.forEach(function (st) { max = Math.max(max, rank[st.id]); });
  var rows = [];
  for (var r = 0; r <= max; r++) rows.push([]);
  discovered.forEach(function (id) { rows[rank[id]].push(id); });
  var pos = {};
  function index() { rows.forEach(function (row) { row.forEach(function (id, i) { pos[id] = i - (row.length - 1) / 2; }); }); }
  index();
  function sweep(down) {
    var range = [];
    for (var i = 0; i <= max; i++) range.push(i);
    if (!down) range.reverse();
    range.forEach(function (r) {
      var row = rows[r];
      var score = {};
      row.forEach(function (id) {
        var near = (down ? incoming[id].map(function (e) { return e.from; }) : out[id].map(function (e) { return e.to; }))
          .filter(function (n) { return n !== id && (down ? rank[n] < r : rank[n] > r); });
        score[id] = near.length ? near.reduce(function (sum, n) { return sum + pos[n]; }, 0) / near.length : pos[id];
      });
      row.sort(function (a, b) { return score[a] - score[b]; });
      row.forEach(function (id, i) { pos[id] = i - (row.length - 1) / 2; });
    });
  }
  for (var k = 0; k < 6; k++) sweep(k % 2 === 0);
  var widest = Math.max.apply(null, rows.map(function (row) { return row.length; }));
  var width = widest * NODE_W + (widest - 1) * GAP_X;
  var nodes = {};
  rows.forEach(function (row, r) {
    row.forEach(function (id) {
      nodes[id] = { id: id, x: LANES + PAD + width / 2 + pos[id] * (NODE_W + GAP_X) - NODE_W / 2, y: PAD + r * RANK_GAP, rank: r, state: byId[id], reached: !!reached[id] };
    });
  });
  return { nodes: nodes, edges: graph.edges.filter(function (e) { return nodes[e.from] && nodes[e.to]; }), back: back,
    width: width + PAD * 2 + LANES * 2, height: (max + 1) * RANK_GAP + PAD * 2 };
}

var KIND = { agent: "var(--agent)", human: "var(--human)", operation: "var(--operation)", final: "var(--final)", group: "var(--group)", state: "var(--group)" };
var ENDING = { succeeded: "var(--succeeded)", failed: "var(--failed)", cancelled: "var(--cancelled)" };

function graphCard(run) {
  var kinds = ["agent", "operation", "human", "final"].concat(Object.keys(ENDING).filter(function (k) {
    return run.graph && run.graph.states.some(function (st) { return st.ending === k; });
  }));
  var legend = h("div", { class: "legend" }, kinds.map(function (k) {
    return h("span", null, h("i", { style: "background:" + (ENDING[k] || KIND[k]) }), k);
  }));
  var tools = h("div", { class: "tools" },
    h("button", { class: "btn", title: "Zoom out", text: "−", onclick: function () { zoomBy(run, 1 / 1.25); } }),
    h("button", { class: "btn", title: "Zoom in", text: "+", onclick: function () { zoomBy(run, 1.25); } }),
    h("button", { class: "btn", title: "Fit the whole Machine", text: "Fit", onclick: function () { fit(run, true); } }),
    h("button", { class: "btn", title: "Show the current state", text: "Current", onclick: function () { fit(run, false); } }));
  var box = h("div", { class: "graph" + (run.graph ? "" : " none"), id: "graph" });
  if (!run.graph) box.appendChild(h("div", { class: "empty", text: "This run did not publish its Machine's graph. Runs started by a Machines release that draws graphs publish one." }));
  return h("div", { class: "card block" }, h("div", { class: "graph-head" }, h("h2", { text: "Machine" }), legend, tools), box);
}

function layoutFor(run) {
  var key = run.id + ":" + run.graph.states.length + ":" + run.graph.edges.length;
  if (!layouts[key]) layouts[key] = layout(run.graph);
  return layouts[key];
}

function trailFacts(run, lay) {
  var counts = {}, pairs = {};
  var trail = run.trail || [];
  var prev = null;
  trail.forEach(function (step) {
    var ids = step.state.split(", ");
    ids.forEach(function (id) { counts[id] = (counts[id] || 0) + 1; });
    if (prev) prev.forEach(function (a) { ids.forEach(function (b) { pairs[a + "\u0000" + b] = (pairs[a + "\u0000" + b] || 0) + 1; }); });
    prev = ids;
  });
  return { counts: counts, pairs: pairs };
}

function drawGraph(run) {
  var box = document.getElementById("graph");
  if (!box || !run.graph) return;
  var lay = layoutFor(run);
  var current = paths(run.state);
  var facts = trailFacts(run, lay);
  var svg = s("svg", { viewBox: "0 0 " + box.clientWidth + " " + box.clientHeight });
  var defs = s("defs");
  ["edge", "accent"].forEach(function (name) {
    defs.appendChild(s("marker", { id: "arrow-" + name, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
      s("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: name === "accent" ? "var(--accent)" : "var(--edge)" })));
  });
  svg.appendChild(defs);
  var view = s("g", { class: "viewport" });
  svg.appendChild(view);
  var edgeLayer = s("g"), nodeLayer = s("g");
  view.appendChild(edgeLayer); view.appendChild(nodeLayer);
  var nexts = {};
  if (active(run)) current.forEach(function (c) { nexts[c] = true; });
  var rightCount = {}, leftCount = {};
  lay.edges.forEach(function (e) {
    var a = lay.nodes[e.from], b = lay.nodes[e.to];
    var visited = facts.pairs[e.from + "\u0000" + e.to];
    var next = nexts[e.from] && !visited;
    var terminal = b.state.kind === "final" || /^(stuck|failure|failed|blocked|parked|park)$/i.test(b.state.id);
    var d, lx, ly;
    if (e.from === e.to) {
      var x0 = a.x + NODE_W, y0 = a.y + NODE_H / 2;
      d = "M " + x0 + " " + (y0 - 8) + " C " + (x0 + 34) + " " + (y0 - 30) + " " + (x0 + 34) + " " + (y0 + 30) + " " + x0 + " " + (y0 + 8);
      lx = x0 + 30; ly = y0;
    } else if (b.rank === a.rank + 1) {
      var sx = a.x + NODE_W / 2, sy = a.y + NODE_H, tx = b.x + NODE_W / 2, ty = b.y;
      var bend = Math.max(28, (ty - sy) * 0.45);
      d = "M " + sx + " " + sy + " C " + sx + " " + (sy + bend) + " " + tx + " " + (ty - bend) + " " + tx + " " + ty;
      lx = (sx + tx) / 2; ly = (sy + ty) / 2;
    } else if (b.rank > a.rank) {
      // A long way down goes round the left of the states between, so it never runs through one.
      var lane2 = (leftCount[e.to] = (leftCount[e.to] || 0) + 1);
      var px = a.x, py = a.y + NODE_H / 2, qx = b.x, qy = b.y + NODE_H / 2;
      var west = Math.min(px, qx) - 26 - 12 * Math.min(lane2, 7) - 5 * Math.min(b.rank - a.rank, 8);
      d = "M " + px + " " + py + " C " + west + " " + py + " " + west + " " + qy + " " + qx + " " + qy;
      lx = west + 4; ly = py + Math.min(RANK_GAP * 0.6, (qy - py) / 2);
    } else {
      var lane = (rightCount[e.to] = (rightCount[e.to] || 0) + 1);
      var ax = a.x + NODE_W, ay = a.y + NODE_H / 2, bx = b.x + NODE_W, by = b.y + NODE_H / 2;
      var out = Math.max(ax, bx) + 26 + 12 * Math.min(lane, 6) + 6 * Math.min(Math.abs(a.rank - b.rank), 8);
      d = "M " + ax + " " + ay + " C " + out + " " + ay + " " + out + " " + by + " " + bx + " " + by;
      lx = out - 6; ly = (ay + by) / 2;
    }
    var hot = visited || next;
    var g = s("g", { class: "edge" + (terminal ? " terminal" : "") + (visited ? " visited" : "") + (next ? " next" : "") },
      s("title", { text: e.from + " → " + e.to + " on " + e.event + (visited ? " (taken " + visited + "×)" : "") }),
      s("path", { d: d, "marker-end": "url(#arrow-" + (hot ? "accent" : "edge") + ")" }));
    if (hot || lay.edges.length <= 24) g.appendChild(s("text", { x: lx, y: ly, "text-anchor": "middle", "dominant-baseline": "middle", text: e.event + (visited > 1 ? " ×" + visited : "") }));
    (hot ? nodeLayer.parentNode : edgeLayer).insertBefore(g, hot ? nodeLayer : null);
  });
  Object.keys(lay.nodes).forEach(function (id) {
    var n = lay.nodes[id];
    var st = n.state;
    var isCurrent = current.indexOf(id) >= 0;
    var count = facts.counts[id] || 0;
    var short = id.split(".").pop();
    var name = short.length > 21 ? short.slice(0, 20) + "…" : short;
    var kind = st.ending || (st.kind === "agent" ? "agent · " + st.role : st.kind);
    var g = s("g", { class: "node" + (count ? " visited" : "") + (isCurrent ? " current " + run.status : "") + (n.reached ? "" : " unreached"), transform: "translate(" + n.x + "," + n.y + ")" },
      s("title", { text: id + " (" + kind + ")" + (count ? ", entered " + count + "×" : "") }));
    if (isCurrent && active(run)) g.appendChild(s("rect", { class: "halo", x: -5, y: -5, width: NODE_W + 10, height: NODE_H + 10, rx: 14 }));
    g.appendChild(s("rect", { class: "base", width: NODE_W, height: NODE_H, rx: 10 }));
    g.appendChild(s("rect", { class: "box", width: NODE_W, height: NODE_H, rx: 10, "stroke-dasharray": st.kind === "group" ? "4 3" : null }));
    g.appendChild(s("rect", { x: 0, y: 8, width: 4, height: NODE_H - 16, rx: 2, fill: ENDING[st.ending] || KIND[st.kind] || KIND.state }));
    g.appendChild(s("text", { x: 14, y: 19, text: name }));
    g.appendChild(s("text", { class: "kind", x: 14, y: 35, text: kind.length > 26 ? kind.slice(0, 25) + "…" : kind }));
    if (count > 1) {
      g.appendChild(s("rect", { class: "badge", x: NODE_W - 30, y: -8, width: 30, height: 17, rx: 8.5 }));
      g.appendChild(s("text", { class: "count", x: NODE_W - 15, y: 4, "text-anchor": "middle", text: "×" + count }));
    }
    nodeLayer.appendChild(g);
  });
  box.replaceChildren(svg);
  // The whole Machine when it can be read at that size; otherwise the part around where the run is.
  if (!views[run.id]) fit(run, !active(run) || Math.min(box.clientWidth / lay.width, box.clientHeight / lay.height) >= 0.6); else apply(run);
  bindPanZoom(box, run);
}

function apply(run) {
  var v = views[run.id];
  var g = document.querySelector("#graph .viewport");
  if (g && v) g.setAttribute("transform", "translate(" + v.x + "," + v.y + ") scale(" + v.k + ")");
}

function fit(run, whole) {
  var box = document.getElementById("graph");
  if (!box || !run.graph) return;
  var lay = layoutFor(run);
  var w = box.clientWidth, hgt = box.clientHeight;
  var k = Math.min(1, w / lay.width, whole ? hgt / lay.height : 1);
  k = Math.max(k, whole ? 0.15 : 0.45);
  var v = { k: k, x: (w - lay.width * k) / 2, y: (hgt - lay.height * k) / 2 };
  var current = paths(run.state).map(function (id) { return lay.nodes[id]; }).filter(Boolean)[0];
  if (!whole || lay.height * k > hgt) {
    if (current) v.y = hgt / 2 - (current.y + NODE_H / 2) * k;
    else v.y = 10;
    if (lay.width * k > w && current) v.x = w / 2 - (current.x + NODE_W / 2) * k;
  }
  views[run.id] = v;
  apply(run);
}

function zoomBy(run, factor, cx, cy) {
  var box = document.getElementById("graph");
  var v = views[run.id];
  if (!box || !v) return;
  if (cx === undefined) { cx = box.clientWidth / 2; cy = box.clientHeight / 2; }
  var k = Math.min(2.5, Math.max(0.1, v.k * factor));
  v.x = cx - (cx - v.x) * (k / v.k);
  v.y = cy - (cy - v.y) * (k / v.k);
  v.k = k;
  apply(run);
}

function bindPanZoom(box, run) {
  if (box.dataset.bound === run.id) return;
  box.dataset.bound = run.id;
  var start = null;
  box.onwheel = function (e) {
    e.preventDefault();
    var rect = box.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomBy(currentRun(), Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
    else { var v = views[currentRun().id]; v.x -= e.deltaX; v.y -= e.deltaY; apply(currentRun()); }
  };
  box.onpointerdown = function (e) { start = { x: e.clientX, y: e.clientY, v: Object.assign({}, views[currentRun().id]) }; box.setPointerCapture(e.pointerId); box.classList.add("dragging"); };
  box.onpointermove = function (e) {
    if (!start) return;
    var v = views[currentRun().id];
    v.x = start.v.x + e.clientX - start.x; v.y = start.v.y + e.clientY - start.y;
    apply(currentRun());
  };
  box.onpointerup = box.onpointercancel = function () { start = null; box.classList.remove("dragging"); };
}
function currentRun() { return data.runs.find(function (r) { return r.id === selected; }); }

/* ---------- panels ---------- */

function renderPanels(panels) {
  var el = document.getElementById("panels");
  if (!panels.length) {
    el.replaceChildren(h("div", { class: "card panel" }, h("h3", { text: "Project panels" }),
      h("div", { class: "summary" }, "A project adds its own panels here, such as tickets or pull requests, by naming commands that print JSON in .machines/ui.json.")));
    return;
  }
  el.replaceChildren.apply(el, panels.map(function (p) {
    return h("div", { class: "card panel" },
      h("h3", null, p.title, p.checkedAt ? h("span", { text: ago(p.checkedAt) }) : null),
      p.summary ? h("div", { class: "summary", text: p.summary }) : null,
      p.error ? h("div", { class: "error", text: p.error }) : null,
      p.items.length ? h("div", { class: "items" }, p.items.map(function (it) {
        return h("div", { class: "item" }, h("span", { class: "dot " + (it.status || "idle") }),
          h("span", { class: "text" }, it.href ? h("a", { href: it.href, target: "_blank", rel: "noopener noreferrer", text: it.text }) : it.text),
          h("span", { class: "at", text: it.at ? ago(it.at) : "" }),
          it.detail ? h("span", { class: "detail", text: it.detail }) : null);
      })) : (!p.error ? h("div", { class: "summary", text: p.checkedAt ? "Nothing to show." : "Loading…" }) : null));
  }));
}

setInterval(function () {
  document.querySelectorAll("[data-since]").forEach(function (el) {
    el.textContent = duration(Date.now() - Date.parse(el.getAttribute("data-since"))) + (el.getAttribute("data-suffix") || "");
  });
}, 1000);
window.addEventListener("resize", function () { if (data && selected) { var r = currentRun(); if (r) drawGraph(r); } });
window.addEventListener("hashchange", function () { var id = decodeURIComponent(location.hash.slice(1)); if (id && id !== selected) select(id); });
connect();
</script>
</body>
</html>
`;
