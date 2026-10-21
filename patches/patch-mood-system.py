#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
情绪系统接线补丁（第 2 步）：把 mood-store.js 接进 bridge.js 与 MCP 工具层。

bridge.js 改 6 处、mcp-snowluma-safe.js 改 2 处。每处都断言命中次数，
任何一处对不上就整份不写盘 —— 半截补丁比没补丁更危险。

用法（在云上跑）：
    python3 /tmp/patch-mood-system.py
"""

import sys
from pathlib import Path

BRIDGE = Path('/opt/qq-bridge/src/bridge.js')
MCP = Path('/opt/qq-bridge/src/mcp-snowluma-safe.js')

failures = []


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        failures.append('[%s] 命中 %d 次，期望 1 次' % (label, n))
        return text
    return text.replace(old, new)


# ══ bridge.js ══════════════════════════════════════════════════════════════

src = BRIDGE.read_text(encoding='utf-8')

# ── 1. import ─────────────────────────────────────────────────────────────
src = sub(
    src,
    "} from './portrait-store.js';",
    """} from './portrait-store.js';
// 情绪：此刻的心情、长期底色、压着没说的事。纯逻辑在 mood-store.js，带单测。
import {
  readMood, writeMood, createDefaultMood, describeMood, setMood,
  ventUndercurrent, resolveUndercurrent, setAffinity, setBaseline, moodStats,
  MOOD_FILE as MOOD_STORE_FILE
} from './mood-store.js';""",
    'bridge/import',
)

# ── 2. 文件路径常量 ────────────────────────────────────────────────────────
src = sub(
    src,
    "const PORTRAIT_FILE = path.join(STATE_DIR, 'portrait.json');",
    """const PORTRAIT_FILE = path.join(STATE_DIR, 'portrait.json');
const MOOD_FILE_PATH = path.join(STATE_DIR, MOOD_STORE_FILE);""",
    'bridge/file-const',
)

# ── 3. config 默认值 ──────────────────────────────────────────────────────
src = sub(
    src,
    """  // 画像（长期认识）：跨会话，不按会话隔离（这正是它和 memberImpressions 的区别）。
  cfg.socialV2.portrait = {
    enabled: true,
    ...(cfg.socialV2?.portrait ?? {})
  };""",
    """  // 画像（长期认识）：跨会话，不按会话隔离（这正是它和 memberImpressions 的区别）。
  cfg.socialV2.portrait = {
    enabled: true,
    ...(cfg.socialV2?.portrait ?? {})
  };
  // 情绪（此刻的心情）：也跨会话 —— 心情不按群分，她在哪儿都是同一个人。
  cfg.socialV2.mood = {
    enabled: true,
    ...(cfg.socialV2?.mood ?? {})
  };""",
    'bridge/config',
)

# ── 4. store 单例 + 安全写 ────────────────────────────────────────────────
# 读取不缓存：情绪要按「现在」算衰减，缓存住反而容易拿到旧值。
# 文件只有几百字节，每次唤醒读一次的成本可以忽略。
src = sub(
    src,
    '  function portraitStore() {',
    """  let moodStoreWritable = true;

  function moodStore() {
    try {
      const s = readMood(MOOD_FILE_PATH);
      moodStoreWritable = true;
      return s;
    } catch (error) {
      moodStoreWritable = false;
      log(`⚠️ 情绪库读取失败，本次操作只读不写：${error?.message ?? error}`);
      throw new Error(`情绪库读取失败：${error?.message ?? error}`);
    }
  }

  function saveMoodSafe(store, label) {
    if (!moodStoreWritable) throw new Error(`${label}库当前为只读（读取失败过），拒绝写入以免覆盖`);
    try {
      writeMood(MOOD_FILE_PATH, store);
    } catch (error) {
      log(`保存${label}失败:`, error?.message ?? error);
      throw error;
    }
  }

  function portraitStore() {""",
    'bridge/store',
)

# ── 5. 每轮注入 ───────────────────────────────────────────────────────────
# 位置：紧跟【此刻状态】之后 —— 先说她现在身处什么局面，再说她心里什么滋味。
src = sub(
    src,
    "    const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + wakeLine + memoryLine + scheduleLine + scheduleReviewLine + portraitLine + participationLine + preSleepLine;",
    """    // 情绪（此刻的心情）：只给模糊的几行，不含数字。
    // 心情自己会淡，所以「读出衰减后的值」这件事必须发生在这一轮，不能靠定时器。
    let moodLine = '';
    if (cfg.socialV2?.mood?.enabled !== false) {
      try {
        const text = describeMood(moodStore(), Date.now());
        moodLine = text ? text + '\\n\\n' : '';
      } catch (error) {
        log(`[reserved2] 情绪注入跳过 ${key}：${error?.message ?? error}`);
      }
    }
    const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + moodLine + wakeLine + memoryLine + scheduleLine + scheduleReviewLine + portraitLine + participationLine + preSleepLine;""",
    'bridge/inject',
)

# ── 6. HTTP 路由 ─────────────────────────────────────────────────────────
src = sub(
    src,
    '        // ── 日程 / 画像：角色的短期记忆与长期认识 ──────────────────────────',
    """        // ── 情绪：此刻的心情、长期底色、压着没说的事 ────────────────────────
        // 数值（PAD 三点 + 好感度）只用来算衰减和阈值，对外一律给模糊文本 ——
        // 她自己看到的是「【此刻】有点烦 · 因为xxx」，不是 pleasure=-0.4。
        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/mood') {
          try {
            const q = url.searchParams;
            const body = req.method === 'POST' ? await readBody() : {};
            const key = String(body.key ?? q.get('key') ?? '').trim();
            const action = String(body.action ?? q.get('action') ?? 'read').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('mood')) { sendJson({ ok: false, error: '工具未启用：qq_mood' }, 403); return; }
            if (cfg.socialV2?.mood?.enabled === false) { sendJson({ ok: false, error: 'qq_mood 已在配置里关闭' }, 403); return; }

            const store = moodStore();
            if (action === 'read') {
              sendJson({
                ok: true, key, action,
                view: describeMood(store, Date.now()),
                stats: moodStats(store, Date.now()),
                // 暗流要带 id，否则她没法 resolve —— 注入里不展开内容，翻明细得主动看。
                undercurrent: store.undercurrent.map((it) => ({ id: it.id, text: it.text, weight: it.weight, at: it.at })),
                affinityNote: store.affinity.note
              });
              return;
            }
            if (action === 'set') {
              const next = setMood(store, {
                label: body.label,
                reason: body.reason,
                pleasure: body.pleasure,
                arousal: body.arousal,
                dominance: body.dominance
              });
              saveMoodSafe(next, '情绪');
              sendJson({ ok: true, key, action, view: describeMood(next, Date.now()), stats: moodStats(next, Date.now()) });
              return;
            }
            if (action === 'vent') {
              const next = ventUndercurrent(store, { text: body.text, weight: body.weight });
              saveMoodSafe(next, '情绪');
              sendJson({ ok: true, key, action, view: describeMood(next, Date.now()), undercurrent: next.undercurrent });
              return;
            }
            if (action === 'resolve') {
              const r = resolveUndercurrent(store, body.id ?? q.get('id'));
              if (!r.item) { sendJson({ ok: false, error: '找不到这件事（id=' + String(body.id ?? '') + '）' }, 404); return; }
              saveMoodSafe(r.state, '情绪');
              sendJson({ ok: true, key, action, resolved: r.item, view: describeMood(r.state, Date.now()), undercurrent: r.state.undercurrent });
              return;
            }
            if (action === 'affinity') {
              const next = setAffinity(store, { level: body.level, note: body.note });
              saveMoodSafe(next, '情绪');
              sendJson({ ok: true, key, action, affinity: next.affinity, view: describeMood(next, Date.now()) });
              return;
            }
            if (action === 'baseline') {
              const r = setBaseline(store, { pleasure: body.pleasure, arousal: body.arousal, dominance: body.dominance });
              saveMoodSafe(r.state, '情绪');
              sendJson({ ok: true, key, action, moved: r.moved, baseline: r.state.baseline, view: describeMood(r.state, Date.now()) });
              return;
            }
            sendJson({ ok: false, error: '不认识的 action：' + action + '（可用 read/set/vent/resolve/affinity/baseline）' }, 400);
          } catch (error) {
            sendJson({ ok: false, error: '情绪操作失败：' + (error?.message ?? error) }, 500);
          }
          return;
        }

        // ── 日程 / 画像：角色的短期记忆与长期认识 ──────────────────────────""",
    'bridge/route',
)

# ── 7. qq_get_prompt 的工具清单 ───────────────────────────────────────────
src = sub(
    src,
    """            portrait: 'qq_portrait'
          };""",
    """            portrait: 'qq_portrait',
            mood: 'qq_mood'
          };""",
    'bridge/tool-list',
)

BRIDGE_OUT = src

# ══ mcp-snowluma-safe.js ═══════════════════════════════════════════════════

msrc = MCP.read_text(encoding='utf-8')

# ── 8. 工具开关映射 ───────────────────────────────────────────────────────
msrc = sub(
    msrc,
    "  qq_portrait: 'portrait',",
    """  qq_portrait: 'portrait',
  qq_mood: 'mood',""",
    'mcp/flag',
)

# ── 9. 工具定义 ───────────────────────────────────────────────────────────
msrc = sub(
    msrc,
    '// MARKER: schedule-portrait',
    """server.tool(
  'qq_mood',
  '你自己的情绪。read=看现在什么心情（唤醒提示里本来就有摘要，不用常看）；set=写现在的心情（label 几个字，reason 为什么，可带 pleasure/arousal/dominance 三个 -1~1 的数，不传就只改文字）；vent=有件事压着没说，写进去（text，weight 0~1 表示多重）；resolve=那件事说出口了或者自己放下了，拿出来（id 从 read 里拿）；affinity=你对这个人的好感度（1~10，配一句 note 你怎么看他）；baseline=长期底色（一次最多挪 0.05，别常调——你觉得最近确实变了才调）。心情会自己慢慢淡掉，不用手动清。想写的时候才写，别每轮都改。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['read', 'set', 'vent', 'resolve', 'affinity', 'baseline']).describe('要做的事'),
    label: z.string().optional().describe('set：心情，几个字（例：有点烦 / 挺高兴 / 累）'),
    reason: z.string().optional().describe('set：为什么，一句话'),
    pleasure: z.number().optional().describe('set/baseline：愉快度 -1~1（-1 很难受，0 平，1 很高兴）'),
    arousal: z.number().optional().describe('set/baseline：激动度 -1~1（-1 很蔫，0 平，1 很亢奋）'),
    dominance: z.number().optional().describe('set/baseline：掌控感 -1~1（-1 很无力，0 平，1 很有底气）'),
    text: z.string().optional().describe('vent：压着的那件事，一句话'),
    weight: z.number().optional().describe('vent：这事有多重，0~1，默认 0.3'),
    id: z.string().optional().describe('resolve：哪件事（read 的返回里有 id）'),
    level: z.number().optional().describe('affinity：好感度 1~10'),
    note: z.string().optional().describe('affinity：一句你怎么看他')
  },
  async ({ key, token, action, label, reason, pleasure, arousal, dominance, text, weight, id, level, note }) => {
    try {
      if (action === 'read') {
        const q = new URLSearchParams({ key, action: 'read' });
        const data = await agentApi('/api/socialV2/mood?' + q.toString(), { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      const data = await agentApi('/api/socialV2/mood', {
        method: 'POST',
        body: JSON.stringify({ key, token, action, label, reason, pleasure, arousal, dominance, text, weight, id, level, note }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '情绪操作失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// MARKER: schedule-portrait""",
    'mcp/tool',
)

MCP_OUT = msrc

# ══ 落盘 ═══════════════════════════════════════════════════════════════════

if failures:
    print('补丁失败，未写盘：')
    for f in failures:
        print('  - ' + f)
    sys.exit(1)

BRIDGE.write_text(BRIDGE_OUT, encoding='utf-8')
MCP.write_text(MCP_OUT, encoding='utf-8')
print('✅ bridge.js 改 7 处、mcp-snowluma-safe.js 改 2 处，全部命中')
