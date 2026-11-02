#!/usr/bin/env node
// 诊断 2（多会话用）：打开 Hark 的「项目抽屉」，列出里面的项目/对话；记录页面用过的 API 路径；找消息滚动区结构。
// 只会点「打开项目抽屉」按钮并按 Esc 关闭，不发送任何消息。结果写到 ~/.prism-hark/probe-sessions2.txt
const fs = require("fs");
const path = require("path");
const { HarkCdp, HOME_DIR } = require("../hark_cdp");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HELPERS = `
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const short = (s, n) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const attrs = (el) => { const o = {}; for (const a of el.attributes) if (/^(data-|aria-|role|href|id$)/.test(a.name)) o[a.name] = short(a.value, 120); return o; };
  const desc = (el) => ({ tag: el.tagName.toLowerCase(), cls: short(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className, 60), ...attrs(el), vis: visible(el), ...box(el), text: short(el.innerText, 80) });
`;
(async () => {
  const hark = new HarkCdp(console.log);
  const out = { status: await hark.status() };

  out.before = await hark.evaluate(`${HELPERS}
    const ls = {};
    for (const k of Object.keys(localStorage)) if (/project|conversation|chat|thread|last/i.test(k)) ls[k] = short(localStorage.getItem(k), 1500);
    const api = Array.from(new Set(performance.getEntriesByType("resource").map((e) => e.name)
      .filter((u) => /hark\\.com/.test(u) && !/\\.(js|css|png|jpg|svg|woff2?|webp)(\\?|$)/.test(u))
      .map((u) => { try { const x = new URL(u); return x.host + x.pathname; } catch (_) { return u; } }))).slice(0, 80);
    const btns = Array.from(document.querySelectorAll("button, [role=button], [role=tab], a")).filter(visible).slice(0, 60).map(desc);
    return { url: location.href, ls, api, btns };
  `);

  out.clicked = await hark.evaluate(`
    const b = document.querySelector('[aria-label="打开项目抽屉"], [aria-label*="抽屉"], [aria-label*="drawer" i]')
      || Array.from(document.querySelectorAll("button, [role=button], [role=tab]")).find((e) => visible(e) && ((e.getAttribute("aria-label") || "").trim() === "项目" || (e.innerText || "").trim() === "项目"));
    if (!b) return "no drawer button";
    b.click(); return "clicked: " + b.getAttribute("aria-label");
  `);
  await sleep(1500);

  out.drawer = await hark.evaluate(`${HELPERS}
    const cands = Array.from(document.querySelectorAll('[role=dialog], aside, nav, [aria-modal], [data-state=open], [class*=drawer i]')).filter(visible);
    const root = cands.sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length)[0];
    if (!root) return { found: false, bodyText: short(document.body.innerText, 1500) };
    const items = Array.from(root.querySelectorAll("a, button, [role=button], [role=link], [role=option], [role=listitem], li"))
      .filter(visible).slice(0, 80).map(desc);
    return { found: true, root: desc(root), text: short(root.innerText, 2000), items, html: short(root.outerHTML, 3000) };
  `);

  await hark.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
  await sleep(500);

  out.transcript = await hark.evaluate(`${HELPERS}
    const scrollers = Array.from(document.querySelectorAll("*")).filter((e) => {
      const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 50 && visible(e);
    }).sort((a, b) => b.scrollHeight - a.scrollHeight).slice(0, 3);
    return scrollers.map((sc) => {
      let list = sc;
      for (let i = 0; i < 10 && list.children.length < 4 && list.firstElementChild; i++) list = list.children.length === 1 ? list.firstElementChild : Array.from(list.children).sort((a, b) => b.children.length - a.children.length)[0];
      const rows = Array.from(list.children);
      const row = (el) => ({ ...desc(el), align: getComputedStyle(el).justifyContent + "/" + getComputedStyle(el).alignItems + "/" + getComputedStyle(el).textAlign, html: short(el.outerHTML, 500) });
      return { scroller: desc(sc), scrollH: sc.scrollHeight, list: desc(list), rowCount: rows.length, last: rows.slice(-6).map(row) };
    });
  `);

  const text = JSON.stringify(out, null, 2);
  const file = path.join(HOME_DIR, "probe-sessions2.txt");
  fs.writeFileSync(file, text);
  console.log(`\n✅ 已保存到 ${file}（${text.length} 字）`);
  await hark.close();
  process.exit(0);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
