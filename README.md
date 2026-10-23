# QQ 小鲸鱼 · 部署仓库

把一只「住在 QQ 里的 AI 小鲸鱼」从零装到能跑所需的**全部运维资产**：
systemd 单元、脚本、补丁、人格卡、踩坑文档与验证方法。

> ⚠️ **这是一个私密仓库，但仍然不含任何可用凭据。**
> 所有密钥、token、密码都以占位符表示，真实值只存在服务器上（见「凭据清单」）。
> 仓库里出现的 QQ 号是本项目自身的账号，属于私有信息，请勿外传。

---

## 这套东西是什么

```
QQ 小号（八千代）
   ↕  SnowLuma（Docker，OneBot v11 网关）
   ↕  qq-bridge（Node，QQ ↔ DSH 桥接，含二代仿真）
   ↕  DSH 0.2.0-rc.2（web profile，AI 大脑）
   ↕  模型提供方（CodeBuddy / DeepSeek / our-free-model 白嫖渠道）
```

配套还有：空间动态监控（点赞/评论）、provider 自动切换、一键闭嘴总闸、
人格卡（小鲸鱼）、日记/相册，以及一整套限流与风控闸门。

---

## 仓库结构

```
README.md                  本文件
SETUP.md                   新服务器从零安装清单（照着做）
setup.sh                   一键安装脚本（幂等，可重复跑）
docs/
  交接文档.md              当前架构、配置、排障、事故记录（权威文档）
  qq-whale-deployment.md    早期部署记录（历史参考）
  交接文档-YYYYMMDD*.md     每日交接快照（按时间累积，越往后越新）
  阶段总结-20261023.md      阶段性总结
  插件化设计交接-20261023.md  「每个功能一个插件」的改造设计（交 codex 执行）
systemd/
  qq-dsh.service           AI 大脑
  qq-bridge.service        QQ ↔ DSH 桥接
  qq-zone-watch.service    空间动态监控
  qq-provider-switch.service  provider 自动切换
src/                        上游之外的本地状态模块（被 bridge.js 引用）
  mood-store.js             情绪 / 底色 / 暗流
  affinity-store.js         好感度（按会话各存一份，落在 state/affinity.json）
  portrait-store.js         人物画像
  schedule-store.js         日程
  diary-store.js            日记（JSONL）
  group-digest-store.js     群聊近况（D）
  shared-memory-store.js    共享记忆
  share-signal-store.js     「主动分享」信号闸门
  image-approval-store.js   生图审批
  phone-bridge.js           手机侧桥接
  site-bili.js              B 站只读
  mcp-web-search-safe.js    安全的网页搜索 MCP
  mood-store.test.mjs       情绪模块单测
scripts/                    运维与验证脚本（whale-ctl / 验证 / 探测 / 分析）
  whale-ctl.sh             一键暂停/恢复/状态（保命开关）
  switch-provider.sh       provider 自动切换（systemd 适配版）
  import-memes.py          表情包批量导入（aigengtu 源）
  selftest-wake.py         唤醒链路自检
  probe-official-api.py    官方 API 连通性探测
  verify-*.mjs / test-*.mjs  各模块的在线验证与单测
patches/                   对上游 qq-bridge 的本地补丁（均有 .bak 备份与验证方法）
                            命名约定：patch-<功能>.py，同一功能的多步补丁加后缀
persona/
  roles-小鲸鱼.md          人格卡（6367 字符 / 注入上限 7000）
  roles-小鲸鱼.改版前-YYYYMMDD.md  改版前的备份，用于回退与对比
  roles-小鲸鱼.slimmed-YYYYMMDD.md  历史精简版
extension/                 浏览器扩展（控制台/调试用）
assets/                    静态资源
archive/
  bridge.server-*.js       线上 bridge.js 备份（含全部本地补丁）
  qzone-watch.server-*.js  线上 qzone-watch.js 备份
  switch-provider.server-*.sh
  roles-小鲸鱼.server-*.md 旧版人格卡（199→ 精简前）
```

---

## 凭据清单（**绝不入库**，只存在服务器上）

| 凭据 | 位置 | 用途 |
|---|---|---|
| `DEEPSEEK_API_KEY` | `/root/.dsh/.env`（600） | 评论生成、DSH 兜底 |
| SnowLuma `accessToken` | `/opt/qq-bridge/config.json` | 桥接 ↔ 网关 |
| 控制台 `consoleToken` | 桥接自动生成到 `state/console-token` | 控制台/脚本鉴权 |
| EAC 登录态 | `~/.dsh/our-free-model/eac-user.json`（600） | 白嫖渠道（当前网关 DNS 挂了） |
| 渠道账号密钥 | `~/.dsh/.credentials.yaml` 的 `refs:` | CodeArts/WorkBuddy 等 13 家 |

新服务器上线时，这些**靠手工填或者从旧机搬**，不要写进仓库。

---

## 别人踩过的坑（都在这里了）

1. **跨 SSH 传文件内容一律用 scp**，不要用 here-doc/here-string 拼文件 ——
   占位符没被替换会把 unit 写成空文件，`systemctl start` 报 `bad unit file setting`。
   （本项目因此全链路中断过 22 分钟，见交接文档第十四节）
2. **日志必须写 `/var/log/`，不能写 `/tmp`** —— provider 切换用「行数水位线」，
   `/tmp` 被 tmpfiles 清理后水位线错乱，自动切换会误触发或彻底失效。
3. **控制台令牌走 `x-console-token` 头**，走 `authorization` 一律 401。
   写脚本时必须**回读校验**再报成功，否则会出现"假成功"（我们踩过）。
4. **好友列表有刷新窗口期**（原 10 分钟）—— 刚通过好友申请的人，第一条消息会被
   fail-closed 丢掉。已修：1 分钟刷新 + 非好友消息触发补拉。
5. **`loadSocialV2State` 是字段白名单** —— 新增的会话状态字段如果不加进白名单，
   每次重启都会丢，容易写出"每轮都提醒"的唠叨 bug。
6. **2 GiB 机器不要跑 Whisper**，可用内存只有 ~600 MB，加载模型会把 DSH 一起 OOM。
7. **评论发出去删不掉** —— SnowLuma 无删评论接口，空间原生接口也拿不到 `qzonetoken`。

---

## 快速使用

```bash
# 看状态 / 让她立刻闭嘴 / 恢复
bash /opt/qq-bridge/whale-ctl.sh status
bash /opt/qq-bridge/whale-ctl.sh pause
bash /opt/qq-bridge/whale-ctl.sh resume

# 四个服务
systemctl status qq-dsh qq-bridge qq-zone-watch qq-provider-switch
```

新服务器安装：见 [SETUP.md](SETUP.md)。
