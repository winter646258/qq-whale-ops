# QQ 小鲸鱼 · 私有部署仓库（qq-whale-ops）

> 这个仓库是云上服务器 `/opt/qq-bridge` 的**完整镜像**，外加本仓库自有的运维与验证资产。
> 判断标准很简单：**云上跑的是什么，这里就有什么，路径也一样。**

- 云上路径 `/opt/qq-bridge/<X>` ↔ 仓库路径 `<X>`
- 唯一不在 `/opt/qq-bridge` 下的部署件是 systemd 单元，云上在 `/etc/systemd/system/qq-*.service`，这里放 `systemd/`
- 仓库自有、云上**没有**的东西集中在 `scripts/`（模块验证脚本）、`extension/`、`archive/`、`docs/交接/`、`docs/设计/`

根目录的 `README.md` / `README.en.md` / `RULES.md` / `LICENSE` / `package.json` 等都是**上游 qq-bridge 项目自带的文件**，按云上原样保留；本文件才是这个私有仓库的说明。

> ⚠️ **私密仓库，但不含任何可用凭据。** 真实密钥只存在服务器上，规则见下面「不入库的东西」。

---

## 目录

| 路径 | 云上对应 | 说明 |
|---|---|---|
| `src/` | ✅ | 桥接全部源码，含 `bridge.js`（约 800 KB / 14530 行）与 32 个模块 |
| `patches/` | ✅ | 对 `bridge.js` 的本地补丁，云上 25 个（仓库含历史累积共 80+） |
| `roles/` | ✅ | 人格卡 `小鲸鱼.md`、`whale-persona.txt/.jpg`、`傲娇助手.md`、`README.md` |
| `roles/历史版本/` | ❌ | 仓库自有：改版前 / 精简版人格卡，用于对比与回退 |
| `scripts/` | ✅ + 自有 | 云上同款运维脚本 + 本仓库自有的模块验证脚本 |
| `docs/` | ✅ | 上游文档：`README.md` 索引、`FOLDER_MAP.md`、`guides/` |
| `docs/交接/` | ❌ | 仓库自有：历次交接文档、阶段总结、Bug 修复记录 |
| `docs/设计/` | ❌ | 仓库自有：插件化设计交接、长期能力草案 |
| `dsh/agent-presets/` | ✅ | `qq-chat` / `qq-chat-v2` 两个 DSH agent preset |
| `plugins/` | ✅ | `qq-agent-presets`、`qq-mode-console` 两个 DSH 插件 |
| `public/console.html` | ✅ | 控制台单页 |
| `systemd/` | `/etc/systemd/system` | 4 个服务单元（dsh / bridge / zone-watch / provider-switch） |
| `config.example.json` | ✅ | 脱敏配置样例（真实值只在服务器 `config.json`） |
| `qzone-watch.js` `whale-ctl.sh` `switch-provider.sh` | ✅ | 空间监控、保命开关、provider 切换 |
| `archive/` | ❌ | 仓库自有：线上 `bridge.js` / `qzone-watch.js` 历史快照 |
| `extension/` | ❌ | 仓库自有：控制台调试用浏览器扩展 |
| `SETUP.md` `setup.sh` | ❌ | 仓库自有：新服务器从零安装清单与一键脚本 |
| `交接文档.md` | ✅ | 云上那份 2026-10-19 的早期交接（**密钥已脱敏**） |

---

## 不入库的东西

`.gitignore` 已覆盖，动这块之前先看清楚：

- **凭据**：`.env*`、`config.json`（含 SnowLuma accessToken）、`console-token`、`.credentials.yaml`、`eac-user.json`、`*.token`、`scripts/privacy-rules.json`
- **运行时状态**：`state/`（71 MB，含会话与消息）、`sessions/`、`attachments/`、`cache/`
- **依赖**：`node_modules/`（36 MB）
- **备份文件**：`*.bak`、`*.bak-*`、`*.bak.*`、`*.pre-*`、`*.myversion-*`
- **个人数据**：`album/`、`diary/`、`audio/`

> 云上 `交接文档.md` 里原本写着两个明文 `DEEPSEEK_API_KEY`，入库前替换成了 `<DEEPSEEK_API_KEY>`。
> 也就是说**这一份与云上不是逐字节相同**——这是唯一一处有意的偏离。

---

## 怎么把云上的现状同步进来

这套流程已经实际跑通过，换机器可以直接照抄。

### 1. 让服务器输出 base64 JSONL（绕开 tar 的中文名编码问题）

`tar` 在 Windows 侧解出来会把中文名按 ANSI 解码成乱码，`bsdtar` 和 `.NET TarFile` 也各有各的坑。
可靠做法是让服务器用 Python 走一遍，输出 base64 的 JSONL，本地再逐条写回：

```python
# /tmp/dump.py
import os, json, base64, re
ROOT = '/opt/qq-bridge'
SKIP = {'node_modules','state','.git','album','diary','backup-systemd-20261019-160256'}
BAD = re.compile(r'(\.bak|\.pre-|\.myversion-|^config\.json$)')
for dp, dns, fns in os.walk(ROOT):
    dns[:] = [d for d in dns if d not in SKIP]
    for fn in fns:
        if BAD.search(fn):
            continue
        p = os.path.join(dp, fn)
        rel = os.path.relpath(p, ROOT).replace(os.sep, '/')
        print(json.dumps({'p': rel, 'b': base64.b64encode(open(p,'rb').read()).decode()}, ensure_ascii=False))
```

```powershell
ssh alihz "python3 /tmp/dump.py > /tmp/deploy.jsonl"
scp alihz:/tmp/deploy.jsonl .\deploy.jsonl
# 本地逐行 ConvertFrom-Json + FromBase64String + WriteAllBytes 落到目标路径
```

### 2. systemd 单元单独取

云上不在项目目录里，得从 `/etc/systemd/system/` 逐个取，按文件单独传输（批量 `for` 循环里带引号的路径容易被 shell 吃掉）。

### 3. `ssh` 必须用系统自带的那个

```powershell
C:\Windows\System32\OpenSSH\ssh.exe     # ✅ 可用
C:\Program Files\Git\usr\bin\ssh.exe    # ❌ fatal error - couldn't create signal pipe, Win32 error 5
```

---

## 已知的坑

**1. Git 的凭据助手在这个沙箱里跑不了。** `git fetch` / `git push` 会报：

```
fatal error - couldn't create signal pipe, Win32 error 5
fatal: could not read Username for 'https://github.com'
```

因为 `credential.helper` 配的是 `!'C:\Program Files\GitHub CLI\gh.exe' auth git-credential`，`!` 前缀要求 Git 通过 shell 拉起 `gh`，而沙箱禁止创建命名管道。绕过办法是一次性把 token 塞进 URL（不写进 `.git/config`）：

```powershell
$tok = (& "C:\Program Files\GitHub CLI\gh.exe" auth token).Trim()
git -c credential.helper= push "https://x-access-token:$tok@github.com/winter646258/qq-whale-ops.git" main:main
```

**2. Windows 侧 `tar.exe` 会解析到 Git 的那个**，一样会炸。要用 `C:\Windows\System32\tar.exe`。

**3. 有权限分支残留。** 本地分支 `backup/local-pre-squash-有密钥` 是当年重写历史清密钥时的备份，**从未推送**，但里面确实有明文凭据。不要 `git push --all`。

---

## 快速使用

```bash
# 保命开关
bash /opt/qq-bridge/whale-ctl.sh status
bash /opt/qq-bridge/whale-ctl.sh pause
bash /opt/qq-bridge/whale-ctl.sh resume

# 四个服务
systemctl status qq-dsh qq-bridge qq-zone-watch qq-provider-switch
```

新服务器从零安装见 [SETUP.md](SETUP.md)。
架构、配置、排障、事故记录见 [docs/交接/交接文档-20261023.md](docs/交接/交接文档-20261023.md)（最新一份）。
