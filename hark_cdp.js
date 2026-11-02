"use strict";
/**
 * Hark web (app.hark.com) controller over Chrome DevTools Protocol.
 *
 * Hark has no Mac app and no public chat API, so this drives the web app in a
 * dedicated Chrome profile started with --remote-debugging-port.
 * All DOM knowledge lives in DEFAULT_SELECTORS and can be overridden in
 * ~/.prism-hark/config.json without touching code (run `npm run probe`).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { CdpPageClient, sleep } = require("@rokid-prism/pluginbridge-plugin-sdk/cdp-runtime");
const { harkSplit } = require("./dom_split");
const { READ_ROWS_JS } = require("./sessions");

const HOME_DIR = path.join(os.homedir(), ".prism-hark");
const CONFIG_FILE = path.join(HOME_DIR, "config.json");

const DEFAULTS = {
  harkUrl: "https://app.hark.com/",
  cdpPort: 9333,
  chromePath: process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "google-chrome",
  userDataDir: path.join(HOME_DIR, "chrome-profile"),
  managedLaunch: true,
  // A reply counts as finished when the transcript after your message has been
  // unchanged for this long. Hark often posts a short "on it" line first and the
  // real answer minutes later; later text still reaches the glasses through the
  // live history stream.
  stableMs: 12000,
  firstReplyTimeoutMs: 120000,
  runTimeoutMs: 15 * 60 * 1000,
  followAfterRunMs: 15 * 60 * 1000,
  selectors: {
    // Message composer. First visible match wins (last one in DOM order).
    composer: "textarea, [contenteditable='true'][role='textbox'], div[contenteditable='true']",
    // Send button. Empty string = press Enter instead.
    sendButton: "button[type='submit'], button[aria-label*='Send' i], button[aria-label*='发送']",
    // Container whose innerText holds the conversation. First visible match.
    transcript: "main, [role='main'], body",
    // Optional: element present while Hark is still typing/working.
    busy: "",
    // Optional: matches a row (or something inside it) that is YOUR message.
    // Empty = recognise your rows by their shape (see dom_split.js).
    userRow: "",
  },
  // Lines dropped from extracted reply text (UI chrome, button labels).
  dropLines: ["Copy", "复制", "Retry", "重试"],
};

function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  const env = process.env;
  const cfg = {
    ...DEFAULTS,
    ...user,
    selectors: { ...DEFAULTS.selectors, ...(user.selectors || {}) },
  };
  if (env.PRISM_HARK_URL) cfg.harkUrl = env.PRISM_HARK_URL;
  if (env.PRISM_HARK_CDP_PORT) cfg.cdpPort = Number(env.PRISM_HARK_CDP_PORT);
  if (env.PRISM_HARK_CHROME_PATH) cfg.chromePath = env.PRISM_HARK_CHROME_PATH;
  if (env.PRISM_HARK_USER_DATA_DIR) cfg.userDataDir = env.PRISM_HARK_USER_DATA_DIR;
  if (env.PRISM_PLUGIN_MANAGED_LAUNCH === "0") cfg.managedLaunch = false;
  if (env.PRISM_HARK_EXTRA_ARGS) cfg.extraArgs = env.PRISM_HARK_EXTRA_ARGS.split(" ").filter(Boolean);
  if (env.PRISM_HARK_STABLE_MS) cfg.stableMs = Number(env.PRISM_HARK_STABLE_MS);
  return cfg;
}

function harkHost(cfg) {
  try {
    return new URL(cfg.harkUrl).host;
  } catch {
    return "app.hark.com";
  }
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Browser-side helpers, injected as a string into every evaluate. */
function pageLib(cfg) {
  return `
  const SEL = ${JSON.stringify(cfg.selectors)};
  const DROP = new Set(${JSON.stringify(cfg.dropLines)});
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }
  function lastVisible(sel) {
    if (!sel) return null;
    const all = Array.from(document.querySelectorAll(sel)).filter(visible);
    return all.length ? all[all.length - 1] : null;
  }
  function firstVisible(sel) {
    if (!sel) return null;
    return Array.from(document.querySelectorAll(sel)).find(visible) || null;
  }
  function composer() { return lastVisible(SEL.composer); }
  // Send button: configured selector first, else the last enabled-looking
  // icon button near the composer (Hark: round black arrow after the "+").
  function sendBtn() {
    const configured = lastVisible(SEL.sendButton);
    if (configured) return configured;
    const c = composer();
    let box = c;
    for (let i = 0; box && i < 6; i++) {
      box = box.parentElement;
      if (!box) break;
      const btns = Array.from(box.querySelectorAll("button, [role='button']")).filter(visible);
      if (btns.length) {
        const cands = btns.filter((b) => !/add|attach|plus|upload|附件|添加|mic|voice|语音/i.test((b.getAttribute("aria-label") || "") + " " + (b.title || "") + " " + (b.innerText || "")));
        if (cands.length) return cands[cands.length - 1];
      }
    }
    return null;
  }
  function composerDump() {
    const c = composer();
    let box = c;
    for (let i = 0; box && i < 4; i++) box = box.parentElement || box;
    return box ? box.outerHTML.replace(/\\s+/g, " ").slice(0, 3000) : "no composer";
  }
  // Selector list in priority order (comma-separated), not DOM order.
  function preferred(sel) {
    for (const part of String(sel || "").split(",")) {
      const el = firstVisible(part.trim());
      if (el) return el;
    }
    return null;
  }
  function transcriptText() {
    const root = preferred(SEL.transcript) || document.body;
    return (root.innerText || "").replace(/\\u00a0/g, " ");
  }
  function clean(text) {
    return text.split("\\n").map((l) => l.trimEnd())
      .filter((l) => !DROP.has(l.trim()))
      .join("\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
  }
  `;
}

class HarkCdp {
  constructor(log = () => {}) {
    this.cfg = loadConfig();
    this.log = log;
    this.client = null;
    this.targetId = "";
    this.launching = null;
  }

  base() {
    return `http://127.0.0.1:${this.cfg.cdpPort}`;
  }

  async browserUp() {
    try {
      await fetchJSON(`${this.base()}/json/version`);
      return true;
    } catch {
      return false;
    }
  }

  async launchChrome() {
    if (this.launching) return this.launching;
    this.launching = (async () => {
      fs.mkdirSync(this.cfg.userDataDir, { recursive: true });
      const args = [
        `--remote-debugging-port=${this.cfg.cdpPort}`,
        `--user-data-dir=${this.cfg.userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        // keep the Hark tab responsive when the window is in the background
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        ...(this.cfg.extraArgs || []),
        this.cfg.harkUrl,
      ];
      this.log(`launching Chrome: ${this.cfg.chromePath}`);
      const child = spawn(this.cfg.chromePath, args, { detached: true, stdio: "ignore" });
      child.on("error", (e) => this.log(`chrome spawn error: ${e.message}`));
      child.unref();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (await this.browserUp()) return true;
        await sleep(500);
      }
      throw new Error("Chrome 没有在 20 秒内打开调试端口");
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  async findTarget() {
    const host = harkHost(this.cfg);
    const list = await fetchJSON(`${this.base()}/json/list`);
    const pages = list.filter((t) => t.type === "page");
    return pages.find((t) => t.id === this.targetId)
      || pages.find((t) => String(t.url).includes(host))
      || null;
  }

  async openTarget() {
    const url = encodeURIComponent(this.cfg.harkUrl);
    try {
      return await fetchJSON(`${this.base()}/json/new?${url}`, { method: "PUT" });
    } catch {
      return fetchJSON(`${this.base()}/json/new?${url}`);
    }
  }

  /** Returns a connected CdpPageClient on the Hark tab, launching Chrome if allowed. */
  async page() {
    if (this.client && this.client.connected) {
      try {
        await this.client.evaluate("1");
        return this.client;
      } catch {
        await this.client.close().catch(() => {});
        this.client = null;
      }
    }
    if (!(await this.browserUp())) {
      if (!this.cfg.managedLaunch) {
        throw new Error(`找不到 Chrome 调试端口 ${this.cfg.cdpPort}，且未开启托管启动`);
      }
      await this.launchChrome();
    }
    let target = await this.findTarget();
    if (!target) {
      target = await this.openTarget();
      await sleep(3000);
    }
    const client = new CdpPageClient({ actionTimeoutMs: 10000 });
    await client.connectToPage(target.webSocketDebuggerUrl);
    this.client = client;
    this.targetId = target.id;
    return client;
  }

  async evaluate(body) {
    const client = await this.page();
    return client.evaluate(`(() => { ${pageLib(this.cfg)} ${body} })()`);
  }

  async status() {
    try {
      const st = await this.evaluate(`
        return {
          url: location.href,
          title: document.title,
          hasComposer: Boolean(composer()),
        };
      `);
      const loggedOut = /\/(login|sign-?in|sign-?up)/i.test(st.url);
      if (loggedOut) return { ok: false, reason: "hark_login_required", ...st };
      if (!st.hasComposer) return { ok: false, reason: "hark_composer_not_found", ...st };
      return { ok: true, reason: "", ...st };
    } catch (e) {
      return { ok: false, reason: `hark_cdp_unavailable: ${e.message}` };
    }
  }

  /** Hark's own conversation list (main chat + projects), read with the page's login. */
  async listConversations() {
    const r = await this.evaluate(`
      return fetch("/api/conversations", { credentials: "include", headers: { accept: "application/json" } })
        .then((r) => r.ok ? r.json() : { error: "HTTP " + r.status });
    `);
    if (!r || r.error || !Array.isArray(r.conversations)) throw new Error(`list conversations failed: ${(r && r.error) || "bad response"}`);
    return r.conversations.filter((c) => c && c.id && !c.archivedAt);
  }

  /** Conversation id open in the tab: /project/<id>, or "" for the main 「聊天」. */
  async currentProjectId() {
    const p = await this.evaluate(`return location.pathname;`);
    const m = String(p || "").match(/\/project\/([^/?#]+)/);
    return m ? m[1] : "";
  }

  /** Opens a conversation in the tab (projectId "" = main chat) and waits for its transcript. */
  async openConversation(projectId) {
    const cur = await this.currentProjectId().catch(() => null);
    if (cur === projectId) return false;
    const from = await this.evaluate(`return location.pathname;`).catch(() => "?");
    this.log(`navigate ${from} -> ${projectId ? "/project/" + projectId : "聊天"}`);
    if (projectId) {
      await this.evaluate(`location.assign(location.origin + "/project/" + ${JSON.stringify(projectId)}); return true;`).catch(() => {});
    } else {
      const ok = await this.evaluate(`
        const b = Array.from(document.querySelectorAll("button, [role=button], [role=tab], a"))
          .find((e) => visible(e) && ((e.getAttribute("aria-label") || "").trim() === "聊天" || (e.innerText || "").trim() === "聊天"));
        if (b) { b.click(); return true; }
        location.assign(location.origin + "/"); return false;
      `).catch(() => false);
      this.log(`open main chat via ${ok ? "聊天 button" : "/"}`);
    }
    // Hark's page is heavy (WebGL wallpaper, long transcripts): first loads can take >20 s.
    const t0 = Date.now();
    const deadline = t0 + 45000;
    let lastCount = -1;
    let stableSince = 0;
    let arrived = 0;
    while (Date.now() < deadline) {
      await sleep(400);
      const st = await this.evaluate(`
        const m = location.pathname.match(/[/]project[/]([^/?#]+)/);
        return { pid: m ? m[1] : "", composer: Boolean(composer()), rows: document.querySelectorAll("[data-message-id]").length };
      `).catch(() => null);
      if (!st || st.pid !== projectId || !st.composer) continue;
      if (!arrived) arrived = Date.now();
      if (st.rows !== lastCount) { lastCount = st.rows; stableSince = Date.now(); continue; }
      // Rows settled, or the page is there but keeps re-rendering: good enough.
      if ((st.rows > 0 && Date.now() - stableSince >= 1200) || Date.now() - arrived >= 8000) {
        this.log(`opened ${projectId || "聊天"} in ${Date.now() - t0} ms, ${st.rows} rows`);
        return true;
      }
    }
    const last = await this.evaluate(`return location.pathname + " composer=" + Boolean(composer()) + " rows=" + document.querySelectorAll("[data-message-id]").length;`).catch((e) => e.message);
    throw new Error(`打开 Hark 会话超时: ${projectId || "聊天"} (now ${last})`);
  }

  /** Transcript rows [{id, role, text, at}] of the open conversation. */
  async readRows() {
    return this.evaluate(READ_ROWS_JS);
  }

  async transcript() {
    return this.evaluate(`return transcriptText();`);
  }

  /** Types `text` into the composer and submits it. Returns transcript snapshot taken just before. */
  async sendText(text) {
    const client = await this.page();
    const pre = await this.evaluate(`
      const c = composer();
      if (!c) return { ok: false, reason: "composer_not_found" };
      const existing = c.value !== undefined ? c.value : c.innerText;
      let cleared = "";
      if (existing && existing.trim()) {
        // Dedicated Chrome profile: leftover text is a stale glasses draft
        // (e.g. a send that failed earlier). Clear it instead of blocking.
        cleared = existing.trim().slice(0, 80);
        c.focus();
        if (typeof c.select === "function") c.select();
        else document.execCommand("selectAll", false);
        document.execCommand("delete", false);
        const left = c.value !== undefined ? c.value : c.innerText;
        if (left && left.trim()) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c), "value");
          if (setter && setter.set) { setter.set.call(c, ""); c.dispatchEvent(new Event("input", { bubbles: true })); }
          else c.textContent = "";
        }
        const after = c.value !== undefined ? c.value : c.innerText;
        if (after && after.trim()) return { ok: false, reason: "composer_occupied" };
      }
      c.scrollIntoView({ block: "center" });
      c.focus();
      return { ok: true, before: transcriptText(), cleared };
    `);
    if (!pre.ok) throw new Error(pre.reason);
    if (pre.cleared) this.log(`cleared stale composer text: ${pre.cleared}`);
    await client.send("Page.bringToFront").catch(() => {});
    await this.evaluate(`const c = composer(); c && c.focus(); return true;`);
    await client.insertText(text);
    await sleep(250);
    const emptied = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const left = await this.evaluate(`
          const c = composer();
          const v = c ? (c.value !== undefined ? c.value : c.innerText) : "";
          return !v || !v.trim();
        `);
        if (left) return true;
        await sleep(200);
      }
      return false;
    };
    // The send button can stay disabled for a moment after input (React state).
    const findBtn = `(() => { ${pageLib(this.cfg)} return sendBtn(); })()`;
    const btnReady = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await this.evaluate(`const b = sendBtn(); return Boolean(b && !b.disabled && b.getAttribute("aria-disabled") !== "true");`)) return true;
        await sleep(150);
      }
      return false;
    };
    const steps = [];
    // 1) click the send button
    if (await btnReady(2000)) {
      steps.push("click");
      await client.clickElement(findBtn).catch((e) => steps.push(`click_err:${e.message}`));
      if (await emptied(1500)) { this.log(`send ok via ${steps.join(">")}`); return { before: pre.before }; }
    }
    // 2) Enter in the composer
    steps.push("enter");
    await this.evaluate(`const c = composer(); c && c.focus(); return true;`);
    await client.keyPress("Enter").catch((e) => steps.push(`enter_err:${e.message}`));
    if (await emptied(1500)) { this.log(`send ok via ${steps.join(">")}`); return { before: pre.before }; }
    // 3) DOM-level click / form submit
    steps.push("dom");
    await this.evaluate(`
      const b = sendBtn();
      if (b && !b.disabled) { b.click(); return "button"; }
      const f = composer() && composer().closest("form");
      if (f && f.requestSubmit) { f.requestSubmit(); return "form"; }
      return "none";
    `).then((r) => steps.push(r)).catch(() => {});
    if (await emptied(5000)) { this.log(`send ok via ${steps.join(">")}`); return { before: pre.before }; }
    const dump = await this.evaluate(`return composerDump();`).catch(() => "");
    this.log(`send failed via ${steps.join(">")}; composer area: ${dump}`);
    throw new Error("send_not_confirmed: composer still holds the text");
  }

  async isBusy() {
    if (!this.cfg.selectors.busy) return false;
    return this.evaluate(`return Boolean(firstVisible(SEL.busy));`);
  }

  /**
   * Hark's text after `sent`, stopping at the next message of yours (e.g. one
   * typed on the computer). Returns { text, interrupted, mode }.
   * `previous` = earlier messages sent from the glasses, used to find the list.
   */
  async replyAfter(sent, before = "", previous = []) {
    try {
      const r = await this.evaluate(`
        const split = ${harkSplit.toString()};
        return split({ document, getComputedStyle: (e) => getComputedStyle(e) },
          ${JSON.stringify(sent)}, ${JSON.stringify(previous.slice(-6).reverse())},
          { root: preferred(SEL.transcript) || document.body, userRowSelector: SEL.userRow || "" });
      `);
      if (r && r.ok) {
        return { text: cleanReply(r.text, this.cfg.dropLines), interrupted: Boolean(r.interrupted), mode: "dom" };
      }
      if (r && r.reason !== this._lastSplitReason) {
        this._lastSplitReason = r.reason;
        this.log(`dom split unavailable: ${r.reason}; using text fallback`);
      }
    } catch (e) {
      this.log(`dom split failed: ${e.message}`);
    }
    const raw = await this.transcript();
    return { text: extractReply(raw, sent, before, this.cfg.dropLines), interrupted: false, mode: "text" };
  }

  async close() {
    if (this.client) await this.client.close().catch(() => {});
    this.client = null;
  }
}

function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/**
 * Pure function (unit-tested): find the user's message in the transcript and
 * return everything after it, minus UI chrome lines.
 */
function extractReply(raw, sent, before = "", dropLines = DEFAULTS.dropLines) {
  const text = String(raw || "");
  const drop = new Set(dropLines);
  let tail = "";
  const idx = text.lastIndexOf(String(sent || "").trim());
  if (sent && idx >= 0) {
    tail = text.slice(idx + String(sent).trim().length);
  } else {
    // Fallback: whitespace-insensitive match on the last 40 chars of the message.
    const key = normalize(sent).slice(-40);
    const lines = text.split("\n");
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (key && normalize(lines.slice(i, i + 6).join(" ")).includes(key)) {
        start = i;
        break;
      }
    }
    if (start >= 0) {
      let j = start;
      while (j < lines.length && !normalize(lines.slice(start, j + 1).join(" ")).includes(key)) j++;
      tail = lines.slice(j + 1).join("\n");
    } else if (before && text.startsWith(before.slice(0, 2000))) {
      tail = text.slice(before.length);
    }
  }
  return cleanReply(tail, dropLines);
}

function cleanReply(tail, dropLines = DEFAULTS.dropLines) {
  const drop = new Set(dropLines);
  return String(tail || "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => !drop.has(l.trim()))
    // lone icon glyphs from buttons (↑, ⋯, ×)
    .filter((l) => !/^\s*[^\p{L}\p{N}]{1,2}\s*$/u.test(l) || l.trim() === "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { HarkCdp, loadConfig, extractReply, cleanReply, HOME_DIR, CONFIG_FILE, DEFAULTS };
