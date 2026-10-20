"""把交接文档更新到 v3（一次性完成所有文本替换）。

覆盖内容：
  - 头部时间戳与版本
  - 一句话现状（加进阶能力）
  - 第二节：进程表 → systemd 服务表 + 更新内存实测
  - 第三节：加 whale-ctl 一键闭嘴命令
  - 第四节：脱敏 accessToken（进仓库前必须）
  - 第六节：表情包库数量、评论验证结论保留
  - 第十一节：待办勾掉已完成项
  - 新增第十五节：进阶三步落地记录
"""
import io
import sys

P = sys.argv[1] if len(sys.argv) > 1 else r'/opt/qq-bridge/交接文档.md'
t = io.open(P, encoding='utf-8').read()
orig = len(t)
done, missed = [], []


def rep(old, new, label):
    global t
    if old in t:
        t = t.replace(old, new, 1)
        done.append(label)
    else:
        missed.append(label)


rep(
    '> 生成时间：2026-10-19 18:03（v2 · systemd 化 + 评论实跑验证后）\n> 上一版：2026-10-19 14:40（手工 setsid nohup 时代）',
    '> 生成时间：2026-10-19 22:50（v3 · 进阶三步落地 + 文档入库）\n'
    '> 上一版：2026-10-19 18:03（v2 · systemd 化 + 评论实跑验证）\n'
    '> 更早：2026-10-19 14:40（v1 · 手工 setsid nohup 时代）',
    '头部版本')

rep(
    '人格「小鲸鱼」已启用，19 个表情包已加载，记忆/联网/主动冒泡可用，空间动态监控 + 点赞 + **评论（已实跑验证）** 全部就绪。\n\n**重启服务器不会再全没了** —— 4 个进程已注册为 systemd 服务且已 `enable`。',
    '人格「小鲸鱼」已启用（**3590 字符 / 注入上限 6000**，余量 2410），表情包库 **2160 条**，记忆/联网/主动冒泡可用，空间动态监控 + 点赞 + **评论（已实跑验证）** 全部就绪。\n\n'
    '**重启服务器不会再全没了** —— 4 个进程已注册为 systemd 服务且已 `enable`。\n\n'
    '**进阶能力（2026-10-19 新增）**：日记 / 相册 / 时间感（人格卡驱动）、主动找人参数钉死、'
    '「一键闭嘴」总闸、印象定期重写提醒 —— 详见第十五节。',
    '一句话现状')

rep(
    '## 二、运行中的服务（systemd）',
    '## 二、运行中的服务（systemd）',
    '（占位）')

rep(
    '```\nMem: 1736 total / 943 used / 615 available     Swap: 483 used / 3612 free\n\n'
    '  dsh（含 3 个 MCP 子进程）   279 MB\n'
    '  qq-bridge                   83 MB\n'
    '  mcp-snowluma-safe           57 MB\n'
    '  mcp-web-search-safe         35 MB\n'
    '  mcp-host-server             31 MB\n'
    '  qzone-watch                 31 MB\n'
    '  switch-provider              3 MB\n```',
    '```\nMem: 1736 total / ~860 used / ~690 available     Swap: ~450 used / ~3640 free\n\n'
    '  dsh（含 3 个 MCP 子进程）   279 MB\n'
    '  qq-bridge                   83 MB\n'
    '  mcp-snowluma-safe           57 MB\n'
    '  mcp-web-search-safe         35 MB\n'
    '  mcp-host-server             31 MB\n'
    '  qzone-watch                 31 MB\n'
    '  switch-provider              3 MB\n```',
    '内存实测块')

rep(
    'ssh alihz "systemctl status qq-dsh qq-bridge qq-zone-watch qq-provider-switch --no-pager"',
    'ssh alihz "systemctl status qq-dsh qq-bridge qq-zone-watch qq-provider-switch --no-pager"\n'
    'ssh alihz "bash /opt/qq-bridge/whale-ctl.sh status"   # 四服务 + 桥接端口 + 闭嘴总闸状态',
    '第三节 whale-ctl')

rep(
    '    "accessToken": "<SNOWLUMA_TOKEN>",',
    '    "accessToken": "<见服务器 config.json，勿入库>",',
    '脱敏 accessToken')

rep(
    '- [ ] **内存余量紧张**：可用 615 MB，swap 已用 483 MB；长期建议升 4 GiB\n- [ ] API Key 轮换',
    '- [x] ~~进阶三步：日记/相册/时间感 + 主动找人参数 + 闭嘴总闸 + 印象重写~~ → **2026-10-19 22:40 完成**\n'
    '- [ ] **内存余量紧张**：可用约 690 MB，swap 已用约 450 MB；长期建议升 4 GiB\n'
    '- [ ] API Key 轮换',
    '待办勾除')

rep(
    '"accessToken": "<SNOWLUMA_TOKEN>"',
    '"accessToken": "<见服务器 config.json，勿入库>"',
    '脱敏 accessToken（备用写法）')

ADV = r'''

---

## 十五、进阶三步落地记录（2026-10-19）

按教程《进阶篇》落地了三条，全部有验证证据，不是"应该能行"。

### 15.1 人格卡精简 + 生活能力（日记 / 相册 / 时间感）

| | 改动前 | 改动后 |
|---|---|---|
| 人格卡字符数 | 4995 | **3590** |
| 距注入上限 6000 余量 | 1005 | **2410** |

- 砍掉四处重复（人设/铁律/说话方式/黑名单都在讲"短、别客服腔"），示例 14 组压到 9 组
- 新增第六节「你怎么过日子」：日记（`diary/日记.md`，一天最多 3 条、禁止打卡与总结句）、
  相册（`album/`，用 `qq_get_message_images` 取图后写文件 + 一句理由）、时间感
- 相册另给了可操作说明：取图 → 写 `album/<md5>.<ext>` → 同名 `.txt` 写理由 → 查 md5 防重复
- 目录：`/opt/qq-bridge/diary/日记.md`、`/opt/qq-bridge/album/README.md`
- **注入验证**：`GET /api/socialV2/prompt?key=...` 返回的 role 字段里能查到
  「你怎么过日子」「diary/日记.md」「album/」「时间感」，且原有内容（蓝色大肥鱼、偷吃 token）未被裁掉

### 15.2 主动找人参数钉死

`socialV2.proactive` 原先**没有显式配置**，吃的是代码默认值（30~90 分钟 / 0.3）。
现在改为教程作者参考值：

```
checkIntervalMinMs   1800000 → 2700000   (30分 → 45分)
checkIntervalMaxMs   5400000 → 6600000   (90分 → 110分)
idleThresholdMs       900000              (15分，原本就是作者值)
probability              0.3 → 0.35
```

> 顺便更正 v2 文档里的一个说法：曾误判"当前比作者更频繁"，实际真正生效的
> `socialV2.proactive` 默认值是 30~90/0.3，与作者参考值接近；改动后频率基本不变，
> 目的是**消除隐式依赖默认值**的隐患。

### 15.3 一键闭嘴总闸

**结论：桥接早就内置了，不需要新写。** 作者担心的"缺一个总闸"在本项目不成立。

- 机制：`socialV2.paused`（暂停后不再唤醒、不再主动说话，AI 通道一律 403）
- 接口：`GET/POST /api/socialV2/activity`（**不是** `/api/socialV2/pause`）
- 鉴权：控制台令牌必须走 **`x-console-token`** 头，走 `authorization` 会 401
- 入口：`bash /opt/qq-bridge/whale-ctl.sh status|pause|resume`

实测证据：

```
pause    → ✔ 已暂停（回读校验通过）
独立复核 → AI 发消息 HTTP 403 {"error":"AI 已暂停，当前不允许执行 v2 工具"}
桥接日志 → 控制台：二代 AI 已暂停（唤醒/等待任务已停止）
resume   → ✔ 恢复，最终状态 ▶ 正常运行
```

> ⚠️ 写这类脚本必须**回读校验再报成功**。第一版脚本用错 header 导致 401，
> 却仍然打印"✔ 已暂停" —— 假成功比失败更危险。

### 15.4 印象定期重写

背景：`memberImpression` 的追加是**合并 traits**（上限 10 条），久了她会一直用旧判断说话。

实现（两处补丁）：

1. `buildWakePromptV2` 里追加一条维护提醒，条件是
   「有印象」且「距上次**真的**重写超过 `socialV2.memory.impressionRefreshDays`（默认 7 天）」
2. `memory-update` 落盘 memberImpression 时重置计时 —— 她改了就不再念，不是定时刷屏
3. **字段必须加进 `loadSocialV2State` 的白名单**，否则每次重启都丢，
   会导致"每轮唤醒都提醒"的唠叨 bug（第一次实现就踩了这个坑）

隔离验证（在工程副本里跑，零生产风险）：

| 场景 | 期望 | 实测 |
|---|---|---|
| 旧计时(30天) + 有印象 | 出现提醒 | ✅ |
| 提醒里带 `qq_memory_update` 工具名 | 要带 | ✅ |
| 新计时(刚刚) + 有印象 | 不出现 | ✅ |
| 旧计时 + 无印象（防空喊） | 不出现 | ✅ |

提醒原文：

```
【印象维护】你手上的【对群友的印象】可能已经过时了。挑 1~2 个改一下：
先用 qq_memory_query 看现在的印象，再用 qq_memory_update
（category=memberImpression，target=对方昵称，newContent="标签A、标签B"）
把你现在的判断重写掉，一条几个字就够，别攒成一堆旧标签。改完不用汇报。
```

可调参数（改配置，不改代码）：`"socialV2": { "memory": { "impressionRefreshDays": 7 } }`

### 15.5 验证方法留档

`buildWakePromptV2` 是 `main()` 的闭包，模块作用域取不到。隔离验证的做法：

1. 临时给 `main()` 内部加一个环境变量控制的全局出口
   （`if (process.env.BRIDGE_TEST_EXPORT === '1') globalThis.__bridgeTest = {...}`）
2. 把整个工程复制到 `/tmp`，删掉 `state/bridge.lock`（**桥接的单实例锁会拦住测试实例**）
3. `BRIDGE_TEST_EXPORT=1 node verify.mjs`
4. 跑完**立刻撤掉钩子**并核对 `grep -c BRIDGE_TEST_EXPORT src/bridge.js` 为 0

### 15.6 表情包库

`state/stickers.json` 有 **2160 条**（全 `source: manual`，不会被 QQ 收藏同步清理）。
由 `scripts/import-memes.py` 从 aigengtu 图库导入（id 前缀 `aige-`），
另有一批 `mfuns-*` 来自 mfuns 合集。URL 必须带 `?image_process=resize,w_800`，否则 403。

### 15.7 仍未做 / 受限项

- **好友申请自动通过**：属 QQ 客户端设置，服务器侧无相关代码；作者明确建议改回手动
- **EAC 车道**：登录态已同步到服务器（`available:true, login:winter646258`），
  但网关域名 `ai.dtyg123.dpdns.org` 全网 DNS 无记录（4 个公共 DNS 都查不到，本机也解析不了），
  端口连不通 → 该车道当前不可用，等上游修域名或换网关地址
- **听歌 / 语音转文字 / 手机(ADB)**：教程进阶 2/3/4，需要 Windows 侧反向隧道，
  且服务器内存不足以跑 Whisper，本轮未做
'''

if '## 十五、进阶三步落地记录' not in t:
    t = t.rstrip() + ADV
    done.append('新增第十五节')
else:
    missed.append('第十五节已存在')

io.open(P, 'w', encoding='utf-8').write(t)
print(f'长度 {orig} -> {len(t)}')
print('已完成：', ', '.join(done) if done else '（无）')
print('未匹配：', ', '.join(missed) if missed else '（无）')
