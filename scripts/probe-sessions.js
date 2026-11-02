#!/usr/bin/env node
// 诊断（多会话用）：列出 Hark 页面里的会话/项目链接和消息行结构，写到 ~/.prism-hark/probe-sessions.txt
// 只读，不点击、不发送。
const fs = require("fs");
const path = require("path");
const { HarkCdp, HOME_DIR } = require("../hark_cdp");
(async () => {
  const hark = new HarkCdp(console.log);
  const st = await hark.status();
  const info = await hark.evaluate(`
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    const short = (s, n) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
    const desc = (el) => ({ tag: el.tagName.toLowerCase(), cls: short(el.className, 80), role: el.getAttribute("role"),
      aria: el.getAttribute("aria-label"), current: el.getAttribute("aria-current") || el.getAttribute("aria-selected") || el.getAttribute("data-active"),
      testid: el.getAttribute("data-testid"), visible: visible(el), ...box(el), text: short(el.innerText, 60) });
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: a.getAttribute("href"), ...desc(a) }));
    const clickables = Array.from(document.querySelectorAll("nav *, aside *, [role=navigation] *, [role=listitem], [role=option], [role=tab], [role=menuitem]"))
      .filter((e) => (e.onclick || e.getAttribute("role") || e.tagName === "BUTTON") && visible(e)).slice(0, 80).map(desc);
    const navs = Array.from(document.querySelectorAll("nav, aside, header, [role=navigation], [role=tablist]")).map(desc);
    const root = preferred(SEL.transcript) || document.querySelector("main") || document.body;
    let list = root;
    for (let i = 0; i < 8 && list.children.length === 1; i++) list = list.children[0];
    const rows = Array.from(list.children);
    const rowInfo = (el) => ({ ...desc(el), align: getComputedStyle(el).justifyContent + "/" + getComputedStyle(el).alignItems,
      firstChild: el.firstElementChild ? short(el.firstElementChild.className, 80) : "", html: short(el.outerHTML, 400) });
    return {
      url: location.href, path: location.pathname, title: document.title,
      localStorageKeys: Object.keys(localStorage).slice(0, 40),
      navs, links: links.slice(0, 120), clickables,
      transcript: { rootTag: root.tagName, listCls: short(list.className, 120), rowCount: rows.length,
        firstRows: rows.slice(0, 3).map(rowInfo), lastRows: rows.slice(-6).map(rowInfo) },
    };
  `);
  const out = JSON.stringify({ status: st, ...info }, null, 2);
  const file = path.join(HOME_DIR, "probe-sessions.txt");
  fs.writeFileSync(file, out);
  console.log(`\n✅ 已保存到 ${file}（${out.length} 字）`);
  await hark.close();
  process.exit(0);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
