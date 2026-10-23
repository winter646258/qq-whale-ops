#!/usr/bin/env python3
"""把 qq_shared_memory 接进 MCP 工具表（阶段 2 的第二半）。

落点两处，都可重复执行：

  1. TOOL_CONFIG_FLAGS 加 `qq_shared_memory: 'sharedMemory'`。
     不加这一条的后果不是「少一个工具」那么轻：桥接在**调用期**按
     `v2ToolEnabled('sharedMemory')` 判 403，而 MCP 这边不登记就永远注册，
     于是「控制台显示已关闭，模型每次请求仍收到完整 schema，然后拿到 403」。
  2. 工具定义本体，插在 `// MARKER: ghosttool` 的 `server.connect` 之前。

用法：
    python3 patch-shared-memory-tool.py [path/to/mcp-snowluma-safe.js]
不给参数就改 /opt/qq-bridge/src/mcp-snowluma-safe.js。
"""
from pathlib import Path
import sys

TARGET = Path(sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/mcp-snowluma-safe.js')

FLAG_ANCHOR = """  qq_generate_image: 'image',
};"""

FLAG_NEW = """  qq_generate_image: 'image',
  // 跨会话共享记忆。桥接那边按这个 flag 在调用期 403，这里不登记就会
  // 「控制台关了照样可见、调了才报错」，既烧 token 又诱导误调。
  qq_shared_memory: 'sharedMemory',
};"""

TOOL_ANCHOR = """// MARKER: ghosttool
server.connect(new StdioServerTransport());"""

TOOL_NEW = r"""// MARKER: shared-memory-tool
server.tool(
  'qq_shared_memory',
  '跨会话的长期记忆：你想记住的事，不随单个会话消失，下次在这里或别处会自己想起来。'
    + 'read=看你现在记得什么（唤醒提示里已经给了一部分，这里能看到全部）；'
    + 'remember=记一件（text 要短，一句话；scope 不传就记在本会话：群里是本群专属，私聊是只给主人看的）；'
    + 'forget=忘掉一条（id 从 read 里拿，忘了还能找回来，不算删）；'
    + 'list=只列清单和统计，不展开正文。'
    + '注意：私聊里的内容默认只有主人能看到，群聊里永远不会出现私聊那层；'
    + '想让两个群都知道一件事，必须显式写 scope=shared 并点名 visibleGroups。'
    + '别把别人随口一句隐私就记下来——记住是为了以后聊得更好，不是攒档案。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['read', 'remember', 'forget', 'list']).describe('要做的事'),
    text: z.string().optional().describe('remember：要记的那句话，越短越好（80 字内）'),
    scope: z.string().optional().describe(
      'remember：记在哪个范围。不传就默认记在本会话（群里=group:本群，私聊=owner_private）。'
        + '可选 owner_private（仅主人私聊可见）/ shared（跨群共享，需配 visibleGroups）/ group:群号（该群专属）'
    ),
    visibleGroups: z.array(z.string()).optional().describe(
      'remember+scope=shared 时：点名哪些群能看到。群会话里只能点自己这一群'
    ),
    importance: z.number().optional().describe('remember：重要程度 1~9，默认 5。越高越不容易被淘汰'),
    pinned: z.boolean().optional().describe('remember：钉住（只有主人能钉，钉住的不会被自动淘汰、也不能忘）'),
    expiresAtMs: z.number().optional().describe('remember：多少毫秒后失效，不传就长期有效'),
    sourceRef: z.string().optional().describe('remember：这条是从哪来的，默认就是当前会话'),
    id: z.string().optional().describe('forget：要忘掉哪一条（read 的返回里有 id）'),
    group: z.string().optional().describe('read：主人专用，按群号查那个群的专属摘要')
  },
  async ({ key, token, action, text, scope, visibleGroups, importance, pinned, expiresAtMs, sourceRef, id, group }) => {
    try {
      if (action === 'read' && group) {
        const q = new URLSearchParams({ key, action: 'read', group });
        const data = await agentApi('/api/socialV2/shared-memory?' + q.toString(), {
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      if (action === 'read' || action === 'list') {
        const q = new URLSearchParams({ key, action });
        const data = await agentApi('/api/socialV2/shared-memory?' + q.toString(), {
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      const data = await agentApi('/api/socialV2/shared-memory', {
        method: 'POST',
        body: JSON.stringify({
          key, action, text, scope, visibleGroups, importance, pinned, expiresAtMs, sourceRef, id
        }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '共享记忆操作失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// MARKER: ghosttool
server.connect(new StdioServerTransport());"""


def apply(text, old, new, marker, label):
    if marker in text:
        print(f'· {label}：已装，跳过')
        return text, False
    n = text.count(old)
    if n != 1:
        print(f'❌ {label}：锚点命中 {n} 次（应为 1）')
        raise SystemExit(1)
    return text.replace(old, new, 1), True


def main():
    text = TARGET.read_text(encoding='utf-8')
    text, c1 = apply(text, FLAG_ANCHOR, FLAG_NEW, "qq_shared_memory: 'sharedMemory'", '工具 flag 登记')
    text, c2 = apply(text, TOOL_ANCHOR, TOOL_NEW, 'MARKER: shared-memory-tool', '工具定义')

    # 断言：flag 与工具名各恰好出现一次，且 ghosttool 标记仍在（没把它吃掉）
    for token, want in [("qq_shared_memory: 'sharedMemory'", 1), ("'qq_shared_memory'", 1),
                        ('MARKER: ghosttool', 1)]:
        got = text.count(token)
        if got != want:
            print(f'❌ 断言失败：{token!r} 出现 {got} 次（应为 {want}）')
            raise SystemExit(1)

    TARGET.write_text(text, encoding='utf-8')
    print(f'✅ 共享记忆工具已装： flag=改, tool=改  -> {TARGET}')


if __name__ == '__main__':
    main()
