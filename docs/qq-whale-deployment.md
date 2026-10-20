# QQ AI 小鲸鱼 - 服务器部署状态与操作指南

> 部署时间：2026-10-17
> 服务器：i-bp180y8s00kynoo5wjho / 121.40.52.115 / 华东1(杭州)
> 系统：Ubuntu 22.04.5 LTS · 2 vCPU · **2 GiB** · ESSD 40G

---

## 一、已完成（已验证）

| 组件 | 版本 | 状态 | 证据 |
|---|---|---|---|
| Node.js | v22.23.3 | ✅ | 满足 22.13+ 要求 |
| pnpm | 12.14.0 | ✅ | dsh plugin 需要 |
| **DSH** | 0.2.0-rc.2 | ✅ **跑通** | `:3080` 监听，HTTP 303，内存 177MB |
| **qq-chat preset** | — | ✅ **已加载** | `presets: standard, ptc, minimal, cordis, qq-chat, qq-chat-v2` |
| **MCP 工具** | — | ✅ **已挂载** | `probe-tools` 成功建会话 |
| **SnowLuma** | 1.14.22 | ⏸️ 已解压待启动 | SHA256 校验通过，Linux 原生组件就位 |
| **qq-bridge** | 0.2.0-r3 | ✅ 已装 | 128 依赖，postinstall 补丁已打 |
| **DeepSeek 登录** | — | ❌ **缺** | credentials 无账号凭据 |
| QQ 扫码登录 | — | ❌ **缺** | 等 SnowLuma 启动 |

### 已验证的关键能力

```
probe-tools 输出：
  session session-4462e38a... (preset=qq-chat)   ← preset 加载成功
  selectModel -> deepseek-official / deepseek-flash / max
  prompt -> {"accepted":true}                    ← 会话可提交
  结果: done
  最终文本: ""                                    ← 模型未响应（因为没登录）
```

**结论：整套链路是通的，只差「登录」这一步。**

---

## 二、还需要你做的三件事

### ① 启动 SnowLuma（EULA 要求你自己操作）

官方 EULA §5.4 明确禁止「通过自动化脚本部署」，所以这一步咱不能代劳：

```powershell
ssh alihz
cd /opt/snowluma
./launcher.sh
```

首次会要求同意协议。启动后日志会打印 WebUI 地址和初始密码。

### ② 通过 VNC 打开 WebUI（服务器没桌面）

**新开一个 PowerShell 窗口**：

```powershell
ssh -L 6080:127.0.0.1:6080 alihz -N
```

（窗口卡住不动是正常的，别关）

**浏览器打开**：

```
http://127.0.0.1:6080/vnc.html
```

点 Connect，密码留空。

进去后能看到 SnowLuma 的 WebUI（如果 SnowLuma 是用 `DISPLAY` 起的，还能看到浏览器窗口）。

> 如果 SnowLuma 只是起个 Web 服务（不需要桌面），也可以直接把 5099 端口转发出来：
> ```powershell
> ssh -L 5099:127.0.0.1:5099 alihz -N
> ```
> 然后浏览器开 `http://127.0.0.1:5099`

### ③ 登录 DeepSeek 账号

DSH 的 Web UI 在 `http://127.0.0.1:3080`，需要一个带 token 的 URL。token 每次启动都变：

```bash
ssh alihz "grep -oP 'token=\K\S+' /tmp/dsh-web.log | head -1"
```

拿到 token 后：

```powershell
ssh -L 3080:127.0.0.1:3080 alihz -N
```

浏览器打开 `http://127.0.0.1:3080/?token=<刚才那个token>`，在里面登录 DeepSeek 账号。

---

## 三、QQ 号与白名单（config.json）

配置文件：`/opt/qq-bridge/config.json`

需要填三个地方：

```json
{
  "ownerQQ": 你的主号,
  "allow": {
    "private": [你的主号, 机器人小号],
    "groups": []
  }
}
```

> ⚠️ `allowAllWhenEmpty` 是 `false`（fail-closed）。**白名单空着 = 谁都不理**。

编辑命令：

```bash
ssh alihz "nano /opt/qq-bridge/config.json"
```

---

## 四、启动顺序

1. **SnowLuma**（你自己起）→ 扫码登录 QQ 小号
2. **DSH**（已在跑）→ 登录 DeepSeek
3. **填 config.json** 的 QQ 号
4. **启动 qq-bridge**：

```bash
ssh alihz "cd /opt/qq-bridge && npm start"
```

看到 `SnowLuma 已连接` 就成功了。

---

## 五、重要提醒

### 内存只有 2 GiB

| 组件 | 实测内存 |
|---|---|
| DSH | 177 MB |
| SnowLuma | 待测（预计 200-400 MB） |
| qq-bridge | 待测（预计 100-200 MB） |
| 系统 | ~400 MB |
| **合计** | **约 900 MB – 1.2 GB** |

可用 1.7 GiB，**余量不到 700 MB**。SWAP 有 4G 兜底，但会慢。

**建议**：如果卡，考虑升到 4GB。

### 已归档的超星环境

`/opt/chaoxing` → `/opt/chaoxing.archived-20261017`

其中：
- `scripts/cx.user.js` —— 你改好的脚本（autoLogin=1，手机号 <已脱敏>，token <已脱敏>，正确率 80）
- `profile/` —— 浏览器登录态（超星未登录）

Playwright 浏览器缓存（681MB）已删除以腾空间。

### 合规

- SnowLuma EULA §5.4：不得通过自动化脚本部署 → **你自己启动**
- qq-bridge 只探测、不部署 SnowLuma（作者的刻意设计）
- 腾讯对机器人有风控，`sendDelayMs: 300` 是作者踩坑后调的，别改小

---

## 六、常用命令

```bash
# 查 DSH 状态
ssh alihz "ss -tlnH | grep 3080; pgrep -af 'dsh --profile web'"

# 查 DSH token
ssh alihz "grep -oP 'token=\K\S+' /tmp/dsh-web.log | head -1"

# 重启 DSH
ssh alihz "pkill -f 'dsh --profile web'; sleep 2; cd /root && setsid nohup dsh --profile web --no-open --host 127.0.0.1 --port 3080 > /tmp/dsh-web.log 2>&1 < /dev/null &"

# 重启 VNC 通道
ssh alihz "bash /opt/vnc-start.sh"

# 查内存
ssh alihz "free -h"

# 查端口
ssh alihz "ss -tlnH | grep -E '3000|3001|3080|3100|5099'"
```

---

## 七、端口规划

| 端口 | 服务 | 绑定 |
|---|---|---|
| 3080 | DSH Web | 127.0.0.1 |
| 3000 | SnowLuma OneBot HTTP | 待定 |
| 3001 | SnowLuma OneBot WS | 待定 |
| 3100 | qq-bridge 控制台 | 127.0.0.1 |
| 5099 | SnowLuma WebUI | 待定 |
| 5900 | x11vnc | 127.0.0.1 |
| 6080 | noVNC | 127.0.0.1 |

**全部只绑回环，公网不可达，必须走 SSH 隧道。**
