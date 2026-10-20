# 新服务器从零安装清单

> 目标：一台干净的 Ubuntu 22.04（2 vCPU / ≥2 GiB，建议 4 GiB），
> 从零把这套东西装到「小鲸鱼能在 QQ 里正常说话」。
> 全程约 1~2 小时，其中扫码登录和渠道登录需要你亲自操作。

---

## 0. 前置条件

| 项 | 要求 | 检查 |
|---|---|---|
| 系统 | Ubuntu 22.04+，root 可用 | `lsb_release -a` |
| 内存 | ≥2 GiB（**建议 4 GiB**） | `free -m` |
| 磁盘 | ≥20 GB 可用 | `df -h /` |
| Node.js | ≥22.13（本机实测 v22.23.3） | `node -v` |
| Docker | 已装并运行 | `docker ps` |
| Python3 | 3.10+，带 pyyaml | `python3 -c "import yaml"` |
| 出口网络 | 能访问 GitHub / jsdelivr（EAC 网关另说） | `curl -sI https://api.github.com` |

---

## 1. 装 DSH（AI 大脑）

```bash
npm i -g @deepseek-ai/dsh        # 本项目实测 0.2.0-rc.2
mkdir -p /root/.dsh
cat > /root/.dsh/.env <<'EOF'
DEEPSEEK_API_KEY=<在这里填你的 key>
EOF
chmod 600 /root/.dsh/.env

# 装 qq-chat / qq-chat-v2 预设（来自 qq-bridge 仓库的 dsh/agent-presets）
# 以及前两个插件：qq-agent-presets、qq-mode-console
```

> ⚠️ DSH 的 profile 放在 `$DSH_HOME/profiles/`，本项目的桥接依赖 `web` profile。

---

## 2. 装 qq-bridge（桥接）

```bash
git clone <qq-bridge 上游仓库> /opt/qq-bridge
cd /opt/qq-bridge
npm install                      # 会跑 postinstall 打 SnowLuma SDK 补丁
```

把仓库里的**补丁**按顺序打上（都带 `.bak` 备份）：

```bash
python3 patches/patch-bridge-friend-refresh.py
python3 patches/patch-bridge-log-agent-error.py
python3 patches/patch-impression-refresh.py
python3 patches/patch-impression-persist.py
node --check src/bridge.js       # 必须 syntax OK
```

> 上游若已合并其中某些补丁，脚本会因为「锚点匹配数异常」而拒绝执行，属正常。

---

## 3. 装 SnowLuma（QQ 网关，Docker）

按官方 EULA **由你本人操作**（不得脚本化部署）。要点：

- 只用**小号**，别用主号
- 数据卷挂到固定位置，本项目用 `/var/lib/docker/volumes/qq-gateway-data/_data`
- 端口只绑回环：`3000`(HTTP) / `3001`(WS) / `5099`(WebUI) / `6081`(VNC)

---

## 4. 填配置

```bash
cp config.example.json config.json   # 或用上游自带的
```

必须亲手填的字段：

| 字段 | 说明 |
|---|---|
| `ownerQQ` | 你自己（管理员）的 QQ 号 |
| `allow.private` | 允许聊天的白名单（主动找人只用这个名单） |
| `friendOnly` | `true` = 任何好友都能聊、陌生人拒绝 |
| `snowluma.accessToken` | **从 SnowLuma 端抄真实值**（见下） |
| `snowluma.wsUrl/httpUrl` | `ws://127.0.0.1:3001` / `http://127.0.0.1:3000` |
| `dsh.baseUrl` | `http://127.0.0.1:3081` |
| `dsh.provider` / `model` | 模型路由，本项目用 `buddy` / `deepseek-v4.1-flash` |
| `qzone.interactWith` | 只对这些 QQ 的动态点赞/评论（空 = 谁都不互动） |

抄 accessToken 的正确姿势：

```bash
python3 -c "import json;print(json.load(open('/var/lib/docker/volumes/qq-gateway-data/_data/config/onebot_<小号QQ>.json'))['networks']['wsServers'][0]['accessToken'])"
```

---

## 5. 装 systemd 单元

```bash
cp systemd/*.service /etc/systemd/system/
# 若你的路径/端口与仓库不同，先改 ExecStart
systemctl daemon-reload
systemctl enable --now qq-dsh qq-bridge qq-zone-watch qq-provider-switch
systemctl is-active qq-dsh qq-bridge qq-zone-watch qq-provider-switch   # 四个都要 active
```

安装脚本：

```bash
install -m755 scripts/switch-provider.sh /opt/qq-bridge/switch-provider.sh
install -m755 scripts/whale-ctl.sh       /opt/qq-bridge/whale-ctl.sh
mkdir -p /opt/qq-bridge/diary /opt/qq-bridge/album
install -m644 persona/roles-小鲸鱼.md /opt/qq-bridge/roles/小鲸鱼.md
```

**日志路径必须对齐**（unit 里写死了 `/var/log/qqbridge.log`）：

```bash
ls -l /var/log/qqbridge.log /var/log/qzone-watch.log /var/log/provider-switch.log /var/log/dsh-web.log
```

---

## 6. 空间功能（可选）

```bash
python3 scripts/import-memes.py        # 导入表情包（会写 state/stickers.json）
node qzone-watch.js --list             # 验证能读到好友动态
node qzone-watch.js --limit            # 看六层限流与配额
node qzone-watch.js --interact         # 看互动白名单
```

> ⚠️ 评论发出去**删不掉**（SnowLuma 无删评论接口），测试前想清楚。

---

## 7. 验收检查

```bash
bash /opt/qq-bridge/whale-ctl.sh status      # 四服务 + 桥接端口 + 总闸状态
```

逐项确认：

- [ ] 四个服务 `active`，四个都是 `enabled`（重启服务器能自愈）
- [ ] 桥接日志出现 `SnowLuma 已连接`、`DSH 已就绪（模式: reserved2）`
- [ ] `[friendOnly] 好友列表已刷新：N 个好友`（每分钟一条）
- [ ] 私聊发一句，她能回（**这条最能说明问题**）
- [ ] `whale-ctl.sh pause` 之后 AI 发消息返回 403，`resume` 恢复
- [ ] 空间监控：`node qzone-watch.js --limit` 不报错
- [ ] `switch-provider.sh --status` 水位线随日志增长

---

## 8. 可选：白嫖模型渠道（our-free-model 插件）

```bash
dsh plugin --profile web add dsh-our-free-model
```

登录态在 `~/.dsh/our-free-model/eac-user.json` + `~/.dsh/.credentials.yaml` 的 `refs:` 段。
**换机时直接从旧机搬这两个文件即可**（注意权限 600），不要提交到仓库。

---

## 9. 常见故障对照

| 症状 | 原因 | 处理 |
|---|---|---|
| `Unit ... has a bad unit file setting` | unit 文件被写空 | 用 scp 传文件，`wc -c` 核对字节数 |
| 服务起不来且无日志 | 日志路径写错 | 桥接看 `/var/log/qqbridge.log` |
| 好友发消息没反应 | 主动白名单拦了 bootstrap / 好友窗口期 | 见交接文档第五节坑 2、坑 3 |
| `unauthorized` | accessToken 与 SnowLuma 不一致 | 两端对比 |
| 空间图片 403 | 缺 `image_process` 参数 | URL 加 `?image_process=resize,w_800` |
| 桥接"已有实例在运行" | `state/bridge.lock` 残留 | 确认无进程后删锁文件 |
| 内存吃紧 / swap 爆 | 2 GiB 机器常态 | 升 4 GiB，或关掉 qzone-watch |
