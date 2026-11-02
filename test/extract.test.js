const test = require("node:test");
const assert = require("node:assert");
const { extractReply } = require("../hark_cdp");
test("reply after last occurrence of sent text", () => {
  const raw = "Chat\n你好\n明天天气\n旧回复\n明天天气\n多云 27 度\nCopy\n";
  assert.strictEqual(extractReply(raw, "明天天气"), "多云 27 度");
});
test("whitespace-insensitive fallback", () => {
  const raw = "a\n帮我  订\n明天的位子\n好的，几点？";
  assert.strictEqual(extractReply(raw, "帮我 订 明天的位子"), "好的，几点？");
});
test("empty when no reply yet", () => {
  assert.strictEqual(extractReply("x\nhello", "hello"), "");
});
