#!/usr/bin/env node
// 不经过 Prism，直接测试：node scripts/try-chat.js "帮我看看明天天气"
const { adapter } = require("../index.js");
(async () => {
  const text = process.argv.slice(2).join(" ") || "你好，这是一条来自眼镜插件的测试消息";
  const cap = await adapter.probe();
  if (!cap.Available) {
    console.log("❌ Hark 还没准备好：", cap.UnavailableReason);
    console.log("   如果是 login_required：在弹出的 Chrome 窗口里登录 Hark，再跑一次。");
    process.exit(1);
  }
  console.log("✅ 已连上 Hark 页面，发送：", text);
  const sess = await adapter.attachSession({});
  const r = await adapter.send(sess, { PrismMessageID: "cli", Text: text, SourceDevice: "cli", Timestamp: new Date().toISOString(), Metadata: {} });
  const ev = await adapter.waitForRun(sess, r.NativeMessageID);
  console.log(`\n[${ev.Type}]\n${ev.Summary}\n`);
  await adapter.close();
  process.exit(0);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
