# Windsurf Switch

> 在 Windsurf 编辑器里**无浏览器、无重启**地丝滑切换多账号 — 跨平台、跨窗口同步、本地加密。

![VSCode](https://img.shields.io/badge/VSCode-Windsurf-007ACC?logo=visualstudiocode)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-success)
![License](https://img.shields.io/badge/license-MIT-blue)

> 截图占位（请替换为实际 sidebar 截图）：
> ```
> docs/screenshot-sidebar.png
> ```

---

## ✨ 它做什么

| | |
|---|---|
| 🎯 **真·无感切号** | 不弹浏览器、不重启窗口、不打断 Cascade 对话或 Terminal — 切完即用 |
| 🪟 **跨窗口同步** | 多个 Windsurf 窗口下，任一窗口切号其他窗口实时更新 |
| 🤖 **智能切号** | 按 Plan / 额度 / 冷却时间自动选最优账号；可配合定时轮询、日志监控 |
| 📦 **共享账号库** | 与桌面版 `windsurf-manager-desktop` 共用同一份 `accounts.json`，可双向编辑 |
| 🔄 **批量管理** | 添加 · 删除 · 批量导入（多种格式） · 一键刷新所有账号 Plan / Quota / 到期 |
| 🛡️ **本地加密** | Windows 用 DPAPI；macOS / Linux 用 AES-256-GCM + 本地密钥；凭据从不外发 |
| 🎨 **现代化 UI** | 卡片式列表 · 进度条配色随余量变化 · 下拉式排序/筛选 · 图标按钮 + 中文 tooltip |

---

## 🚀 安装

### 方式 1 — 从 Releases 下载（推荐）

1. 到 [Releases](https://github.com/illfen/windsurf-switch/releases) 下载最新 `lango.windsurf-switch-X.X.X.vsix`
2. 在 Windsurf 中：`Cmd/Ctrl + Shift + P` → `Extensions: Install from VSIX...`
3. `Reload Window`（VSCode 提示后点一下）
4. 左侧 Activity Bar 会出现 **Windsurf Switch** 图标 → 点开侧栏即可

### 方式 2 — 从源码打包

```bash
git clone https://github.com/illfen/windsurf-switch.git
cd windsurf-switch
npx --yes @vscode/vsce package --no-dependencies
# → 输出 windsurf-switch-X.X.X.vsix
```

> 首次启动扩展会**自动给 Windsurf 核心打补丁**（实现无浏览器切号），无需手动操作。
> Windsurf 升级会覆盖核心，扩展会自动重新打补丁，但需要 `Cmd+Q` 整个退出再开。

---

## 🧩 五分钟上手

| 步骤 | 操作 |
|---|---|
| ① | 点 sidebar 顶部 **`+ 添加`**，输入邮箱 + 密码 → 自动登录并加密入库 |
| ② | 或点 **`批量导入`**，粘贴 `email:password` / `账号: x  密码: y` / JSON / CSV 等任一格式（详见弹窗内说明） |
| ③ | 点账号卡上 ⇆ 切号图标 → **静默切到该账号**，sidebar 顶部"当前账号"区即时刷新 |
| ④ | 想自动用：展开 **自动切号** → 勾选 「轮询 API 检测额度」，没额度时自动选下一个能用的 |

---

## 📐 UI 概览

```
╔════════════════════════════════════════╗
║ Windsurf Switch                  …    ║   ← 标题（… 里有日志/打开数据目录/重新加载）
╠════════════════════════════════════════╣
║ ＋ 添加   批量导入   刷新全部          ║   ← 工具栏
╠════════════════════════════════════════╣
║ 当前账号                               ║
║ ┌────────────────────────────────────┐ ║
║ │ user@x.com                  [Pro]  │ ║   ← 当前卡（accent 描边）
║ │ 日额度 ▰▰▰▰▰▱▱▱ 60%                │ ║
║ │ 重置 56m · 05/02 16:00             │ ║
║ │ 周额度 ▰▰▰▰▰▰▰▱ 80%                │ ║
║ │ 重置 1d 0h · 05/03 16:00           │ ║
║ │ 5天 4小时后到期      [⚡] [↻] [🕐] │ ║   ← 智能切号 / 刷新 / 重置冷却
║ └────────────────────────────────────┘ ║
║                                        ║
║ ▾ 自动切号                             ║
║   ☑ 轮询 API 检测额度    [2 分钟 ▾]    ║
║   ☐ 监控 Windsurf 日志（实验性）       ║
║                                        ║
║ 12 个账号    [↕ 按到期时间 ↑ ▾] [⏚ 筛选 ▾] ║   ← 列表头：计数 + 排序 + 筛选下拉
╠════════════════════════════════════════╣
║ ┌────────────────────────────────────┐ ║
║ │ alice@x.com                [Trial] │ ║
║ │ 日额度 ▰▰▰▰▰▰▰▰ 100%               │ ║
║ │ 周额度 ▰▰▰▰▰▰▱▱ 82%                │ ║
║ │ 7天19小时后到期 [⇆][↻][🔑][🏷][🗑] │ ║   ← 切号/刷新/复制凭据/编辑备注/删除
║ └────────────────────────────────────┘ ║
║ ...                                    ║
╚════════════════════════════════════════╝
```

### 图标速查

| 图标 | 含义 |
|---|---|
| ⇆ | 切到该账号（列表卡） |
| ⚡ | 智能切号（当前账号卡） |
| ↻ | 刷新该账号 Plan / 额度 |
| 🕐 | 重置智能切号冷却（清空 15min 跳过记录） |
| 🔑 | 一键复制 `账号: x   密码: y` 到剪贴板 |
| 🔧 | 补充密码并重登（仅在缺凭据时出现） |
| 🏷 | 编辑备注 |
| 🗑 | 删除账号（不可撤销） |

> 鼠标悬停任何图标 ~120ms 后会显示中文提示。

---

## 📥 批量导入支持的格式

弹窗里有完整说明，简版：

| 类型 | 示例 |
|---|---|
| 分隔符 | `alice@x.com:Pass123` / `bob@x.com  Pwd` / `carol@x.com|MyP@ss` |
| 标签式（可单行/多行，中英冒号都认） | `账号: dave@x.com    密码: 88Dave88` |
| CSV / URL 参数 | `email,password` 或 `email=x&password=y` |
| JSON 数组 | `[{"email":"a","password":"p"}, ...]` |

> 从扩展自带的 🔑 复制按钮拷出来的格式也能直接粘进来导入（即第二种）。

---

## 🤖 智能切号

把"自动切号"展开后可勾选：

- **轮询 API 检测额度**：每 N 分钟（30s / 1 / 2 / 5 / 10 分钟可选）调用 Windsurf 后端 quota API，发现当前账号额度耗尽时自动切到候选池里最优的那个
- **监控 Windsurf 日志（实验性）**：watch Windsurf 进程日志匹配 `quota exceeded` 等关键词触发即时切换

候选池 = 通过当前 **筛选** 条件 + **不在 15min 冷却** 内的账号。
排序方式决定优先级（按到期时间升序时，快到期的优先用掉）。

---

## 🔐 数据存储 / 隐私

| 文件 | 用途 | macOS / Linux | Windows |
|---|---|---|---|
| `accounts.json` | 加密的账号清单 | `~/Library/Application Support/windsurf-manager-desktop/` | `%APPDATA%\windsurf-manager-desktop\` |
| `.cred.key` | AES 主密钥（mac/Linux） | 同上 | — |
| `active.json` | 跨窗口同步当前账号 ID | 同上 | 同上 |

**凭据只存在本地磁盘，扩展不会上传任何账号信息到任何远端。**

可在 sidebar 标题栏 `…` 菜单 → **打开 accounts.json 目录** 查看 / 备份 / 迁移这些文件。

---

## 🌐 平台兼容

| | Windows | macOS | Linux |
|---|:---:|:---:|:---:|
| 加密方式 | DPAPI `ProtectedData` | AES-256-GCM | AES-256-GCM |
| 共享账号库 | ✅ | ✅ | ✅ |
| 无感切号补丁 | ✅ | ✅ | ✅ |
| 跨窗口同步 | ✅ | ✅ | ✅ |

---

## 🛠️ 命令面板

`Cmd/Ctrl + Shift + P` 输入 `Windsurf Switch` 可见所有命令：

- **切换账号 (QuickPick)** / **用 IdToken 切号 (调试)**
- **添加账号** / **批量导入** / **批量刷新** / **重新加载账号列表**
- **打开 accounts.json 目录** / **显示日志**
- **智能切号** / **重置智能切号冷却**
- **给 Windsurf 打补丁** / **恢复 Windsurf** / **查看补丁状态**
- **诊断登录会话 (调试)**

---

## ❓ FAQ

**Q: 切换后 sidebar 显示"未检测到当前账号"？**
A: 通常是 Windsurf 核心补丁尚未生效。补丁在扩展激活时自动写入磁盘，但 Windsurf 主进程需 `Cmd+Q` 整个退出再打开才会重新加载。仍有问题运行 `诊断登录会话` 把 Output 贴上来。

**Q: 切号还会跳浏览器？**
A: Windsurf 升级时覆盖核心 `extension.js` 把补丁擦了。Reload Window 让扩展重新打补丁，再 `Cmd+Q` 重启 Windsurf 即可。

**Q: 桌面版 `windsurf-manager-desktop` 还需要吗？**
A: 不需要。`accounts.json` 本扩展能直接读写。桌面版是历史遗留 GUI，留不留都行。

**Q: 多个 VSCode 窗口的当前账号不同步？**
A: 本扩展用 `<accountsDir>/active.json` + `fs.watch` 做实时跨窗口同步，毫秒级。如果失效请确认两个窗口都装了本扩展。

**Q: 进度条颜色阈值？**
A: 余量 > 60% 绿、20%~60% 黄、≤ 20% 红。

---

## 🧱 项目结构

```
windsurf-switch/
├── out/                      # 运行时 JS（webview UI / 命令处理 / 解析器都在这里）
│   ├── extension.js          # 命令注册 / 跨窗口同步 / 主流程
│   ├── sidebar.js            # webview UI（CSS + HTML + 前端 JS 全在此）
│   ├── windsurfApi.js        # Firebase / Auth1 登录 + Quota API
│   ├── windsurfPatcher.js    # 给 Windsurf 核心打补丁
│   ├── importParser.js       # 批量导入文本解析
│   ├── accountsStore.js      # 加密账号库读写
│   └── ...
├── resources/
│   └── icon.svg              # Activity Bar 图标
├── package.json              # 扩展 manifest
├── LICENSE
└── README.md
```

> 当前仓库直接维护 `out/` 下的 JavaScript（webview / 解析器 / 命令处理可以零依赖直接改）。
> 如有需要会在后续版本恢复 TypeScript 源码与构建链。

---

## 🤝 贡献

欢迎 issue / PR：

- 复现问题请附上 `…` → **显示日志** 里的 Output 内容
- 改动 UI 请同时上传修改前后截图
- 改动 parser 请同时加测试用例

---

## 📋 已知限制

- Windsurf 升级会覆盖核心，需要扩展自动重新打补丁 + 一次 `Cmd+Q` 重启
- 扩展只识别 Firebase / Auth1 两种登录路径（覆盖 99% 场景）
- 部分账号 Plan 信息在切号瞬间可能延迟 1~2 秒刷新

---

## 🙏 致谢

灵感与早期实现思路来自 [`aliu.windsurf-pro`](https://github.com/) 项目。本仓库在其基础上重做了 sidebar UI、批量导入、智能切号、跨窗口同步等模块，并改名为 **Windsurf Switch**。

---

## 📜 协议

[MIT](LICENSE) © 2026 illfen
