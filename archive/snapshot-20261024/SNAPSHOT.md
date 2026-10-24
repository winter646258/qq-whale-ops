# 线上源码快照 · 2026-10-24 20:42 CST

抓取方式：`ssh alihz` 上 `tar czf` → `scp` 下载 → 本地解压。
已剔除所有 `*.bak*` / `*.pre-*` / `*.tmp.js` 备份文件；未包含 `state/`（运行时数据，含聊天内容）与 `node_modules/`。

## 一句话

这次快照相对 `bridge.server-20261020-fix2bugs.js`（643KB / 11822 行）最大的变化是**模块化重构**：
`src/bridge.js` 里那条 1450 行的控制台 if 链被拆成 `src/modules/` 下的 28 个功能模块（118 条路由），
并且线上第一次有了 **git 版本控制**。

## 权威坐标

| 项 | 值 |
|---|---|
| 抓取时刻 | 2026-10-24 20:42:00 CST |
| 主机 | `iZbp180y8s00kynoo5wjhoZ`（121.40.52.115） |
| git HEAD | `5c876fad05c57a1e5dacee195e768f19fb4de44f` · 2026-10-24 01:24:50 +0800 · `feat(modular): 阶段6 Token 用量账本整族搬进 tokens 模块` |
| 四服务 | `qq-bridge` / `qq-dsh` / `qq-provider-switch` / `qq-zone-watch` 全部 active，`NRestarts=0` |

## 文件指纹

| 文件 | 字节 | 行数 | sha256 |
|---|---|---|---|
| `src/bridge.js` | 633376 | 11953 | `d3e2f022e15e6f402e37ee0086779facedb4e40e6b266dc656a8bf7d7843e259` |
| `src/mcp-snowluma-safe.js` | 110444 | 1790 | `7f1d9ebf717cb75e5574fb41c5cb2a39e61129d842a5b93672a50480a5a0e5f4` |
| `src/modules/registry.js` | 12151 | 269 | `7b4f9a6300050966bea38e6eef7a3c8e453d57c10e884957dc9580372d96fe3c` |
| `src/modules/index.js` | 2876 | 84 | `64a21a63729da1c77c61ad9e4c4584e1ca83796708ec23f8bfb1b5a98ec4bb83` |
| `docs/模块契约.md` | 11425 | — | `6f634ba6b0218ed76ae76d72bb259ffe1bdeb14a3d8576074f61ac1f7dbbb4af` |
| `src/diary-store.js` | 15185 | — | `7900305d4debc326445600c84e76337c8930c2cff6dd19c5bd8388557104dfb5` |
| `src/mood-store.js` | 20937 | — | `310a3ca5b5c49318a491bf3a25a85646ae9625d41867c9beff5edbfdf476cfac` |

模块代码合计 17479 行（含 `registry.js` / `index.js`）。

## 与 2026-10-23 交接文档的差异

| 项 | 交接文档（10-23 16:40） | 本次（10-24 20:42） |
|---|---|---|
| `src/bridge.js` | 798199 B / 14530 行 | 633376 B / 11953 行 |
| `src/mcp-snowluma-safe.js` | 105290 B | 110444 B / 1790 行 |
| `src/modules/` | 不存在 | 28 模块 / 118 路由 / 37 文件 |
| git | 无（10-24 00:02 才建基线） | HEAD = 阶段6 |
| `state/` | 66 MB | 79 MB |
| `patches/*.py` | 24 个 | 25 个（重构改用 `scripts/patch-modules-stageNN.mjs`） |
| swap 占用 | 830 MB | 1147 MB（内存 1736 MB，可用 531 MB） |

新增源码文件：`src/spotify-client.js`(12714)、`src/qq-model-view.js`(3871)、
`src/modules/**`；`src/diary-store.js` 由 9222 涨到 15185。

## 值得知道的坑（本次快照特有）

1. **git 只提交到「阶段6」，工作区实际已推进到「阶段29」**。
   `git status` 有 16 个 M + 30 多个未跟踪的 `scripts/patch-modules-stage7..29.mjs`。
   也就是说 **HEAD 不是线上状态**，看代码要看工作区，不能 `git show HEAD:src/bridge.js`。
2. `src/.bridge-core.tmp.js`（559855 B）是重构过程中的中间产物，未跟踪、不参与运行。
3. 文档 `docs/模块契约.md` 第 256 行称 bridge.js 降到「10654 行 / 550859 字节」，
   那是 13:49 左右（`bridge.js.bak-v2rest-20261024-134923`）的状态；
   到 16:14 又涨回 11953 行 / 633376 字节（14:29~16:14 之间加了 P0 修复、日记分级、effort 均衡等）。
   **文档里的数字只对当时有效，别当现值引用。**
4. `roles/小鲸鱼.md` 24 日被精简过（17025 → 15809 字节），旧版在 `roles/历史版本/`。
5. 运行时数据（`state/*.json`、`diary/*.jsonl`、`state/images`）**没有进这个快照**，
   其中 `social-v2.json` 是聊天记录、`日记.jsonl` 是她的私人日记，不该进仓库。

## 目录内容

```
snapshot-20261024/
├─ SNAPSHOT.md             ← 本文件
├─ snap-manifest.txt       ← 服务器上自动生成的原始清单（git log / status / sizes）
├─ src/
│  ├─ bridge.js            ← 主进程（11953 行）
│  ├─ mcp-snowluma-safe.js ← MCP 工具面
│  ├─ modules/             ← 28 个功能模块
│  └─ *.js                 ← 32 个 store / client / lib
├─ scripts/                ← golden-routes.mjs、compare-routes.mjs 等回归脚本
├─ docs/                   ← 模块契约.md、README.md、FOLDER_MAP.md
└─ roles/                  ← 小鲸鱼.md（当前版）、傲娇助手.md、历史版本/
```

## 怎么用这份快照

- 只想读懂链路 → 先读 `docs/模块契约.md`，再读 `src/bridge.js` 的消息入站段
  （`post_type` 分支，见本目录下游的分析文档）。
- 想复现线上行为 → 直接替换 `/opt/qq-bridge/src/` 下同名文件；注意**必须先
  `systemctl stop qq-bridge`**，且 `state/` 不能一起覆盖。
- 想跑回归 → `scripts/golden-routes.mjs --out now.json` 抓当前路由表，
  再 `scripts/compare-routes.mjs 旧.json now.json` 对比漂移。
