"use strict";
/**
 * Multi-session support (v0.1.6).
 *
 * Learned from Ray's probes (2026-11-02):
 * - GET /api/conversations (same-origin, cookies) -> { conversations: [{ id, title, createdAt, updatedAt, archivedAt }] }
 *   title null = the main 「聊天」; others are projects, opened at /project/<id>.
 * - Transcript rows: [data-transcript-row] containing [data-message-id]; text in [data-testid=message-text];
 *   attachments as buttons inside [data-align=end|start]; time[datetime] holds the ISO time.
 *   Yours vs Hark: message-text class _151xtfx4 (you) / _151xtfx5 (Hark); attachment data-align end/start.
 */

const MONTHS = { AM: 0, PM: 12 };

/** "Wed 2026-10-14 6:08 PM (UTC+08:00)" -> ISO string (falls back to Date.parse / now). */
function parseHarkTime(s) {
  const m = String(s || "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s*\(UTC([+-])(\d{2}):(\d{2})\)/i);
  if (m) {
    let h = Number(m[4]) % 12;
    if (!m[6]) h = Number(m[4]);
    else h += MONTHS[m[6].toUpperCase()];
    const off = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
    const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, Number(m[5])) - off * 60000;
    return new Date(utc).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

function conversationTitle(c) {
  return (c && c.title) || "聊天";
}

/** Rows [{id, role:'user'|'assistant', text, at}] -> turns [{id, user, assistant, createdAt, updatedAt, status}] */
function groupRows(rows) {
  const turns = [];
  let cur = null;
  for (const r of rows) {
    if (!r || !r.text) continue;
    if (r.role === "user") {
      if (cur && !cur.assistant && cur.userIds.length) {
        // Consecutive user rows (text + attachment) belong to one turn.
        cur.user += "\n" + r.text;
        cur.userIds.push(r.id);
        continue;
      }
      cur = { id: `msg:${r.id}`, userIds: [r.id], user: r.text, assistant: "", createdAt: r.at, updatedAt: r.at, status: "completed" };
      turns.push(cur);
    } else {
      if (!cur) {
        cur = { id: `msg:${r.id}`, userIds: [], user: "", assistant: r.text, createdAt: r.at, updatedAt: r.at, status: "completed" };
        turns.push(cur);
        continue;
      }
      cur.assistant = cur.assistant ? `${cur.assistant}\n\n${r.text}` : r.text;
      if (r.at) cur.updatedAt = r.at;
    }
  }
  for (const t of turns) delete t.userIds;
  return turns;
}

/** Browser-side: read transcript rows. Needs `visible` from pageLib. */
const READ_ROWS_JS = `
  const list = document.querySelector('[data-testid="message-list"]') || document.body;
  const lr = list.getBoundingClientRect();
  const mid = lr.left + lr.width / 2;
  const seen = new Set();
  const rows = [];
  let lastAt = "";
  for (const el of list.querySelectorAll("[data-message-id]")) {
    const id = el.getAttribute("data-message-id");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const txtEl = el.querySelector('[data-testid="message-text"]');
    const files = Array.from(el.querySelectorAll('[data-align] button')).map((b) => (b.innerText || "").trim()).filter(Boolean);
    let text = txtEl ? (txtEl.innerText || "").trim() : "";
    if (files.length) text = (text ? text + "\\n" : "") + files.map((f) => "[附件] " + f).join("\\n");
    if (!text) continue;
    let role = "";
    const al = el.querySelector("[data-align]");
    if (txtEl && /(^|\\s)_151xtfx4(\\s|$)/.test(txtEl.className)) role = "user";
    else if (txtEl && /(^|\\s)_151xtfx5(\\s|$)/.test(txtEl.className)) role = "assistant";
    else if (al) role = al.getAttribute("data-align") === "end" ? "user" : "assistant";
    else {
      const r = (txtEl || el).getBoundingClientRect();
      role = r.left > mid - 40 && r.right > lr.right - 120 ? "user" : "assistant";
    }
    const t = el.querySelector("time[datetime]");
    const at = t ? t.getAttribute("datetime") : lastAt;
    if (at) lastAt = at;
    rows.push({ id, role, text, at });
  }
  return rows;
`;

module.exports = { parseHarkTime, conversationTitle, groupRows, READ_ROWS_JS };
