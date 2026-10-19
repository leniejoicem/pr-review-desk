// PR Review Desk: a local UI for the pr-reviewer Claude Code agent.
// Builds your review inbox (teammates' PRs in your repos, PRs that request or
// assign you, PRs you've reviewed, issues assigned to you), and runs
// `claude -p --agent pr-reviewer` per PR. With Auto-watch on, it checks
// GitHub on a timer and starts reviews and rechecks by itself.
// Run: node server.mjs   (no npm install needed)

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4317);
const HOST = "127.0.0.1";
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 3);
const RUNS_DIR = path.join(HERE, "runs");
const WORK_DIR = path.join(HERE, "work");
const SETTINGS_FILE = path.join(HERE, "settings.json");
// Sent with every write request so other websites can't trigger runs.
const TOKEN = randomBytes(16).toString("hex");
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

// ---------- settings (kept in settings.json next to this file) ----------

function loadSettings() {
  const defaults = {
    repos: (process.env.REPOS || "").split(",").map((s) => s.trim()).filter(Boolean),
    watch: false,
    intervalMin: 10,
  };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) }; }
  catch { return defaults; }
}
const settings = loadSettings();
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ---------- GitHub (via the gh CLI you're already signed in to) ----------

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const PR_FIELDS = `
fragment P on PullRequest {
  number title url isDraft updatedAt additions deletions changedFiles
  headRefName baseRefName headRefOid
  repository { nameWithOwner }
  author { login }
  reviewRequests(first:20) { nodes { requestedReviewer { ... on User { login } } } }
  assignees(first:10) { nodes { login } }
  reviews(last:40) { nodes { author { login } state submittedAt url commit { oid } } }
  reviewThreads(first:60) {
    nodes { isResolved comments(first:25) { nodes { author { login } createdAt } } }
  }
}`;

function inboxQuery(repos) {
  const base = "is:open archived:false";
  const repoTerms = repos.filter((r) => REPO_RE.test(r)).map((r) => `repo:${r}`).join(" ");
  const searches = {
    team: repoTerms ? `is:pr ${base} -author:@me ${repoTerms}` : null,
    requested: `is:pr ${base} review-requested:@me`,
    assigned: `is:pr ${base} assignee:@me -author:@me`,
    reviewed: `is:pr ${base} reviewed-by:@me -author:@me`,
  };
  const parts = Object.entries(searches)
    .filter(([, q]) => q)
    .map(([k, q]) => `${k}: search(query:${JSON.stringify(q)}, type:ISSUE, first:30) { nodes { ...P } }`);
  parts.push(`issues: search(query:${JSON.stringify(`is:issue ${base} assignee:@me`)}, type:ISSUE, first:50) {
    nodes { ... on Issue {
      number title url updatedAt createdAt
      repository { nameWithOwner }
      labels(first:6) { nodes { name color } }
      comments { totalCount }
      closedByPullRequestsReferences(first:5, includeClosedPrs:false) { nodes { number url title state isDraft author { login } } }
    } }
  }`);
  return `query { viewer { login } ${parts.join("\n")} }\n${PR_FIELDS}`;
}

function prStatus(pr, me) {
  const mine = pr.reviews.nodes.filter((r) => r.author?.login === me && r.state !== "PENDING");
  const last = mine[mine.length - 1] || null;
  // Threads you've commented in, where someone else has spoken since your last word.
  const myThreads = pr.reviewThreads.nodes.filter((t) => t.comments.nodes.some((c) => c.author?.login === me));
  const pending = myThreads.filter((t) => {
    if (t.isResolved) return false;
    const cs = t.comments.nodes;
    return cs.length && cs[cs.length - 1].author?.login !== me;
  });
  const requested = pr.reviewRequests.nodes.some((r) => r.requestedReviewer?.login === me);
  const assigned = pr.assignees.nodes.some((a) => a.login === me);
  const newestReply = pending
    .map((t) => t.comments.nodes[t.comments.nodes.length - 1].createdAt)
    .sort()
    .pop() || "";

  let status, reason;
  if (!last && !myThreads.length) { status = "needs-review"; reason = "You haven't reviewed this yet."; }
  else if (requested) { status = "ready-to-recheck"; reason = "You were asked to review again."; }
  else if (pending.length) { status = "ready-to-recheck"; reason = `${pending.length} thread${pending.length > 1 ? "s" : ""} you're in got a reply.`; }
  else if (last && last.commit?.oid !== pr.headRefOid) { status = "ready-to-recheck"; reason = "New commits since your last review."; }
  else if (last?.state === "APPROVED") { status = "approved"; reason = "You approved the current commit."; }
  else if (last?.state === "CHANGES_REQUESTED") { status = "changes-requested"; reason = "You requested changes; nothing new yet."; }
  else { status = "waiting"; reason = "Nothing new since your last review."; }

  return {
    status, reason,
    // Changes only when there's something new to look at, so auto-watch runs once per change.
    signature: [status, pr.headRefOid, newestReply, requested].join("|"),
    lastReview: last && { state: last.state, at: last.submittedAt, url: last.url, sha: last.commit?.oid || null },
    openThreads: myThreads.filter((t) => !t.isResolved).length,
    pendingReplies: pending.length,
    roles: { requested, assigned, reviewed: !!last },
  };
}

async function inbox() {
  const out = await gh(["api", "graphql", "-f", `query=${inboxQuery(settings.repos)}`]);
  const data = JSON.parse(out).data;
  const me = data.viewer.login;
  const byUrl = new Map();
  for (const key of ["requested", "assigned", "team", "reviewed"]) {
    for (const pr of data[key]?.nodes || []) {
      if (!pr?.url || pr.author?.login === me) continue;
      const entry = byUrl.get(pr.url) || { pr, sources: new Set() };
      entry.sources.add(key);
      byUrl.set(pr.url, entry);
    }
  }
  const prs = [...byUrl.values()].map(({ pr, sources }) => ({
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login || "ghost",
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    head: pr.headRefName,
    base: pr.baseRefName,
    headSha: pr.headRefOid,
    sources: [...sources],
    ...prStatus(pr, me),
  })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const issues = (data.issues?.nodes || []).filter((i) => i?.url).map((i) => ({
    repo: i.repository.nameWithOwner,
    number: i.number,
    title: i.title,
    url: i.url,
    updatedAt: i.updatedAt,
    createdAt: i.createdAt,
    labels: i.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
    comments: i.comments.totalCount,
    linkedPRs: i.closedByPullRequestsReferences.nodes.map((p) => ({ number: p.number, url: p.url, title: p.title, isDraft: p.isDraft, author: p.author?.login })),
  })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { me, repos: settings.repos, prs, issues, checkedAt: Date.now() };
}

// ---------- Runs of the pr-reviewer agent ----------

const runs = new Map(); // id -> run
const queue = [];

function activeCount() {
  let n = 0;
  for (const r of runs.values()) if (r.state === "running") n++;
  return n;
}

function publicRun(r) {
  const { proc, listeners, events, ...rest } = r;
  return rest;
}

function emit(run, ev) {
  ev.t = Date.now();
  if (ev.kind === "tool") run.lastActivity = { tool: ev.tool, label: ev.label || "" };
  else if (ev.kind === "text") run.lastActivity = { tool: "say", label: ev.text.slice(0, 200) };
  run.events.push(ev);
  fs.appendFile(run.logFile, JSON.stringify(ev) + "\n", () => {});
  for (const res of run.listeners) res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

function setState(run, state, extra = {}) {
  Object.assign(run, { state }, extra);
  emit(run, { kind: "state", state, ...extra });
}

function liveRun(repo, number) {
  for (const r of runs.values()) {
    if (r.repo === repo && r.number === number && (r.state === "running" || r.state === "queued")) return r;
  }
  return null;
}

function startRun(repo, number, mode, { reason = "", by = "you" } = {}) {
  const existing = liveRun(repo, number);
  if (existing) return existing; // one run per PR at a time
  const id = randomUUID().slice(0, 8);
  const work = path.join(WORK_DIR, `${repo.replace("/", "_")}_pr${number}`);
  fs.mkdirSync(work, { recursive: true });
  const run = {
    id, repo, number, mode, reason, by,
    state: "queued",
    createdAt: Date.now(),
    startedAt: null, endedAt: null,
    cost: null, resultText: null, reviewUrl: null, error: null,
    slot: null, lastActivity: null,
    logFile: path.join(RUNS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}_${repo.replace("/", "_")}_pr${number}_${mode}_${id}.jsonl`),
    work, events: [], listeners: new Set(), proc: null,
  };
  runs.set(id, run);
  emit(run, { kind: "state", state: "queued" });
  queue.push(run);
  pump();
  return run;
}

function pump() {
  while (activeCount() < MAX_PARALLEL && queue.length) {
    const run = queue.shift();
    if (run.state !== "queued") continue;
    launch(run);
  }
}

function launch(run) {
  const prUrl = `https://github.com/${run.repo}/pull/${run.number}`;
  const prompt =
    `Mode: ${run.mode}. PR: ${prUrl}. ` +
    (run.reason ? `Why now: ${run.reason} ` : "") +
    `Use ${run.work} as your scratch directory for clones, test copies and payload files. ` +
    `Finish with the summary described under "What to return".`;
  const args = [
    "-p", prompt,
    "--agent", "pr-reviewer",
    "--permission-mode", "auto",
    "--output-format", "stream-json",
    "--verbose",
  ];
  const proc = spawn("claude", args, { cwd: run.work, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  run.proc = proc;
  // Give the run the lowest free desk so the UI can seat its reviewer.
  const taken = new Set([...runs.values()].filter((r) => r.state === "running").map((r) => r.slot));
  let slot = 0;
  while (taken.has(slot)) slot++;
  run.slot = slot;
  setState(run, "running", { startedAt: Date.now(), slot });

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(run, line);
    }
  });
  let stderr = "";
  proc.stderr.on("data", (c) => { stderr += c; });
  proc.on("error", (err) => {
    setState(run, "failed", { endedAt: Date.now(), error: `Couldn't start claude: ${err.message}` });
    pump();
  });
  proc.on("close", (code) => {
    if (run.state === "running") {
      const ok = code === 0 && !run.error;
      setState(run, ok ? "done" : "failed", {
        endedAt: Date.now(),
        error: ok ? null : run.error || stderr.trim().slice(-2000) || `claude exited with code ${code}`,
      });
    }
    pump();
  });
}

function handleLine(run, line) {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (e.type === "assistant") {
    for (const c of e.message?.content || []) {
      if (c.type === "text" && c.text.trim()) emit(run, { kind: "text", text: c.text });
      if (c.type === "tool_use") {
        const input = c.input || {};
        const label = input.description || input.file_path || input.pattern || (input.command || "").slice(0, 160);
        emit(run, { kind: "tool", tool: c.name, label });
      }
    }
  } else if (e.type === "result") {
    const text = e.result || "";
    const urls = text.match(/https:\/\/github\.com\/[^\s)`]+#pullrequestreview-\d+/g);
    run.resultText = text;
    run.cost = e.total_cost_usd ?? null;
    run.reviewUrl = urls ? urls[urls.length - 1] : null;
    if (e.is_error) run.error = text || e.subtype;
    emit(run, { kind: "result", text, cost: run.cost, reviewUrl: run.reviewUrl, isError: !!e.is_error });
  }
}

function stopRun(run) {
  if (run.state === "queued") {
    setState(run, "stopped", { endedAt: Date.now() });
  } else if (run.state === "running" && run.proc) {
    run.proc.kill("SIGTERM");
    setState(run, "stopped", { endedAt: Date.now() });
  }
}

// ---------- Auto-watch ----------

const dispatched = new Map(); // "repo#n" -> signature last sent to an agent
const watch = { timer: null, lastCheck: null, nextCheck: null, lastError: null, lastStarted: [] };

async function watchTick() {
  watch.lastCheck = Date.now();
  try {
    const box = await inbox();
    const started = [];
    for (const p of box.prs) {
      if (p.isDraft) continue; // drafts wait until they're marked ready
      const mode = p.status === "needs-review" ? "review" : p.status === "ready-to-recheck" ? "recheck" : null;
      if (!mode) continue;
      const key = `${p.repo}#${p.number}`;
      if (dispatched.get(key) === p.signature || liveRun(p.repo, p.number)) continue;
      dispatched.set(key, p.signature);
      startRun(p.repo, p.number, mode, { reason: p.reason, by: "auto-watch" });
      started.push(`#${p.number} ${mode}`);
    }
    watch.lastStarted = started;
    watch.lastError = null;
  } catch (err) {
    watch.lastError = err.message;
  }
  schedule();
}

function schedule() {
  clearTimeout(watch.timer);
  watch.timer = null;
  watch.nextCheck = null;
  if (!settings.watch) return;
  const ms = Math.max(2, settings.intervalMin) * 60_000;
  watch.nextCheck = Date.now() + ms;
  watch.timer = setTimeout(watchTick, ms);
}

function watchState() {
  return {
    on: settings.watch, intervalMin: settings.intervalMin, repos: settings.repos,
    lastCheck: watch.lastCheck, nextCheck: watch.nextCheck, lastError: watch.lastError, lastStarted: watch.lastStarted,
  };
}

// ---------- HTTP ----------

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  // Refuse other hostnames (DNS rebinding) and cross-site writes.
  const host = req.headers.host || "";
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: "Wrong host" });
  const url = new URL(req.url, `http://${host}`);
  if (req.method !== "GET" && req.headers["x-desk-token"] !== TOKEN) return send(res, 403, { error: "Missing or wrong token. Reload the page." });

  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(path.join(HERE, "index.html"), "utf8")
        .replace("__TOKEN__", TOKEN)
        .replace("__MAX_PARALLEL__", String(MAX_PARALLEL));
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/inbox") return send(res, 200, await inbox());
    if (req.method === "GET" && url.pathname === "/api/runs") {
      return send(res, 200, [...runs.values()].map(publicRun).sort((a, b) => b.createdAt - a.createdAt));
    }
    if (req.method === "GET" && url.pathname === "/api/watch") return send(res, 200, watchState());
    if (req.method === "POST" && url.pathname === "/api/watch") {
      const body = await readJson(req);
      if (typeof body.on === "boolean") settings.watch = body.on;
      if (Number.isFinite(body.intervalMin)) settings.intervalMin = Math.min(240, Math.max(2, Math.round(body.intervalMin)));
      if (Array.isArray(body.repos)) {
        const bad = body.repos.filter((r) => !REPO_RE.test(r));
        if (bad.length) return send(res, 400, { error: `Not a repo: ${bad.join(", ")}. Use owner/name.` });
        settings.repos = [...new Set(body.repos)];
      }
      saveSettings();
      if (body.checkNow || (body.on === true)) { clearTimeout(watch.timer); watchTick(); }
      else schedule();
      return send(res, 200, watchState());
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const { repo, number, mode, reason } = await readJson(req);
      if (!REPO_RE.test(repo || "")) return send(res, 400, { error: "Repo must look like owner/name." });
      if (!Number.isInteger(number) || number < 1) return send(res, 400, { error: "PR number must be a positive whole number." });
      if (mode !== "review" && mode !== "recheck") return send(res, 400, { error: "Mode must be review or recheck." });
      return send(res, 200, publicRun(startRun(repo, number, mode, { reason: typeof reason === "string" ? reason.slice(0, 300) : "" })));
    }
    const m = url.pathname.match(/^\/api\/runs\/([0-9a-f-]{8})(\/stream|\/stop)?$/);
    if (m) {
      const run = runs.get(m[1]);
      if (!run) return send(res, 404, { error: "No such run." });
      if (req.method === "POST" && m[2] === "/stop") { stopRun(run); return send(res, 200, publicRun(run)); }
      if (req.method === "GET" && m[2] === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        run.listeners.add(res);
        req.on("close", () => run.listeners.delete(res));
        return;
      }
    }
    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PR Review Desk: http://${HOST}:${PORT}`);
  console.log(`Watching repos: ${settings.repos.join(", ") || "(none)"} · auto-watch ${settings.watch ? `on, every ${settings.intervalMin} min` : "off"} · up to ${MAX_PARALLEL} reviewers at once`);
  console.log(`Run logs: ${RUNS_DIR}`);
  if (settings.watch) watchTick();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const r of runs.values()) if (r.proc && r.state === "running") r.proc.kill("SIGTERM");
    process.exit(0);
  });
}
