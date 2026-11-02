const test = require("node:test");
const assert = require("node:assert");
const { harkSplit } = require("../dom_split");

class El {
  constructor(tag, cls = "", text = "", style = {}) { this.tagName = tag.toUpperCase(); this.className = cls; this.children = []; this.parentElement = null; this._t = text; this.style = style; }
  add(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
  get innerText() { return this.textContent; }
  querySelectorAll() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
}
const userRow = (t) => new El("div", "row justify-end").add(new El("div", "bubble user", t));
const harkRow = (t) => new El("div", "row").add(new El("div", "bubble", t));
const env = (body) => ({ document: { body }, getComputedStyle: (e) => e.style });

function page(rows) { const list = new El("div", "list").add(...rows); return new El("body").add(new El("main").add(list)); }

test("stops at a message typed on the computer", () => {
  const body = page([userRow("你好，眼镜插件测试"), harkRow("收到"), userRow("眼镜上显示Agent正在回复"), harkRow("仓库里没有这句话。"), userRow("电脑上打的字"), harkRow("另一个回复")]);
  const r = harkSplit(env(body), "眼镜上显示Agent正在回复", ["你好，眼镜插件测试"]);
  assert.deepStrictEqual(r, { ok: true, text: "仓库里没有这句话。", interrupted: true });
});
test("collects several Hark bubbles", () => {
  const body = page([userRow("a 第一条"), harkRow("x"), userRow("b 第二条"), harkRow("开工"), harkRow("结果在这")]);
  const r = harkSplit(env(body), "b 第二条", ["a 第一条"]);
  assert.strictEqual(r.text, "开工\n\n结果在这");
  assert.strictEqual(r.interrupted, false);
});
test("ambiguous shapes fall back", () => {
  const body = page([harkRow("a 第一条"), harkRow("x"), harkRow("b 第二条"), harkRow("y")]);
  assert.strictEqual(harkSplit(env(body), "b 第二条", ["a 第一条"]).ok, false);
});
test("first message: no list yet, falls back", () => {
  const body = page([userRow("only one"), harkRow("hi")]);
  assert.strictEqual(harkSplit(env(body), "only one", []).ok, false);
});
