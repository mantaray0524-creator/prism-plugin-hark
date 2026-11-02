#!/usr/bin/env node
// 诊断：打开/连上 Hark 页面，列出输入框、按钮和对话区，写到 ~/.prism-hark/probe.txt
const fs = require("fs");
const path = require("path");
const { HarkCdp, HOME_DIR } = require("../hark_cdp");
(async () => {
  const hark = new HarkCdp(console.log);
  const st = await hark.status();
  const info = await hark.evaluate(`
    const desc = (el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className || "").slice(0, 80),
        role: el.getAttribute("role"), aria: el.getAttribute("aria-label"), ph: el.getAttribute("placeholder"),
        testid: el.getAttribute("data-testid"), visible: visible(el), y: Math.round(r.top), text: (el.innerText || "").slice(0, 40) };
    };
    return {
      url: location.href, title: document.title,
      composers: Array.from(document.querySelectorAll("textarea, [contenteditable]")).map(desc),
      buttons: Array.from(document.querySelectorAll("button, [role=button]")).filter(visible).slice(-25).map(desc),
      mains: Array.from(document.querySelectorAll("main, [role=main], [role=log], [aria-live]")).map(desc),
      testids: Array.from(new Set(Array.from(document.querySelectorAll("[data-testid]")).map(e => e.getAttribute("data-testid")))).slice(0, 80),
      transcriptTail: transcriptText().slice(-1500),
    };
  `);
  const out = JSON.stringify({ status: st, ...info }, null, 2);
  const file = path.join(HOME_DIR, "probe.txt");
  fs.writeFileSync(file, out);
  console.log(out);
  console.log(`\n已保存到 ${file}`);
  await hark.close();
  process.exit(0);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
