# prism-plugin-hark（v0.1.0）

在 Rokid 眼镜上用语音和 Hark 对话。

```
眼镜（Prism 棱镜面板）→ Prism 云 → Mac 上的 Prism Hub → 本插件 → 专用 Chrome → app.hark.com
```

Hark 没有 Mac 版 app，也没有公开对话 API，所以插件**开一个专用 Chrome 窗口**，替你在 Hark 网页里打字、读回复。

---

## 安装（大约 5 分钟）

**1. 解压**到一个固定的位置，比如 `~/prism-plugins/prism-plugin-hark`。

**2. 先不经过眼镜，测一下**（Mac 终端里）：

```bash
cd ~/prism-plugins/prism-plugin-hark
node scripts/try-chat.js "你好，这是眼镜插件的测试"
```

- 第一次会弹出一个**新的 Chrome 窗口**（独立配置，和你平时的 Chrome 分开）。
- 如果它停在登录页：**在这个窗口里登录 Hark**，然后再跑一次上面的命令。
- 看到 `[run.completed]` 和 Hark 的回复，就说明通了。

**3. 装进 Prism Hub**：打开 Hub → **插件管理** → 输入框里填这个文件夹的**完整路径** → **安装**。

**4. 眼镜上**："打开棱镜面板"，Agent 列表里会出现 **Hark**，进去就能说话。

> 需要 Node 22（Hub 自带的 Node 22 也行）。Chrome 要装在 `/Applications/Google Chrome.app`。

---

## 用的时候要知道

- **专用 Chrome 窗口别关**，可以最小化。Mac 不能睡眠。
- 眼镜上看到的是**你从眼镜发的那几轮对话**；Hark 网页里当前打开的是哪个对话，消息就发到哪里。
- **卡片会变成纯文字**。付款按钮、登录表单这类，还是要回手机点。
- Hark 先回一句"开工"、几分钟后才给结果，是正常的：后面的内容会**继续更新到眼镜上**（最长跟 15 分钟）。
- 眼镜没有语音播报，这是棱镜面板本身的限制。

---

## 出问题时

**先跑诊断：**

```bash
node scripts/probe.js
```

它会把 Hark 页面的输入框、按钮、对话区信息写到 `~/.prism-hark/probe.txt`。**把这个文件发给 Hark**，我按它改选择器。

**改选择器不用改代码**：新建 `~/.prism-hark/config.json`：

```json
{
  "selectors": {
    "composer": "textarea",
    "sendButton": "button[aria-label='Send']",
    "transcript": "main",
    "busy": ""
  },
  "stableMs": 12000
}
```

| 配置 | 意思 |
| --- | --- |
| `composer` | 输入框 |
| `sendButton` | 发送按钮；留空 = 按回车 |
| `transcript` | 对话区（逗号分隔，按优先级） |
| `busy` | Hark"正在输入"时才出现的元素（可选） |
| `stableMs` | 回复多久不变算说完（毫秒） |
| `cdpPort` | Chrome 调试端口，默认 9333 |
| `chromePath` | Chrome 路径 |

日志：`~/.prism-hark/plugin.log`。眼镜对话记录：`~/.prism-hark/history.json`。

---

## 文件

| 文件 | 作用 |
| --- | --- |
| `pluginbridge-plugin.yaml` | 插件 manifest（已过 SDK schema 校验） |
| `index.js` | PluginBridge 适配器：会话、发送、等回复、历史流、事件 |
| `hark_cdp.js` | 启动/连接 Chrome，操作 Hark 网页，提取回复 |
| `scripts/try-chat.js` | 不经过 Prism 的命令行测试 |
| `scripts/probe.js` | 页面诊断 |
| `test/` | 单元测试 + 模拟 Hark 页面 |

MIT License.

## v0.1.3（2026-11-02）
- 发送改为三重兜底：点发送按钮（等它可用，认不出就找输入框旁最后一个按钮）→ 回车 → DOM 点击/表单提交。
- 发送失败时把输入框附近的 HTML 写进 ~/.prism-hark/plugin.log（"send failed" 行），方便修选择器。

## v0.1.2（2026-11-01）
- 安装包补回 node_modules（v0.1.1 漏打，插件启动即崩溃，Hub 显示 runtime closed）。

## v0.1.1（2026-11-01）
- 电脑上打的字不再算成 Hark 的回复：按消息行切分，遇到你的下一条消息就收尾（认不出页面结构时退回旧的文字切法）。
- 眼镜发新消息时，上一轮自动结束，不会卡住语音输入。
- 插件进程遇到异常只记日志、不退出（避免眼镜上出现 IPC/RPC 失败）。
- 可选：`~/.prism-hark/config.json` 里 `selectors.userRow` 指定“你的消息”元素。
