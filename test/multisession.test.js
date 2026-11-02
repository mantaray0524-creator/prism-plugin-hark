const test = require("node:test");
test.after(() => setTimeout(() => process.exit(0), 50));
const assert = require("node:assert");
const os = require("os"); const fs = require("fs");
process.env.HOME = fs.mkdtempSync(os.tmpdir() + "/hm-");
const { HarkCdp } = require("../hark_cdp");
const page = { pid: "p1", rows: { "": [], p1: [{ id: "x1", role: "user", text: "旧问题", at: "2026-11-01T00:00:00Z" }, { id: "x2", role: "assistant", text: "旧回答", at: "2026-11-01T00:00:05Z" }] } };
const nav = [];
Object.assign(HarkCdp.prototype, {
  async listConversations() { return [{ id: "main", title: null, updatedAt: "Wed 2026-10-14 6:08 PM (UTC+08:00)" }, { id: "p1", title: "项目一", updatedAt: "Sun 2026-11-01 12:42 AM (UTC+08:00)" }]; },
  async currentProjectId() { return page.pid; },
  async openConversation(pid) { nav.push(pid); page.pid = pid; return true; },
  async readRows() { return page.rows[page.pid] || []; },
  async sendText(text) { (page.rows[page.pid] ||= []).push({ id: "n" + Date.now(), role: "user", text, at: new Date().toISOString() }); return { before: "" }; },
  async replyAfter() { return { text: "", interrupted: false }; },
  async isBusy() { return false; },
});
const { adapter } = require("../index.js");
const S = (id) => ({ NativeSessionID: id, NativeThreadID: id });

test("lists main chat and projects", async () => {
  const l = await adapter.listSessions();
  assert.deepStrictEqual(l.map((s) => [s.NativeSessionID, s.Title]), [["main", "聊天"], ["p1", "项目一"]]);
});
test("history reads the page of that conversation", async () => {
  const h = await adapter.readHistory(S("p1"), 10);
  assert.deepStrictEqual(h.map((m) => m.Content), ["旧问题", "旧回答"]);
  assert.strictEqual(nav.length, 0);
});
test("send navigates to the target and uses Hark's message id", async () => {
  const r = await adapter.send(S("main"), { Text: "你好主聊天" });
  assert.deepStrictEqual(nav, [""]);
  assert.strictEqual(r.CanonicalNativeSessionID, "main");
  const h = await adapter.readHistory(S("main"), 10);
  assert.strictEqual(h.filter((m) => m.Role === "user").length, 1);
  assert.ok(h[0].ID.startsWith("msg:n"));
  await adapter.interrupt(S("main"), r.NativeMessageID);
});
test("while a run is active, other sessions don't navigate", async () => {
  const before = nav.length;
  const h = await adapter.readHistory(S("p1"), 10);
  assert.strictEqual(nav.length, before);
  assert.strictEqual(h.length, 0);
});
