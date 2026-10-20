"""修「幽灵工具」+ 两个衍生问题。

══ 背景（子代理核查 + 咱自己核实）════════════════════════════════════════

`bridge.js` 的【印象维护】提示词（10126 行）让模型调用 `qq_memory_update`：

    【印象维护】…先用 qq_memory_query 看现在的印象，再用 qq_memory_update
    （category=memberImpression，target=对方昵称，newContent="标签A、标签B"）…

但 **MCP 层从来没有这个工具**（只有 append / query / remove / clear）。
后端 `POST /api/socialV2/memory-update` 倒是完整实现了（6776-6790 行，
还会 `st.lastImpressionRefreshAt = Date.now()`）。

后果是双重的：
  ① 她永远无法重写印象 ⇒ 印象只增不减，只能苟着长（实测一条 144 字小作文）
  ② `lastImpressionRefreshAt` 永远停在 0 ⇒ `impressionStale` 永远为真
     ⇒【印象维护】每 12 小时冷却一到就重念一遍，白烧 token

⚠️ 而且咱上一轮把它**弄得更糟了**：把默认值从 `Date.now()` 改成 `0` 之后，
   任何会话一启动就 stale，不再需要等 7 天。虽然语义上更诚实（从未刷新过就是
   从未刷新过），但没有可用的清除路径时，这条提醒就变成永久的噪音。
   **根治的办法不是把 0 改回去（那是骗自己），而是把工具补上。**

══ 本补丁做三件事 ══════════════════════════════════════════════════════

1) **MCP 层补 `qq_memory_update`**（核心）
   转发到已有的 `POST /api/socialV2/memory-update`，后端零改动。
   参数与提示词里写的一模一样：category / target / newContent / oldContent，
   外加 newExtra（换人时可传 extra.target）。

2) **给 traits 单标签加长度上限**（衍生问题）
   `newContent.split(/[,，、]/)` 拆分后**没有任何长度限制**，
   于是能长出 144 字的长句。加 `slice(0, 40)`：
   一条印象本来就该是"话多、爱怼人"这种，不是小作文。

3) **把提示词里的工具名与真实工具对齐**
   提示词已经写对了（qq_memory_update），补上工具后自然对齐。
   但顺手把 `qq_memory_update` 也加进工具开关清单与 toolMap，
   否则控制台关不掉它、qq_get_prompt 也不列它。

回滚：
  cp src/bridge.js.bak-ghosttool-<stamp> src/bridge.js
  cp src/mcp-snowluma-safe.js.bak-ghosttool-<stamp> src/mcp-snowluma-safe.js
  systemctl restart qq-bridge && systemctl restart qq-dsh
"""
import os
import shutil
import time

BRIDGE = os.environ.get('QQ_BRIDGE_SRC') or '/opt/qq-bridge/src/bridge.js'
MCP = os.environ.get('QQ_BRIDGE_MCP') or '/opt/qq-bridge/src/mcp-snowluma-safe.js'
MARKER = 'MARKER: ghosttool'

src = open(BRIDGE, encoding='utf-8', newline='').read()
if MARKER in src:
    print('[skip] bridge 已打过')
    raise SystemExit(0)


def sub_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        print(f'[x] 锚点「{label}」匹配 {n} 次（预期 1）')
        raise SystemExit(1)
    return text.replace(old, new, 1)


# ── 1. traits 单标签加长度上限 ────────────────────────────────────────────
src = sub_once(
    src,
    """            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }""",
    """            if (newContent !== undefined) {
              // MARKER: ghosttool
              // 单标签也要限长。原来只限条数（20 条）不限长度，
              // 于是长出过 144 字的「印象」——那是小作文，不是印象。
              // 实测那条：私聊的这位爱叫人大肥鱼，自己说"随便你取"…
              im.traits = newContent.split(/[,，、]/)
                .map((s) => s.trim())
                .filter(Boolean)
                .map((s) => s.slice(0, 40))
                .slice(0, 20);
            }""",
    'traits 限长'
)

# ── 2. append 的 traits 也限长（同一条通路）──────────────────────────────
src = sub_once(
    src,
    """      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));""",
    """      // MARKER: ghosttool
      // 与 memory-update 保持同一个长度口径（40 字），免得"加"和"改"两条路宽度不同。
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      const shortText = text.slice(0, 40);
      if (shortText && !traits.includes(shortText)) traits.push(shortText);""",
    'append traits 限长'
)

# ── 3. 工具开关清单加 memoryUpdate ────────────────────────────────────────
src = sub_once(
    src,
    "'setWakeConfig', 'markRead', 'memory', 'slangQuery',",
    "'setWakeConfig', 'markRead', 'memory', 'memoryUpdate', 'slangQuery',",
    'toolFlags 加 memoryUpdate'
)

# ── 4. toolMap 加 memoryUpdate（让 qq_get_prompt 列出来）──────────────────
src = sub_once(
    src,
    "            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',",
    "            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',\n"
    "            // MARKER: ghosttool\n"
    "            // 之前漏登记：提示词一直让她调 qq_memory_update，但这工具在 MCP 层\n"
    "            // 根本不存在，且 toolMap 里也没有 ⇒ 她自己查工具清单都看不到它。\n"
    "            memoryUpdate: 'qq_memory_update',",
    'toolMap 加 memoryUpdate'
)

# ── 5. 后端 update 路由：按工具开关分别校验 ──────────────────────────────
# 原来只认 'memory'。现在 update 有了独立开关，要能单独关掉它。
src = sub_once(
    src,
    """          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);""",
    """          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          // MARKER: ghosttool
          // update 单独一个开关：它比 append 危险（会覆盖已有印象），要能单独掐掉。
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memoryUpdate')) { sendJson({ ok: false, error: '工具未启用：qq_memory_update' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);""",
    'update 路由独立开关'
)

# ── 6. 工具开关默认值 ────────────────────────────────────────────────────
src = sub_once(
    src,
    "        memory: true,\n        getImages: true,",
    "        memory: true,\n"
    "        // MARKER: ghosttool：update 单独开一个开关（默认开，与 memory 一致）\n"
    "        memoryUpdate: true,\n"
    "        getImages: true,",
    '默认值加 memoryUpdate'
)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{BRIDGE}.bak-ghosttool-{stamp}'
shutil.copy2(BRIDGE, bak)
with open(BRIDGE + '.tmp', 'wb') as fh:
    fh.write(src.encode('utf-8'))
os.replace(BRIDGE + '.tmp', BRIDGE)
print(f'[ok] bridge 已打补丁；备份 -> {bak}')

# ══ MCP 侧：补 qq_memory_update 工具 ════════════════════════════════════
msrc = open(MCP, encoding='utf-8', newline='').read()
if MARKER in msrc:
    print('[skip] mcp 已打过')
    raise SystemExit(0)

# 1) 工具开关登记
if msrc.count("  qq_memory_clear: 'memory',") != 1:
    print('[x] mcp 工具开关锚点未命中')
    raise SystemExit(1)
msrc = msrc.replace(
    "  qq_memory_clear: 'memory',",
    "  qq_memory_clear: 'memory',\n  qq_memory_update: 'memoryUpdate',",
    1
)

# 2) 工具本体：插在 qq_memory_clear 之后
TOOL = """
server.tool(
  'qq_memory_update',
  '改写一条已有的轻量记忆。memberImpression（对某人的印象）用 target 指定是谁、newContent 写新的标签（用逗号分隔，一条几个字就够）；activeTopic / pendingThought 用 oldContent 指定原文、newContent 写改后的。印象越攒越多就该重写，别一直往上堆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    target: z.string().optional().describe('memberImpression 时要改的是谁（对方昵称）'),
    oldContent: z.string().optional().describe('activeTopic / pendingThought 时要改的原文'),
    newContent: z.string().optional().describe('新的内容。memberImpression 时用逗号分隔多个标签，例如"话多、爱发梗"'),
    newExtra: z.object({
      target: z.string().optional().describe('memberImpression 时改名用：把这条挪到新昵称下'),
      pendingQuestion: z.string().optional().describe('activeTopic 的待追问'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者'),
      motivation: z.string().optional().describe('pendingThought 的动机'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, target, oldContent, newContent, newExtra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-update', {
        method: 'POST',
        body: JSON.stringify({ key, category, target, oldContent, newContent, newExtra: newExtra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆改写失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// MARKER: ghosttool
server.connect(new StdioServerTransport());"""

if msrc.count('\nserver.connect(new StdioServerTransport());') != 1:
    print('[x] mcp 连接锚点未命中')
    raise SystemExit(1)
msrc = msrc.replace('\nserver.connect(new StdioServerTransport());', TOOL, 1)

mbak = f'{MCP}.bak-ghosttool-{stamp}'
shutil.copy2(MCP, mbak)
with open(MCP + '.tmp', 'wb') as fh:
    fh.write(msrc.encode('utf-8'))
os.replace(MCP + '.tmp', MCP)
print(f'[ok] mcp 已补 qq_memory_update；备份 -> {mbak}')
print(f'  MARKER: bridge={src.count(MARKER)} mcp={msrc.count(MARKER)}')
print('  下一步：node --check 两个文件 → systemctl restart qq-bridge && systemctl restart qq-dsh')
