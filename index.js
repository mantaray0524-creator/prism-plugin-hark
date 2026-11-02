"use strict";
/**
 * Prism PluginBridge plugin: Hark.
 *
 * Glasses -> Prism Cloud -> Prism Hub -> this plugin -> Chrome (CDP) -> app.hark.com
 *
 * Session model (v0.1.6): one Prism session per Hark conversation (main 「聊天」
 * + each project), listed from Hark's /api/conversations. NativeSessionID = the
 * conversation id. Opening/sending navigates the plugin's Chrome tab there.
 * History = transcript rows read from the page, overlaid with live runs.
 * "hark-main" (v0.1.0–0.1.5) still works and means "whatever tab is open".
 */
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { serve } = require("@rokid-prism/pluginbridge-plugin-sdk");
const { sleep } = require("@rokid-prism/pluginbridge-plugin-sdk/cdp-runtime");
const { HarkCdp, HOME_DIR } = require("./hark_cdp");
const { parseHarkTime, conversationTitle, groupRows } = require("./sessions");

const PLUGIN_ID = "hark";
const SURFACE = "hark-web-cdp";
const LEGACY_ID = "hark-main";
const HISTORY_FILE = path.join(HOME_DIR, "history.json");
const LOG_FILE = path.join(HOME_DIR, "plugin.log");
const POLL_MS = 1500;
const MAX_TURNS = 200;

fs.mkdirSync(HOME_DIR, { recursive: true });
function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
// A stray rejection (e.g. Chrome tab closed mid-poll) must not kill the plugin
// process: when it dies, Prism Hub reports an IPC/RPC failure on the glasses.
process.on("unhandledRejection", (e) => log(`unhandledRejection: ${(e && e.stack) || e}`));
process.on("uncaughtException", (e) => log(`uncaughtException: ${(e && e.stack) || e}`));
// RFC 3339 built from UTC parts (independent of any Date.prototype patching).
function nowISO() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}Z`;
}

const hark = new HarkCdp(log);

// ---------- turns sent from the glasses (overlay on page history) ----------
let turns = []; // { id, sid, user, assistant, status, createdAt, updatedAt, revision }
try {
  turns = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
} catch {}
for (const t of turns) if (!t.sid) t.sid = LEGACY_ID;
let saveTimer = null;
function saveTurns() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(turns.slice(-MAX_TURNS), null, 1));
    } catch (e) {
      log(`history save failed: ${e.message}`);
    }
  }, 300);
}
const historyListeners = new Set();
function notifyHistory(turn) {
  for (const fn of historyListeners) fn(turn);
}

const norm = (s) => String(s || "").replace(/\s+/g, "");

// ---------- Hark conversations ----------
let convs = new Map(); // id -> { id, title, updatedAt }
let mainId = "";
let openSid = ""; // conversation id currently open in the tab (best effort)

async function refreshConversations() {
  const list = await hark.listConversations();
  const next = new Map();
  for (const c of list) {
    next.set(c.id, c);
    if (!c.title) mainId = c.id;
  }
  convs = next;
  return list;
}
function sidOf(session) {
  return String((session && (session.NativeSessionID || session.NativeThreadID)) || LEGACY_ID);
}
function titleOf(sid) {
  if (sid === LEGACY_ID) return "Hark";
  return conversationTitle(convs.get(sid));
}
/** Serialises everything that drives the tab (navigation, reads, sends). */
let tabLock = Promise.resolve();
function withTab(fn) {
  const next = tabLock.then(fn, fn);
  tabLock = next.catch(() => {});
  return next;
}
function activeRun() {
  return Array.from(runs.values()).find((r) => !r.finalEvent && !r.superseded) || null;
}
/** Opens `sid` in the tab. Leaving a conversation stops following its run. */
async function openSession(sid) {
  if (sid === LEGACY_ID) return;
  if (!convs.size) await refreshConversations().catch((e) => log(`list conversations failed: ${e.message}`));
  const projectId = sid === mainId ? "" : sid;
  const cur = await hark.currentProjectId().catch(() => null);
  const curSid = cur === "" ? mainId : cur;
  if (curSid === sid) { openSid = sid; return; }
  for (const r of runs.values()) {
    if (r.sid !== sid && !r.superseded) {
      if (!r.finalEvent) finalize(r, "run.completed", "completed", r.turn.assistant || "（已切换到其他会话）");
      r.superseded = true;
    }
  }
  log(`open conversation ${sid} (${titleOf(sid)})`);
  await hark.openConversation(projectId);
  openSid = sid;
}
/** History turns for `sid`: page transcript + glasses runs not yet on the page. */
async function sessionTurns(sid, limit) {
  let pageTurns = [];
  const busy = activeRun();
  const canNavigate = !busy || busy.sid === sid || sid === LEGACY_ID;
  if (canNavigate) {
    try {
      await withTab(async () => {
        await openSession(sid);
        const rows = await hark.readRows();
        pageTurns = groupRows(rows || []);
      });
    } catch (e) {
      log(`read page history failed (${sid}): ${e.message}`);
    }
  }
  const byId = new Map(pageTurns.map((t) => [t.id, t]));
  const pageUsers = new Set(pageTurns.map((t) => norm(t.user)));
  for (const t of turns) {
    if (t.sid !== sid) continue;
    // v0.1.5-era turns have no Hark message id: skip them once the page shows them.
    if (String(t.id).startsWith("hark-run-") && pageUsers.has(norm(t.user)) && t.status !== "running") continue;
    byId.set(t.id, t); // live/glasses turns win
  }
  const all = Array.from(byId.values());
  for (const t of all) {
    if (!t.createdAt) t.createdAt = nowISO();
    if (!t.updatedAt) t.updatedAt = t.createdAt;
  }
  all.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return all.slice(-(limit || 20));
}

// ---------- event bus for subscribe ----------
const subscribers = new Set();
function emit(event) {
  for (const push of subscribers) push(event);
}

// ---------- runs ----------
const runs = new Map(); // runId -> run

function session(sid, cwd = "") {
  return {
    PluginID: PLUGIN_ID,
    NativeSessionID: sid,
    NativeThreadID: sid,
    Surface: SURFACE,
    Endpoint: hark.cfg.harkUrl,
    Cwd: cwd,
    Visible: true,
  };
}

function afterISO(iso, ms = 1) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + ms).toISOString() : iso;
}

/**
 * The glasses' "Agent 正在回复" state and the send button come from the Hub's
 * detail snapshot, which a desktop-automation plugin only updates through
 * Payload.detail_snapshot on its events. Without it the panel stays "running".
 */
function detailSnapshot(run, status) {
  const t = run.turn;
  const ms = (iso) => (Date.parse(iso) || Date.now());
  const done = status !== "running";
  return {
    title: run.title || "Hark",
    // No desktop_foreground: claiming foreground made the glasses jump from
    // other agents' (Codex) sessions into Hark (Ray, 2026-11-02, v0.1.4).
    primary_action: "send",
    run: {
      task_id: run.id,
      status,
      summary: done ? "" : "Hark 正在回复",
      preview: (t.assistant || "").slice(-400),
      interruptible: false,
      started_at: ms(t.createdAt),
      updated_at: Date.now(),
      completed_at: done ? Date.now() : 0,
      error: status === "failed" ? (run.finalEvent && run.finalEvent.Summary) || "失败" : "",
    },
  };
}

function runPayload(run, status, extra = {}) {
  return { native_session_id: run.sid, native_thread_id: run.sid, run_id: run.id, ...extra, detail_snapshot: detailSnapshot(run, status) };
}

function toHistoryTurn(turn) {
  const done = turn.status !== "running";
  const messages = [
    {
      ID: `${turn.id}:user`,
      Role: "user",
      Type: "text",
      Content: turn.user,
      Status: "completed",
      CreatedAt: turn.createdAt,
      UpdatedAt: turn.createdAt,
    },
  ];
  if (turn.assistant || !done) {
    messages.push({
      ID: `${turn.id}:assistant`,
      Role: "assistant",
      Type: "text",
      Content: turn.assistant || "",
      Status: turn.status,
      // Same timestamp as the user row would sort first on the glasses
      // (ties break by id, and ":assistant" < ":user"), so keep it 1 ms later.
      CreatedAt: afterISO(turn.createdAt),
      UpdatedAt: turn.updatedAt,
      Progress: {
        Status: turn.status,
        StartedAt: turn.createdAt,
        CompletedAt: done ? turn.updatedAt : undefined,
        Steps: turn.assistant
          ? [{ ID: `${turn.id}:text`, Kind: "assistant_text", Title: "Hark", Detail: turn.assistant, Status: turn.status, CreatedAt: turn.updatedAt }]
          : [{ ID: `${turn.id}:wait`, Kind: "status", Title: "Hark 正在处理", Detail: "", Status: "running", CreatedAt: turn.createdAt }],
      },
    });
  }
  return { turn_id: turn.id, order_key: turn.createdAt, revision: turn.revision || 1, messages };
}

function finalize(run, type, status, summary) {
  if (run.finalEvent) return;
  run.finalEvent = {
    ID: run.id,
    Type: type,
    Status: status,
    Summary: summary,
    CreatedAt: nowISO(),
    Payload: {},
  };
  run.turn.status = status === "completed" ? "completed" : "failed";
  run.turn.updatedAt = nowISO();
  run.turn.revision = (run.turn.revision || 1) + 1;
  saveTurns();
  notifyHistory(run.turn);
  run.finalEvent.Payload = runPayload(run, status === "completed" ? "completed" : "failed");
  emit(run.finalEvent);
  run.resolve(run.finalEvent);
}

/** Polls the page after a send and turns transcript growth into events. */
async function watchRun(run) {
  const cfg = hark.cfg;
  let last = "";
  let lastChange = Date.now();
  let started = false;
  const t0 = Date.now();
  const followUntil = () => t0 + cfg.runTimeoutMs + cfg.followAfterRunMs;
  while (Date.now() < followUntil()) {
    await sleep(POLL_MS);
    if (run.superseded) break; // a newer glasses message took over
    let reply = "";
    let interrupted = false;
    try {
      const r = await hark.replyAfter(run.turn.user, run.before, run.previous);
      reply = r.text;
      interrupted = r.interrupted;
    } catch (e) {
      log(`poll failed: ${e.message}`);
      continue;
    }
    if (reply !== last) {
      last = reply;
      lastChange = Date.now();
      run.turn.assistant = reply;
      run.turn.updatedAt = nowISO();
      run.turn.revision = (run.turn.revision || 1) + 1;
      saveTurns();
      notifyHistory(run.turn);
      if (!run.finalEvent) {
        if (!started && reply) {
          started = true;
          emit({ ID: `${run.id}:start`, Type: "message.started", Status: "running", Summary: "Hark 正在回复", CreatedAt: nowISO(), Payload: runPayload(run, "running") });
        }
        emit({ ID: `${run.id}:delta:${Date.now()}`, Type: "message.delta", Status: "running", Summary: reply, CreatedAt: nowISO(), Payload: runPayload(run, "running", { text: reply, replace: true }) });
      }
    }
    if (interrupted) {
      // You typed something else on the computer: this turn is over.
      if (!run.finalEvent) {
        if (last) emit({ ID: `${run.id}:done`, Type: "message.completed", Status: "completed", Summary: last, CreatedAt: nowISO(), Payload: runPayload(run, "completed", { text: last }) });
        finalize(run, "run.completed", "completed", last || "已在电脑上继续对话");
      }
      break;
    }
    if (run.finalEvent) continue; // keep following late replies into history
    if (run.cancelled) {
      finalize(run, "run.failed", "failed", last || "已停止跟踪");
      continue;
    }
    if (!last && Date.now() - t0 > cfg.firstReplyTimeoutMs) {
      finalize(run, "run.failed", "failed", "Hark 在 2 分钟内没有回复");
      continue;
    }
    const busy = await hark.isBusy().catch(() => false);
    if (last && !busy && Date.now() - lastChange >= cfg.stableMs) {
      emit({ ID: `${run.id}:done`, Type: "message.completed", Status: "completed", Summary: last, CreatedAt: nowISO(), Payload: runPayload(run, "completed", { text: last }) });
      finalize(run, "run.completed", "completed", last);
      continue;
    }
    if (Date.now() - t0 > cfg.runTimeoutMs) {
      finalize(run, "run.completed", "completed", last || "Hark 仍在处理");
    }
  }
}

async function startRun(sid, msg) {
  const text = String((msg && msg.Text) || "").trim();
  if (!text) throw new Error("empty message");
  return withTab(() => startRunLocked(sid, text, msg));
}

async function startRunLocked(sid, text, msg) {
  await openSession(sid);
  // Close out any turn still open so the glasses never stay locked on it.
  for (const r of runs.values()) {
    if (!r.finalEvent) finalize(r, "run.completed", "completed", r.turn.assistant || "（下一条消息已发出）");
    r.superseded = true;
  }
  let preRows = [];
  try { preRows = (await hark.readRows()) || []; } catch {}
  const preIds = new Set(preRows.map((r) => r.id));
  const previous = preRows.filter((r) => r.role === "user").slice(-6).map((r) => r.text);
  let before;
  try {
    ({ before } = await hark.sendText(text));
  } catch (e) {
    log(`send to Hark failed: ${e.message}`);
    throw e;
  }
  const id = `hark-run-${randomUUID()}`;
  // Use Hark's own message id for the turn, so page history and live updates are one turn.
  let turnId = id;
  for (let i = 0; i < 8 && turnId === id; i++) {
    await sleep(400);
    const rows = await hark.readRows().catch(() => []);
    const mine = (rows || []).filter((r) => r.role === "user" && !preIds.has(r.id) && norm(r.text).includes(norm(text).slice(0, 40)));
    if (mine.length) turnId = `msg:${mine[mine.length - 1].id}`;
  }
  const turn = { id: turnId, sid, user: text, assistant: "", status: "running", createdAt: nowISO(), updatedAt: nowISO(), revision: 1, prismMessageId: msg.PrismMessageID || "" };
  turns.push(turn);
  if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
  saveTurns();
  notifyHistory(turn);
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const run = { id, sid, title: titleOf(sid), turn, before, previous, done, resolve, finalEvent: null, cancelled: false, superseded: false };
  runs.set(id, run);
  for (const k of Array.from(runs.keys()).slice(0, -20)) runs.delete(k);
  emit({ ID: `${id}:accepted`, Type: "run.progress", Status: "running", Summary: "已发给 Hark", CreatedAt: nowISO(), Payload: runPayload(run, "running") });
  watchRun(run).catch((e) => {
    log(`watchRun crashed: ${e.stack || e}`);
    finalize(run, "run.failed", "failed", `读取回复失败：${e.message}`);
  });
  log(`sent run ${id} to ${sid} (${titleOf(sid)}), turn ${turnId}, ${text.length} chars`);
  return run;
}

function receipt(run) {
  return {
    NativeMessageID: run.id,
    CanonicalNativeSessionID: run.sid,
    CanonicalNativeThreadID: run.sid,
    Accepted: true,
    Visible: true,
    Detail: "sent to Hark web composer",
  };
}

function capability(available, reason = "") {
  return {
    PluginID: PLUGIN_ID,
    Available: available,
    NativeVisibleInput: available,
    NativeVisibleOutput: available,
    CanAttachSession: available,
    CanStartSessionWithMessage: available,
    CanOpenDraft: false,
    CanListSessions: available,
    CanReadHistory: available,
    CanInterrupt: false,
    CanApproval: false,
    CanForwardSync: available,
    CanReverseSync: false,
    CanPluginWideWatch: false,
    CanWaitRun: available,
    CanReadStatus: available,
    CanControlSession: false,
    CanOpenManagedTerminal: false,
    IntegrationMode: "desktop-automation",
    VisibilitySurface: SURFACE,
    UnavailableReason: available ? "" : reason,
  };
}

const adapter = {
  id: () => PLUGIN_ID,

  async probe() {
    const st = await hark.status();
    if (!st.ok) log(`probe unavailable: ${st.reason} ${st.url || ""}`);
    return capability(st.ok, st.reason);
  },

  async discover() {
    const st = await hark.status();
    return {
      PluginID: PLUGIN_ID,
      Surface: SURFACE,
      Endpoint: hark.cfg.harkUrl,
      ProcessID: 0,
      SessionHints: { cdp_port: String(hark.cfg.cdpPort), url: st.url || "" },
      Verified: st.ok,
      Detail: st.ok ? `Hark tab ready: ${st.title || ""}` : st.reason,
    };
  },

  async listSessions() {
    let list = [];
    try {
      list = await refreshConversations();
    } catch (e) {
      log(`list conversations failed: ${e.message}`);
    }
    const lastBySid = new Map();
    for (const t of turns) lastBySid.set(t.sid, t.updatedAt);
    const out = list.map((c) => ({
      PluginID: PLUGIN_ID,
      NativeSessionID: c.id,
      NativeThreadID: c.id,
      Surface: SURFACE,
      Endpoint: hark.cfg.harkUrl,
      Cwd: "",
      Title: conversationTitle(c),
      PrismConversationID: "",
      Active: c.id === openSid,
      Visible: true,
      LastActivityAt: [lastBySid.get(c.id), parseHarkTime(c.updatedAt)].filter(Boolean).sort().pop(),
      Metadata: { source: "hark-web", kind: c.title ? "project" : "chat" },
    }));
    if (!out.length) {
      // Conversation list unreadable: fall back to the single v0.1.x session.
      const lastTurn = turns[turns.length - 1];
      out.push({ PluginID: PLUGIN_ID, NativeSessionID: LEGACY_ID, NativeThreadID: LEGACY_ID, Surface: SURFACE, Endpoint: hark.cfg.harkUrl, Cwd: "", Title: "Hark", PrismConversationID: "", Active: true, Visible: true, LastActivityAt: lastTurn ? lastTurn.updatedAt : nowISO(), Metadata: { source: "hark-web" } });
    }
    return out;
  },

  async attachSession(req) {
    const sid = String((req && req.NativeSessionID) || LEGACY_ID);
    return session(sid, (req && req.Cwd) || "");
  },

  async startSessionWithMessage(req) {
    // A new glasses conversation goes to Hark's main 「聊天」.
    if (!mainId) await refreshConversations().catch((e) => log(`list conversations failed: ${e.message}`));
    const sid = mainId || LEGACY_ID;
    const run = await startRun(sid, req.Message);
    return {
      Session: session(sid, req.Cwd || ""),
      Receipt: receipt(run),
      Visibility: { Visible: true, Marker: run.turn.user, Evidence: "composer emptied after submit", CheckedAt: nowISO(), FailureReason: "" },
    };
  },

  async send(sess, msg) {
    const run = await startRun(sidOf(sess), msg);
    return receipt(run);
  },

  async waitForRun(_session, runID) {
    const run = runs.get(runID);
    if (!run) throw new Error(`hark run not found: ${runID}`);
    return run.done;
  },

  async readStatus(sess, runID) {
    const sid = sidOf(sess);
    const run = runs.get(runID) || Array.from(runs.values()).filter((r) => r.sid === sid).pop();
    if (!run) return { status: "idle", interruptible: false, approval_blocked: false };
    const t = run.turn;
    return {
      status: run.finalEvent ? run.finalEvent.Status : "running",
      preview: (t.assistant || "").slice(-400),
      interruptible: false,
      approval_blocked: false,
      turn_id: t.id,
      started_at: t.createdAt,
      completed_at: run.finalEvent ? t.updatedAt : undefined,
    };
  },

  async readHistory(sess, limit) {
    return (await sessionTurns(sidOf(sess), limit || 20)).flatMap((t) => toHistoryTurn(t).messages);
  },

  async *readHistoryStream(sess, request = {}, signal) {
    const sid = sidOf(sess);
    const streamID = request.stream_id || randomUUID();
    const limit = Math.max(1, Number(request.limit) || 20);
    const queue = [];
    let wake = null;
    const seen = new Set();
    const listener = (turn) => {
      if (turn.sid !== sid) return;
      queue.push(turn);
      if (wake) wake();
    };
    if (request.live) historyListeners.add(listener);
    try {
      for (const t of await sessionTurns(sid, limit)) {
        seen.add(t.id);
        yield { stream_id: streamID, type: "turn", source: "initial", operation: "append", turn: toHistoryTurn(t) };
      }
      yield { stream_id: streamID, type: request.live ? "page_end" : "end", source: "initial", operation: "append" };
      if (!request.live) return;
      while (!signal || !signal.aborted) {
        if (!queue.length) {
          if (signal && signal.aborted) break;
          await new Promise((r) => {
            wake = r;
            const onAbort = () => r();
            if (signal) signal.addEventListener("abort", onAbort, { once: true });
            const done = wake;
            wake = () => {
              if (signal) signal.removeEventListener("abort", onAbort);
              done();
            };
          });
          wake = null;
          continue;
        }
        const t = queue.shift();
        const operation = seen.has(t.id) ? "replace" : "append";
        seen.add(t.id);
        yield { stream_id: streamID, type: "turn", source: "live", operation, turn: toHistoryTurn(t) };
      }
    } finally {
      historyListeners.delete(listener);
    }
  },

  async *subscribe(_session, signal) {
    const queue = [];
    let wake = null;
    const push = (e) => {
      queue.push(e);
      if (wake) wake();
    };
    subscribers.add(push);
    try {
      while (!signal || !signal.aborted) {
        if (!queue.length) {
          if (signal && signal.aborted) break;
          await new Promise((r) => {
            wake = r;
            const onAbort = () => r();
            if (signal) signal.addEventListener("abort", onAbort, { once: true });
            const done = wake;
            wake = () => {
              if (signal) signal.removeEventListener("abort", onAbort);
              done();
            };
          });
          wake = null;
          continue;
        }
        yield queue.shift();
      }
    } finally {
      subscribers.delete(push);
    }
  },

  async interrupt(_session, taskID) {
    // Hark web has no stop button we rely on; stop following the run instead.
    const run = runs.get(taskID) || Array.from(runs.values()).find((r) => !r.finalEvent);
    if (run) run.cancelled = true;
  },

  async verifyVisibility(_session, marker) {
    const text = await hark.transcript().catch(() => "");
    const visible = Boolean(marker) && text.includes(String(marker).trim());
    return { Visible: visible, Marker: marker, Evidence: visible ? "found in Hark transcript" : "", CheckedAt: nowISO(), FailureReason: visible ? "" : "marker_not_found" };
  },

  async close() {
    await hark.close();
  },
};

module.exports = { adapter, toHistoryTurn, detailSnapshot };

if (require.main === module) {
  serve(adapter).catch((err) => {
    log(`fatal: ${err.stack || err}`);
    process.exit(1);
  });
}
