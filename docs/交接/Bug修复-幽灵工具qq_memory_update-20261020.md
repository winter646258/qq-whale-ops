# 幽灵工具：`qq_memory_update` 从未存在（2026-10-20 22:12 修复）

> 这个问题是子代理核查上报的，不是咱自己发现的。**必须记一笔：咱上一轮还把它弄得更糟了。**

---

## 一、问题

`bridge.js` 的【印象维护】提示词（10126 行）明确让她调用 `qq_memory_update`：

> 【印象维护】…先用 `qq_memory_query` 看现在的印象，再用 **`qq_memory_update`**
> （category=memberImpression，target=对方昵称，newContent="标签A、标签B"）…

但 **MCP 层从来没有这个工具**。实测只注册了 4 个：

```
qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear
```

而后端 `POST /api/socialV2/memory-update` **倒是完整实现了**（6776-6790 行），
包括改写 traits、换人、以及 `st.lastImpressionRefreshAt = Date.now()` 重置维护计时。

**症结**：能力在后端齐了，但前端（MCP 工具层）没开这个口。她收到的指令是**调一个不存在的工具**。

---

## 二、后果（双重）

### ① 印象只能追加，永远无法重写

`qq_memory_append` 只会往 traits 里 push，且 `slice(0, 10)` 截断。
累积到 10 条之后就再也加不进去了 —— 而那条最长的印象已经长成了 **144 字的小作文**：

```
私聊的这位爱叫人大肥鱼，自己说"随便你取"，还说我像养女儿，问波西米亚历史问得挺认真…
```

（这正是"只会追加、无法重写"的物证）

### ② 【印象维护】变成永久噪音

`lastImpressionRefreshAt` 永远停在 0 ⇒ `impressionStale` 永远为真
⇒ 每 12 小时冷却一过就重念一遍，白烧 token，还让她困惑（"我明明想改，可那工具调不动"）。

---

## 三、咱上一轮的错误

咱上轮修「字段没存盘」时，把 load 的默认值从 `Date.now()` 改成了 `0`。

**语义上是对的**（从未刷新过就该是"从未"），但当时**没有可用的清除路径**——
那条能让它变成非 0 的 `qq_memory_update` 根本不存在。

于是：改之前 7 天后才 stale；改之后**一启动就 stale**。

> 教训：**修"诚实"之前要先确认"出路"存在**。
> 把伪造的默认值改成真实值是对的，但如果真实值指向一个死胡同，
> 那就等于把"偶尔报错"改成了"永久报错"。

---

## 四、修法（一个补丁，三件事）

### 1) MCP 层补 `qq_memory_update`（核心）

转发到**已存在**的 `POST /api/socialV2/memory-update`，**后端零改动**。

参数与提示词里写的完全一致：
- `category`：activeTopic / pendingThought / memberImpression
- `target`：memberImpression 时指定是谁
- `newContent`：新的内容（印象用逗号分隔多个标签）
- `oldContent`：activeTopic / pendingThought 时指定原文
- `newExtra`：附加信息（换人时用 `newExtra.target`）

### 2) traits 单标签限长 40 字（衍生问题）

原来：
```js
im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
```
**只限条数（20 条），不限长度** ⇒ 能长出 144 字的长句。

改成：
```js
im.traits = newContent.split(/[,，、]/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.slice(0, 40))
  .slice(0, 20);
```
同时把 `append` 路径的 50 字口径也统一成 40 —— "加"和"改"两条路宽度必须一致。

### 3) 补全工具开关与清单

- `TOOL_CONFIG_FLAGS`：`qq_memory_update → memoryUpdate`
- 工具开关清单：`'memory', 'memoryUpdate'`
- `toolMap`（qq_get_prompt 用）：`memoryUpdate: 'qq_memory_update'`
- 默认值：`memoryUpdate: true`
- **后端 update 路由加独立开关校验**：它比 append 危险（会覆盖），要能单独掐掉

---

## 五、验证（含线上实证）

| 项 | 结果 |
|---|---|
| `verify-ghosttool.mjs`（本机演练 + 线上文件各一次） | **30/30** |
| 提示词点名的工具是否都存在 | ✅ `qq_memory_query` / `qq_memory_update` 都注册了 |
| 工具数变化 | 32 → **33**，`qq_memory_update` 在 `enabledTools` 内 |
| **真实重写** | ✅ `老猫` 的 traits 从长句 → `["爱发怪图","话密","偶尔突然安静"]` |
| **提醒可消除** | ✅ `refreshAt` 从 `0` → `1792505609322`（22:13:29） |
| 144 字长句按新逻辑 | ✅ 被切成多条、各自 ≤40 字 |
| 正常短标签不受影响 | ✅ `话多，爱怼人，爱发怪图` 原样保留 |

> ⚠️ **咱测试时把「老猫」的原印象覆盖了**，之后从 `tool-calls.jsonl` 里翻回原文
> （`12:00:21` 那条 `qq_memory_append`）并用 update 还原。
> **教训：在生产环境做"写"验证时，要先备份被改的那条数据，而不是事后去翻日志找。**

---

## 六、回滚

```bash
cd /opt/qq-bridge/src
cp bridge.js.pre-ghosttool-<stamp> bridge.js
cp mcp-snowluma-safe.js.pre-ghosttool-<stamp> mcp-snowluma-safe.js
systemctl restart qq-bridge && systemctl restart qq-dsh
```

---

## 七、这件事暴露的系统性问题

**"提示词让模型调用 X" 和 "X 真的存在" 之间没有校验。**

任何在提示词里硬写工具名的地方，都可能出现同类幽灵。建议（尚未做）：

- 加一个测试：把 `bridge.js` 里所有 `qq_xxx` 字样抓出来，逐个比对 MCP 层注册表
- 或把提示词改成"调用你工具清单里的记忆改写工具"，不硬编码名字

现在这个 `verify-ghosttool.mjs` 里已经有一段**从提示词抓工具名逐个核对注册**的检查，
可以作为这类回归的起点。
