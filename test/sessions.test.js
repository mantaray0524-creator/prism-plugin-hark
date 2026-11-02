const test = require("node:test");
const assert = require("node:assert");
const { parseHarkTime, groupRows, conversationTitle, READ_ROWS_JS } = require("../sessions");

test("parses Hark list times", () => {
  assert.strictEqual(parseHarkTime("Wed 2026-10-14 6:08 PM (UTC+08:00)"), "2026-10-14T10:08:00.000Z");
  assert.strictEqual(parseHarkTime("Sun 2026-11-01 12:42 AM (UTC+08:00)"), "2026-10-31T16:42:00.000Z");
});
test("main chat title", () => {
  assert.strictEqual(conversationTitle({ title: null }), "聊天");
  assert.strictEqual(conversationTitle({ title: "AI视频生产线" }), "AI视频生产线");
});
test("groups rows into turns", () => {
  const t = groupRows([
    { id: "a", role: "assistant", text: "欢迎", at: "2026-11-02T01:00:00Z" },
    { id: "u1", role: "user", text: "[附件] probe.txt", at: "2026-11-02T02:00:00Z" },
    { id: "u1b", role: "user", text: "看这个", at: "2026-11-02T02:00:01Z" },
    { id: "h1", role: "assistant", text: "收到", at: "2026-11-02T02:00:05Z" },
    { id: "h2", role: "assistant", text: "[附件] v.zip", at: "" },
    { id: "u2", role: "user", text: "测试", at: "2026-11-02T02:01:00Z" },
  ]);
  assert.strictEqual(t.length, 3);
  assert.strictEqual(t[1].id, "msg:u1");
  assert.strictEqual(t[1].user, "[附件] probe.txt\n看这个");
  assert.strictEqual(t[1].assistant, "收到\n\n[附件] v.zip");
  assert.strictEqual(t[2].assistant, "");
});
test("row reader script compiles", () => {
  assert.doesNotThrow(() => new Function("visible", READ_ROWS_JS));
});
