#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
第一期收尾：给 MCP 加 qq_bili 工具 + 给桥接加 /api/socialV2/bili 端点。

为什么需要这一层：浏览器桥（phoneBridge）已在线上跑通，但**没有任何东西能往它里面入队**。
桥接进程里的 phoneBridge 是单例，MCP 工具进程在另一个进程里 —— 只能走 HTTP 端点。

安全边界（三条都写死在代码里）：
  1. 只读：端点只暴露 recommend/video/comments/search，没有任何写操作。
  2. 会话令牌 + 白名单：走和别的社交端点一样的 agentTokenOk + v2SessionAllowed。
  3. 工具开关：cfg.socialV2.tools.bili === false 时整个关掉。

用法：
  python3 patch-p1-bili-tool.py --target /opt/qq-bridge
"""
import io
import os
import sys

SRC_DIR = '/opt/qq-bridge'
for i, a in enumerate(sys.argv):
    if a == '--target' and i + 1 < len(sys.argv):
        SRC_DIR = sys.argv[i + 1]

BRIDGE = os.path.join(SRC_DIR, 'src', 'bridge.js')
MCP = os.path.join(SRC_DIR, 'src', 'mcp-snowluma-safe.js')

TOOL_ADD = r"""// MARKER: bili-tool

// ───────────────────────── B 站只读（走浏览器桥） ─────────────────────────
//
// 为什么单独一个工具而不是塞进 web_search：搜索要签名（WBI），要能翻评论，
// 还要认 BV 号；而且它**只能**在主人电脑上的扩展在线时用。
const BILI_ACTIONS = ['recommend', 'video', 'comments', 'search'];

server.tool(
  'qq_bili',
  '去 B 站看一眼（只读）：首页推荐、某个视频的详情、热门评论、按关键词搜视频。'
    + '这台服务器的 IP 被 B 站拉黑了，所以请求是绕道主人电脑上的浏览器扩展发出去的——'
    + '扩展没开就会报「浏览器桥不在线」，那种情况直接跟主人说一声，别反复重试。'
    + '视频用 BV 号指定（像 BV1GJ411x7h7）；评论需要先用 video 查到 aid。'
    + '这个工具拿不到登录态：只能看公开内容，不能点赞投币收藏。',
  {
    key: z.string().describe('当前会话 key（group:群号 或 private:QQ号），用来校验你这次的令牌'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(BILI_ACTIONS).describe(
      'recommend=首页推荐；video=视频详情；comments=热门评论；search=搜视频'
    ),
    bvid: z.string().optional().describe('action=video/comments 时必填，BV 号'),
    aid: z.number().optional().describe('action=comments 时必填，视频 aid（用 video 能查到）'),
    keyword: z.string().optional().describe('action=search 时必填，搜索词'),
    limit: z.number().optional().describe('要几条，默认推荐 10 条 / 评论 10 条 / 搜索 10 条')
  },
  async ({ key, token, action, bvid, aid, keyword, limit }) => {
    try {
      const data = await agentApi('/api/socialV2/bili', {
        method: 'POST',
        timeoutMs: 60000,
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, action, bvid, aid, keyword, limit })
      });
      return { content: [{ type: 'text', text: data?.text || '没有拿到内容。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `去 B 站看一眼失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
"""


def die(msg):
    print('FAIL: ' + msg)
    sys.exit(1)


def ensure(cond, msg):
    if not cond:
        die(msg)


bridge = io.open(BRIDGE, encoding='utf-8', newline='').read()
mcp = io.open(MCP, encoding='utf-8', newline='').read()
bridge_before, mcp_before = bridge, mcp
changed = []


# ═══════════════════════════════════════════════════════════════
# 一、桥接端点 /api/socialV2/bili
# ═══════════════════════════════════════════════════════════════
MARK_ROUTE = '// MARKER: bili-route'
ROUTE_ANCHOR = '        // MARKER: share-signal-route'

ROUTE_ADD = r"""        // MARKER: bili-route
        // B 站只读（MCP qq_bili 走这里）。
        //
        // 为什么要绕这么一圈：这台服务器的出口 IP 已被 B 站拉黑（/x/web-interface/view
        // 直接 -412 request was banned）。所以请求一律交给主人电脑上的浏览器扩展代发，
        // 桥接只负责排队、等结果、把 JSON 掰成人话。
        //
        // 只读：四个 action 全是 GET，没有点赞/投币/收藏/评论/发弹幕的代码路径。
        if (url.pathname === '/api/socialV2/bili' && req.method === 'POST') {
          try {
            const body = await readBody();
            const key = String(body.key ?? '').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }

            const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
            if (agentToken && !agentTokenOk(key, agentToken)) {
              sendJson({ ok: false, error: 'agent token 无效' }, 403);
              return;
            }
            if (agentToken && !v2SessionAllowed(key)) {
              sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
              return;
            }
            if (agentToken && !v2ToolEnabled('bili')) {
              sendJson({ ok: false, error: '工具未启用：bili' }, 403);
              return;
            }
            if (cfg.socialV2?.bili?.enabled === false) {
              sendJson({ ok: false, error: 'B 站浏览已在配置里关闭（socialV2.bili.enabled=false）' }, 403);
              return;
            }

            const action = String(body.action ?? '').trim();
            if (!['recommend', 'video', 'comments', 'search'].includes(action)) {
              sendJson({ ok: false, error: 'action 必须是 recommend / video / comments / search' }, 400);
              return;
            }

            // 参数校验要排在「桥在不在线」之前：扩展没开的时候，
            // 也应当能看出是自己把 action/keyword 写错了，而不是一句「离线」盖掉。
            if (action === 'search' && !String(body.keyword ?? '').trim()) {
              sendJson({ ok: false, error: '搜索要带 keyword' }, 400);
              return;
            }
            if ((action === 'video' || action === 'comments') && !String(body.bvid ?? '').trim() && !body.aid) {
              sendJson({ ok: false, error: action + ' 要带 bvid（评论也可以直接给 aid）' }, 400);
              return;
            }

            // 桥不在线就说清楚原因，别让模型以为 B 站挂了、然后反复重试。
            if (!phoneOnline()) {
              sendJson({ ok: false, error: describePhoneOffline(), offline: true }, 503);
              return;
            }

            const limit = Math.min(30, Math.max(1, Number(body.limit) || 10));
            const client = biliClient();
            let data;
            let text;
            if (action === 'recommend') {
              data = await client.recommend(limit);
              text = describeBiliResult('recommend', data);
            } else if (action === 'video') {
              data = await client.videoDetail(body.bvid);
              text = describeBiliResult('video', data);
            } else if (action === 'comments') {
              data = await client.comments(body.aid, { ps: limit });
              text = describeBiliResult('comments', data);
            } else {
              const kw = String(body.keyword ?? '').trim();
              data = await client.search(kw, { page: 1, ps: limit });
              text = describeBiliResult('search', { list: data, keyword: kw });
            }

            sendJson({ ok: true, action, text, data });
          } catch (error) {
            sendJson({ ok: false, error: 'B 站查询失败：' + (error?.message ?? error) }, 500);
          }
          return;
        }

"""

if MARK_ROUTE in bridge:
    print('  - 端点: 已装，跳过')
else:
    n = bridge.count(ROUTE_ANCHOR)
    ensure(n == 1, '端点锚点命中 %d 次（应为 1）' % n)
    bridge = bridge.replace(ROUTE_ANCHOR, ROUTE_ADD + ROUTE_ANCHOR, 1)
    changed.append('端点')
    print('  - 端点: 已插入')


# ── import 补 describeBiliResult / describePhoneOffline
MARK_IMPORT = '// MARKER: bili-import'
IMPORT_ANCHOR = "import { BiliClient } from './site-bili.js';"
IMPORT_ADD = ("import { BiliClient, describeBiliResult, describePhoneOffline } from './site-bili.js';")

if MARK_IMPORT in bridge:
    print('  - import: 已装，跳过')
else:
    n = bridge.count(IMPORT_ANCHOR)
    ensure(n == 1, 'import 锚点命中 %d 次（应为 1）' % n)
    bridge = bridge.replace(IMPORT_ANCHOR, IMPORT_ADD + '\n' + MARK_IMPORT, 1)
    changed.append('import')
    print('  - import: 已插入')


# ═══════════════════════════════════════════════════════════════
# 二、MCP 工具 qq_bili
# ═══════════════════════════════════════════════════════════════
MARK_TOOL = '// MARKER: bili-tool'
TOOL_ANCHOR = '// MARKER: ghosttool'

if MARK_TOOL in mcp:
    print('  - 工具: 已装，跳过')
else:
    n = mcp.count(TOOL_ANCHOR)
    ensure(n == 1, '工具锚点命中 %d 次（应为 1）' % n)
    mcp = mcp.replace(TOOL_ANCHOR, TOOL_ADD + '\n' + TOOL_ANCHOR, 1)
    changed.append('工具')
    print('  - 工具: 已插入')


# ── 工具开关登记
MARK_FLAG = '// MARKER: bili-flag'
# 锚点带上 ia-flag 注释：那一行原本就以它结尾，如果只锚到逗号，
# 新插入的行会把它夹在中间变成 `qq_bili: 'bili', // MARKER: bili-flag  // MARKER: ia-flag`
# （2026-10-23 线上真出现过，两个标记叠在一行）。
FLAG_ANCHOR = "  qq_image_approval: 'image', // MARKER: ia-flag"
FLAG_ADD = "  qq_bili: 'bili', // MARKER: bili-flag"

if MARK_FLAG in mcp:
    print('  - 开关: 已装，跳过')
else:
    n = mcp.count(FLAG_ANCHOR)
    ensure(n == 1, '开关锚点命中 %d 次（应为 1）' % n)
    mcp = mcp.replace(FLAG_ANCHOR, FLAG_ANCHOR + '\n' + FLAG_ADD, 1)
    changed.append('开关')
    print('  - 开关: 已插入')


# ═══════════════════════════════════════════════════════════════
# 三、断言：改完不能把原有东西吃掉
# ═══════════════════════════════════════════════════════════════
ensure(not changed or bridge.count("from './site-bili.js'") == 1, 'site-bili import 重复或丢失')
ensure(bridge.count("'/api/socialV2/bili'") == 1, '端点出现次数不对')
ensure('describePhoneOffline()' in bridge, '离线提示没接上')
ensure('biliClient()' in bridge, 'biliClient 调用丢了')
ensure(mcp.count("'qq_bili'") == 1, 'qq_bili 工具出现次数不对')
ensure("qq_bili: 'bili'" in mcp, '工具开关没登记')
ensure('server.connect(new StdioServerTransport());' in mcp, 'MCP 结尾被吃掉')
ensure('// MARKER: ghosttool' in mcp, 'ghosttool 锚点丢了')

if not changed:
    print('没有改动（全部已装）')
    sys.exit(0)

io.open(BRIDGE, 'w', encoding='utf-8', newline='').write(bridge)
io.open(MCP, 'w', encoding='utf-8', newline='').write(mcp)
print('改动：' + ', '.join(changed))
print('bridge.js: %d -> %d 字节（%+d）' % (len(bridge_before), len(bridge), len(bridge) - len(bridge_before)))
print('mcp-snowluma-safe.js: %d -> %d 字节（%+d）' % (len(mcp_before), len(mcp), len(mcp) - len(mcp_before)))
