# 路由 × 鉴权检查矩阵（自动生成，只读）

源文件：`/opt/qq-bridge/src/bridge.js`

- 路径判断总数：**151**
- 落在多少行：**137**
- 精确匹配 `===`：**135**
- 前缀匹配 `startsWith`：**16**

## 集中闸门（都在 `main()` 里，路由分发之前）

- `G1_host` Host 校验（回环/绑定端口）
- `G2_console450` consoleToken 401（除 /api/phone/* 豁免）
- `G3_agentcall` x-agent-call 存在则必须 isLiveAgentToken（403）
- `G4_json` 非 GET 必须 application/json（415）
- `G5_origin` 带 Origin 必须同源（403）
- `G6_emptytok` x-agent-token 空串拒绝（403）
- `G7_paused` socialV2.paused 时 v2 路径拒绝（403）
- `G8_disabled` socialV2.enabled=false 时 v2 路径拒绝（403）
- `G9_reserved2` 带 agent token 的 /api/socialV2/* 必须 reserved2（403）
- `G10_adminOnly` adminOnlyV2Paths 等仅控制台（403）
- `G11_stickers` /api/stickers* 仅控制台（403）
- `G12_defaultDeny` 带 agent token 时白名单外一律 403

> **关键结论**：这 12 道闸门是**集中式**的，都写在路由 if 链之前，所以「每条路由各自有没有写鉴权」不是主要风险面——风险在**每条路由内部的**`agentTokenOk` / `v2ToolEnabled` / `v2SessionAllowed` 用没用、用对没有。

## 前缀路由（顺序敏感，必须固化成显式优先级）

| # | 行号 | 前缀 | 内部检查 |
|---|---|---|---|
| 1 | L4665 | `/api/phone/` | agentTokenOk, phoneTokenOk, adminToken |
| 2 | L4684 | `/api/phone/` | agentTokenOk, adminToken |
| 3 | L4737 | `/api/socialV2/` | adminToken |
| 4 | L4737 | `/api/send/` | adminToken |
| 5 | L4737 | `/api/images/` | adminToken |
| 6 | L4742 | `/api/socialV2/` | adminToken |
| 7 | L4742 | `/api/send/` | adminToken |
| 8 | L4742 | `/api/images/` | adminToken |
| 9 | L4747 | `/api/socialV2/` | adminToken |
| 10 | L4758 | `/api/stickers/` | — |
| 11 | L4767 | `/api/socialV2/` | — |
| 12 | L4768 | `/api/send/` | — |
| 13 | L4769 | `/api/images/` | — |
| 14 | L7368 | `/api/phone/` | agentTokenOk, v2SessionAllowed, v2ToolEnabled, phoneTokenOk |
| 15 | L7378 | `/api/phone/` | agentTokenOk, v2SessionAllowed, v2ToolEnabled, phoneTokenOk |
| 16 | L8340 | `/api/tokens/` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |

## 全部路由

| 行号 | 方式 | 路径 | 内部检查 |
|---|---|---|---|
| L4646 | 精确 | `/favicon.ico` | agentTokenOk, phoneTokenOk |
| L4646 | 精确 | `/apple-touch-icon.png` | agentTokenOk, phoneTokenOk |
| L4665 | 前缀 | `/api/phone/` | agentTokenOk, phoneTokenOk, adminToken |
| L4684 | 前缀 | `/api/phone/` | agentTokenOk, adminToken |
| L4686 | 精确 | `/` | agentTokenOk, adminToken |
| L4737 | 前缀 | `/api/socialV2/` | adminToken |
| L4737 | 前缀 | `/api/send/` | adminToken |
| L4737 | 前缀 | `/api/images/` | adminToken |
| L4742 | 前缀 | `/api/socialV2/` | adminToken |
| L4742 | 前缀 | `/api/send/` | adminToken |
| L4742 | 前缀 | `/api/images/` | adminToken |
| L4747 | 前缀 | `/api/socialV2/` | adminToken |
| L4753 | 精确 | `/api/socialV2/feedback` | adminToken |
| L4753 | 精确 | `/api/socialV2/tool-log` | adminToken |
| L4758 | 精确 | `/api/stickers` | — |
| L4758 | 前缀 | `/api/stickers/` | — |
| L4766 | 精确 | `/api/status` | — |
| L4767 | 前缀 | `/api/socialV2/` | — |
| L4768 | 前缀 | `/api/send/` | — |
| L4769 | 前缀 | `/api/images/` | — |
| L4770 | 精确 | `/api/authorize/read` | — |
| L4776 | 精确 | `/` | — |
| L4785 | 精确 | `/api/status` | — |
| L4821 | 精确 | `/api/presets` | — |
| L4830 | 精确 | `/api/mode` | — |
| L4887 | 精确 | `/api/role` | — |
| L4906 | 精确 | `/api/role-mode` | — |
| L4916 | 精确 | `/api/roles` | — |
| L4929 | 精确 | `/api/roles/content` | — |
| L4948 | 精确 | `/api/roles/limit` | — |
| L4961 | 精确 | `/api/roles/create` | — |
| L4972 | 精确 | `/api/roles/update` | — |
| L4983 | 精确 | `/api/roles/rename` | — |
| L4999 | 精确 | `/api/roles/delete` | — |
| L5014 | 精确 | `/api/preset/sim-prompt` | — |
| L5032 | 精确 | `/api/preset/sim-prompt` | — |
| L5081 | 精确 | `/api/preset/sim-prompt/backups` | — |
| L5089 | 精确 | `/api/preset/sim-prompt/restore` | — |
| L5123 | 精确 | `/api/slang` | — |
| L5129 | 精确 | `/api/slang` | — |
| L5151 | 精确 | `/api/slang/clear` | — |
| L5176 | 精确 | `/api/slang/batch-delete` | — |
| L5203 | 精确 | `/api/slang/batch-confirm` | — |
| L5238 | 精确 | `/api/slang/batch-reject` | — |
| L5327 | 精确 | `/api/slang/extract` | — |
| L5342 | 精确 | `/api/slang/research` | — |
| L5354 | 精确 | `/api/slang/config` | — |
| L5391 | 精确 | `/api/sessions` | — |
| L5400 | 精确 | `/api/pending` | — |
| L5415 | 精确 | `/api/whitelist` | — |
| L5419 | 精确 | `/api/whitelist` | — |
| L5457 | 精确 | `/api/dsh/model` | — |
| L5504 | 精确 | `/api/dsh/effort` | — |
| L5523 | 精确 | `/api/security` | — |
| L5540 | 精确 | `/api/security` | — |
| L5562 | 精确 | `/api/console/token` | — |
| L5594 | 精确 | `/api/test-send` | — |
| L5616 | 精确 | `/api/social/state` | — |
| L5636 | 精确 | `/api/social` | — |
| L5648 | 精确 | `/api/social` | — |
| L5694 | 精确 | `/api/social/flush` | — |
| L5701 | 精确 | `/api/console/notify-ai` | — |
| L5771 | 精确 | `/api/socialV2/config` | — |
| L5775 | 精确 | `/api/socialV2/config` | — |
| L5961 | 精确 | `/api/socialV2/activity` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L5965 | 精确 | `/api/socialV2/activity` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L5983 | 精确 | `/api/socialV2/reset` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6024 | 精确 | `/api/socialV2/state` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6043 | 精确 | `/api/socialV2/prompt` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6159 | 精确 | `/api/socialV2/unread` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6181 | 精确 | `/api/socialV2/recent` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6197 | 精确 | `/api/socialV2/mark-read` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6243 | 精确 | `/api/socialV2/spotify` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6300 | 精确 | `/api/socialV2/qzone` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6381 | 精确 | `/api/socialV2/wake-config` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6534 | 精确 | `/api/socialV2/states` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6550 | 精确 | `/api/socialV2/wake` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6580 | 精确 | `/api/socialV2/send-burst` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6704 | 精确 | `/api/socialV2/send-message` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6854 | 精确 | `/api/socialV2/send-poke` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6951 | 精确 | `/api/socialV2/sticker-image` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L6986 | 精确 | `/api/socialV2/self-image` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7003 | 精确 | `/api/socialV2/sticker-note` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7021 | 精确 | `/api/socialV2/sticker-remark` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7043 | 精确 | `/api/voice/send` | — |
| L7043 | 精确 | `/api/send/voice` | — |
| L7053 | 精确 | `/api/send/voice` | — |
| L7158 | 精确 | `/api/socialV2/mood` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7233 | 精确 | `/api/socialV2/image` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7331 | 精确 | `/api/socialV2/image-approval` | phoneTokenOk |
| L7368 | 前缀 | `/api/phone/` | agentTokenOk, v2SessionAllowed, v2ToolEnabled, phoneTokenOk |
| L7378 | 前缀 | `/api/phone/` | agentTokenOk, v2SessionAllowed, v2ToolEnabled, phoneTokenOk |
| L7384 | 精确 | `/api/phone/poll` | agentTokenOk, v2SessionAllowed, v2ToolEnabled, phoneTokenOk |
| L7394 | 精确 | `/api/phone/result` | agentTokenOk, v2SessionAllowed, v2ToolEnabled, phoneTokenOk |
| L7406 | 精确 | `/api/phone/status` | agentTokenOk, v2SessionAllowed, v2ToolEnabled, phoneTokenOk |
| L7422 | 精确 | `/api/socialV2/schedule` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7422 | 精确 | `/api/socialV2/portrait` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7551 | 精确 | `/api/socialV2/diary/migrate` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7581 | 精确 | `/api/socialV2/diary` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7581 | 精确 | `/api/socialV2/album` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7768 | 精确 | `/api/socialV2/send-voice` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7833 | 精确 | `/api/socialV2/send-sticker` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7940 | 精确 | `/api/socialV2/collect-sticker` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7988 | 精确 | `/api/socialV2/voices` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L7988 | 精确 | `/api/voice/list` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8033 | 精确 | `/api/socialV2/sticker-list` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8056 | 精确 | `/api/socialV2/sticker-list` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8084 | 精确 | `/api/stickers` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8098 | 精确 | `/api/stickers/sync` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8107 | 精确 | `/api/stickers/note` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8119 | 精确 | `/api/stickers/remark` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8131 | 精确 | `/api/socialV2/wait` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8306 | 精确 | `/api/socialV2/check-send` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8340 | 精确 | `/api/tokens/summary` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8340 | 前缀 | `/api/tokens/` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8342 | 精确 | `/api/tokens/summary` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8347 | 精确 | `/api/tokens/series` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8353 | 精确 | `/api/tokens/turns` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8361 | 精确 | `/api/tokens/recent` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8366 | 精确 | `/api/tokens/reset` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8376 | 精确 | `/api/socialV2/tool-log` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8381 | 精确 | `/api/socialV2/tool-log/clear` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8389 | 精确 | `/api/socialV2/feedback` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8393 | 精确 | `/api/socialV2/feedback-clear` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8400 | 精确 | `/api/socialV2/feedback` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8431 | 精确 | `/api/socialV2/my-recent` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8443 | 精确 | `/api/socialV2/record-sent` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8448 | 精确 | `/api/socialV2/message-detail` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8499 | 精确 | `/api/socialV2/forward-message` | agentTokenOk, v2ToolEnabled |
| L8591 | 精确 | `/api/socialV2/forward-media` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8610 | 精确 | `/api/socialV2/active-members` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8642 | 精确 | `/api/socialV2/bili` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8736 | 精确 | `/api/socialV2/share-signal` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L8877 | 精确 | `/api/socialV2/shared-memory` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L9053 | 精确 | `/api/socialV2/memory-append` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L9070 | 精确 | `/api/socialV2/memory-update` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L9136 | 精确 | `/api/socialV2/memory` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L9162 | 精确 | `/api/socialV2/memory-remove` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L9188 | 精确 | `/api/socialV2/memory-clear` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L9206 | 精确 | `/api/socialV2/slang/query` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L9229 | 精确 | `/api/socialV2/slang/submit` | agentTokenOk, v2SessionAllowed, v2ToolEnabled |
| L9286 | 精确 | `/api/authorize/read` | agentTokenOk, v2ToolEnabled |
| L9309 | 精确 | `/api/images/message` | agentTokenOk, v2ToolEnabled |
| L9358 | 精确 | `/api/send/group` | agentTokenOk, v2ToolEnabled |
| L9358 | 精确 | `/api/send/private` | agentTokenOk, v2ToolEnabled |
| L9358 | 精确 | `/api/send/reply` | agentTokenOk, v2ToolEnabled |
| L9361 | 精确 | `/api/send/private` | agentTokenOk, v2ToolEnabled |
| L9362 | 精确 | `/api/send/reply` | agentTokenOk, v2ToolEnabled |
| L9484 | 精确 | `/api/session/reset` | — |
| L9539 | 精确 | `/api/workspace/reset` | — |
| L9606 | 精确 | `/api/restart` | — |

## 疑似缺口

### `/api/socialV2/*` 里没有 `v2ToolEnabled` 检查的（9 条）

- L4737 `/api/socialV2/`
- L4742 `/api/socialV2/`
- L4747 `/api/socialV2/`
- L4753 `/api/socialV2/feedback`
- L4753 `/api/socialV2/tool-log`
- L4767 `/api/socialV2/`
- L5771 `/api/socialV2/config`
- L5775 `/api/socialV2/config`
- L7331 `/api/socialV2/image-approval`

### `/api/socialV2/*` 里没有 `v2SessionAllowed` 检查的（10 条）

- L4737 `/api/socialV2/`
- L4742 `/api/socialV2/`
- L4747 `/api/socialV2/`
- L4753 `/api/socialV2/feedback`
- L4753 `/api/socialV2/tool-log`
- L4767 `/api/socialV2/`
- L5771 `/api/socialV2/config`
- L5775 `/api/socialV2/config`
- L7331 `/api/socialV2/image-approval`
- L8499 `/api/socialV2/forward-message`
