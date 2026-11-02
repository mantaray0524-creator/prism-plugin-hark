#!/usr/bin/env node
// 诊断 3（多会话用）：只读。用页面自己的登录态 GET Hark 的 /api/conversations 等接口，记录返回结构（长字符串截断）；
// 再抓最后几条消息气泡的 HTML，找区分「用户 / Hark」的标记。不点击、不发送。结果写到 ~/.prism-hark/probe-sessions3.txt
const fs = require("fs");
const path = require("path");
const { HarkCdp, HOME_DIR } = require("../hark_cdp");
(async () => {
  const hark = new HarkCdp(console.log);
  const out = { status: await hark.status() };
  out.api = await hark.evaluate(`
    const shape = (v, d) => {
      if (d > 5) return "…";
      if (Array.isArray(v)) return { _array: v.length, first: v.slice(0, 3).map((x) => shape(x, d + 1)) };
      if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).slice(0, 40)) o[k] = shape(v[k], d + 1); return o; }
      if (typeof v === "string") return v.length > 120 ? v.slice(0, 120) + "…(" + v.length + ")" : v;
      return v;
    };
    const get = async (p) => {
      try {
        const r = await fetch(p, { credentials: "include", headers: { accept: "application/json" } });
        const t = await r.text();
        let body; try { body = shape(JSON.parse(t), 0); } catch (_) { body = t.slice(0, 400); }
        return { path: p, status: r.status, type: r.headers.get("content-type"), body };
      } catch (e) { return { path: p, error: String(e) }; }
    };
    return (async () => {
      const pid = (location.pathname.match(/\\/project\\/([^/?#]+)/) || [])[1] || "";
      const paths = ["/api/conversations", "/api/conversations/status"];
      if (pid) paths.push("/api/conversations/" + pid, "/api/conversations/" + pid + "/messages", "/api/conversations/" + pid + "/messages?limit=5", "/api/conversations/" + pid + "/history");
      const res = [];
      for (const p of paths) res.push(await get(p));
      return { pathname: location.pathname, res };
    })();
  `);
  out.bubbles = await hark.evaluate(`
    const rows = Array.from(document.querySelectorAll("[data-transcript-row]")).slice(-6);
    return rows.map((r) => {
      const c = r.cloneNode(true);
      c.querySelectorAll("svg, img").forEach((e) => e.remove());
      return { text: (r.innerText || "").replace(/\\s+/g, " ").slice(0, 60), html: c.outerHTML.replace(/>([^<]{40})[^<]+</g, ">$1…<").slice(0, 2500) };
    });
  `);
  const text = JSON.stringify(out, null, 2);
  const file = path.join(HOME_DIR, "probe-sessions3.txt");
  fs.writeFileSync(file, text);
  console.log(`\n✅ 已保存到 ${file}（${text.length} 字）`);
  await hark.close();
  process.exit(0);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
