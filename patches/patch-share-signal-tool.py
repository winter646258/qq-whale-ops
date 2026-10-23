#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把主动报告的两个工具接进 MCP 工具表（阶段 3 的第二半）。

落点两处，都可重复执行：

  1. TOOL_CONFIG_FLAGS 加 `qq_share_signal: 'shareSignal'` 与
     `qq_set_report_policy: 'reportPolicy'`。
     不登记的后果不是「少一个工具」那么轻：桥接在**调用期**按 flag 判 403，
     而 MCP 这边不登记就会永远注册，于是「控制台显示已关闭，模型每次请求
     仍收到完整 schema，然后拿到 403」。
  2. 两个工具定义，插在 `// MARKER: ghosttool` 的 `server.connect` 之前。

用法：
    python3 patch-share-signal-tool.py [path/to/mcp-snowluma-safe.js]
不给参数就改 /opt/qq-bridge/src/mcp-snowluma-safe.js。
"""
from pathlib import Path
import sys

TARGET = Path(sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/mcp-snowluma-safe.js')

FLAG_ANCHOR = """  qq_shared_memory: 'sharedMemory',
};"""

FLAG_NEW = """  qq_shared_memory: 'sharedMemory',
  // 主动报告：把群里值得说的事攒着，按冷却讲给主人听。
  // 两个工具分开登记：关掉「写信号」不影响主人查/改策略。
  qq_share_signal: 'shareSignal',
  qq_set_report_policy: 'reportPolicy',
};"""

TOOL_ANCHOR = """// MARKER: ghosttool
server.connect(new StdioServerTransport());"""

TOOL_NEW = r"""// MARKER: share-signal-tool
server.tool(
  'qq_share_signal',
  '在群里碰到一件你觉得值得跟主人提一句的事（负面的、正面的、或者单纯有趣），把它记下来。'
    + '记下来不等于马上说：桥接会在合适的时候（最短 6 小时一次、避开深夜、主人没在忙）把这件事变成一次主动开口。'
    + '自己判断该不该说——不用每件事都报，一天能真正讲出去的也就一两条；'
    + '别人的私事、群里吵架的具体人名、能查到个人的细节，都不要往里写。'
    + '想先看看现在攒了什么、为什么还没发出去，用 stats。',
  {
    key: z.string().describe('当前群会话 key，格式 group:群号（主动报告只能由群会话发起）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['signal', 'stats']).describe('signal=记一条待报的事；stats=看当前攒着什么、为什么还没发'),
    eventId: z.string().optional().describe(
      'signal：这件事的标识，用来去重（同一条事件只说一次）。'
        + '建议写成能认出来的短串，比如 "吵架-新番-1022"；不传就没法防重复'
    ),
    summary: z.string().optional().describe(
      'signal：一句话说清发生了什么（80 字内）。写「群里为某部新番吵起来了，两边都挺认真」这种，'
        + '别写「张三说李四说的那句」——细节在群里就够了，这里只留你当时的感受'
    ),
    valence: z.number().optional().describe(
      'signal：这件事对你的情绪方向，-1（很糟）到 +1（很好），0 是中性有趣。说的时候语气会跟着变'
    ),
    willingness: z.number().optional().describe(
      'signal：你有多想说这件事，0~1，默认 0.5。越想说越容易被优先挑中'
    )
  },
  async ({ key, token, action, eventId, summary, valence, willingness }) => {
    try {
      if (action === 'stats') {
        const q = new URLSearchParams({ key, action: 'stats' });
        const data = await agentApi('/api/socialV2/share-signal?' + q.toString(), {
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      const data = await agentApi('/api/socialV2/share-signal', {
        method: 'POST',
        body: JSON.stringify({ key, action: 'signal', eventId, summary, valence, willingness }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '记录待报事件失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_set_report_policy',
  '调「主动跟主人说话」这件事的频率上限。'
    + '先说不传任何参数就是查看当前设置。'
    + '你能调的方向只有更安静：最短间隔系统卡死在 6 小时（想调 1 小时会被夹回去），'
    + '每日最多 4 条也是硬上限，安静时段默认 23 点到 8 点。'
    + '这个开关影响的是「她主动找我说话」这件事本身，别拿它当静音键——'
    + '真想让她安静一阵，是让她潜水，不是关掉报告。',
  {
    key: z.string().describe('会话 key，格式 private:主人的QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    enabled: z.boolean().optional().describe('关掉=完全不再主动报告。默认开'),
    quietStartHour: z.number().optional().describe('安静时段起点（0~23），默认 23'),
    quietEndHour: z.number().optional().describe('安静时段终点（0~23），默认 8。可以跨零点'),
    maxPerDay: z.number().optional().describe('一天最多几条，1~4，默认 4（超过 4 会被夹回 4）'),
    minIntervalMs: z.number().optional().describe('最短间隔毫秒，默认且最小 21600000（6 小时）')
  },
  async ({ key, token, enabled, quietStartHour, quietEndHour, maxPerDay, minIntervalMs }) => {
    try {
      // 不传任何参数 = 纯查看。用一个空 POST 让桥接走 policy 分支并把
      // before/after 都回给我们，比自己拼 GET 更省事也更准。
      const payload = { key, action: 'policy' };
      if (enabled !== undefined) payload.enabled = enabled;
      if (quietStartHour !== undefined) payload.quietStartHour = quietStartHour;
      if (quietEndHour !== undefined) payload.quietEndHour = quietEndHour;
      if (maxPerDay !== undefined) payload.maxPerDay = maxPerDay;
      if (minIntervalMs !== undefined) payload.minIntervalMs = minIntervalMs;
      const data = await agentApi('/api/socialV2/share-signal', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '调整报告策略失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// MARKER: ghosttool
server.connect(new StdioServerTransport());"""


def main():
    src = TARGET.read_text(encoding='utf-8')
    orig = len(src)
    changed = []
    skipped = []

    def apply(marker, anchor, addition, label):
        nonlocal src
        if marker in src:
            skipped.append(label)
            return
        cnt = src.count(anchor)
        if cnt != 1:
            print('FAIL: %s 的锚点命中 %d 次（必须恰好 1 次）' % (label, cnt))
            sys.exit(1)
        src = src.replace(anchor, addition, 1)
        changed.append(label)

    apply('qq_share_signal:', FLAG_ANCHOR, FLAG_NEW, '工具开关登记')
    apply('MARKER: share-signal-tool', TOOL_ANCHOR, TOOL_NEW, '工具定义')

    # 最终断言：少一个都算没装好
    for must in ["'qq_share_signal'", "'qq_set_report_policy'",
                 "qq_share_signal: 'shareSignal'", "qq_set_report_policy: 'reportPolicy'",
                 '/api/socialV2/share-signal']:
        if must not in src:
            print('FAIL: 装完后找不到 %s' % must)
            sys.exit(1)
    # qq_share_signal 自己两处（stats 一次、signal 一次），qq_set_report_policy 一处。
    if src.count('/api/socialV2/share-signal') != 3:
        print('FAIL: /api/socialV2/share-signal 应出现 3 次（stats/signal/policy 各一次），实际 %d'
              % src.count('/api/socialV2/share-signal'))
        sys.exit(1)

    TARGET.write_text(src, encoding='utf-8')
    print('changed: ' + (', '.join(changed) if changed else '(无)'))
    print('skipped: ' + (', '.join(skipped) if skipped else '(无)'))
    print('bytes: %d -> %d (+%d)' % (orig, len(src), len(src) - orig))


if __name__ == '__main__':
    main()
