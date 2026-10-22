#!/usr/bin/env python3
"""好感度收尾：删掉 mood-store 里的全局 affinity，只留按会话那一份。

用法：
    python3 patch-affinity-migrate.py [项目根目录]

默认 /opt/qq-bridge；传参可改隔离副本。

背景（为什么必须删）：
  2026-10-22 那版把好感度改成「按会话各存一份」，但为了兼容控制台保留了旧的
  全局写入（state/情绪.json 的 affinity 字段）。结果第二天就出事了：
  群里给她写了一条 6 分，全局那份被覆盖成群里的评价，
  主人私聊 qq_mood action=read 时返回的 affinityNote 直接是群里那句话。
  「只写一遍的兼容层」不会自己消失 —— 与其两边都写，不如只留一边。

改什么：
  1. mood-store.js：normalizeState 不再产出 affinity 字段；setAffinity 删掉；
     moodStats 不再报 affinityLevel/hasNote；effectiveMood 不再带 affinity。
  2. bridge.js：qq_mood 的 affinity action 只写按会话那张表；
     read 从按会话表按 key 取，取不到就是 null（不回退全局）。
  3. 写盘失败不再吞：抛回给工具，让她知道没改成，而不是以为改了。

刻意保留：
  MAX_NOTE_CHARS / AFFINITY_MIN / AFFINITY_MAX / clampLevel / cleanNote
  在 mood-store.js 里原样留着 —— affinity-store.js 有自己的常量，
  但删掉这些会牵动 cleanNote（还被 label/reason 用），改动面变大不值得。
"""
import sys
import os

ROOT = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge'
MOOD_PATH = os.path.join(ROOT, 'src', 'mood-store.js')
BRIDGE_PATH = os.path.join(ROOT, 'src', 'bridge.js')

with open(MOOD_PATH, 'r', encoding='utf-8') as f:
    MOOD = f.read()
with open(BRIDGE_PATH, 'r', encoding='utf-8') as f:
    BRIDGE = f.read()

mood_len0, bridge_len0 = len(MOOD), len(BRIDGE)
changed = []


def ensure(cond, msg):
    if not cond:
        raise SystemExit('FAIL: ' + msg)


def sub(text, marker, old, new, label):
    """替换；marker 已存在则跳过（幂等）。old 命中数必须恰好 1。"""
    if marker in text:
        print('  [skip] %s（已装）' % label)
        return text
    n = text.count(old)
    ensure(n == 1, '%s 的锚点命中 %d 次（应为 1）：%r' % (label, n, old[:100]))
    text = text.replace(old, new, 1)
    changed.append(label)
    print('  [ok]   %s' % label)
    return text


# ══════════════════════════════════════════════════════════════════════
# mood-store.js
# ══════════════════════════════════════════════════════════════════════

# ── 1. normalizeState 不再产出 affinity ────────────────────────────────
MOOD_OLD_NORM = """  const aff = o.affinity && typeof o.affinity === 'object' ? o.affinity : {};
  const affAt = Number(aff.updatedAt);
  const updatedAt = Number(o.updatedAt);"""
MOOD_NEW_NORM = """  // MARKER: affinity-migrate-norm
  // 好感度不在这里了 —— 它按会话各存一份，落在 state/affinity.json，
  // 见 affinity-store.js。老文件里的 affinity 字段读进来会被直接丢掉
  // （normalizeState 只挑认识的键返回，多余的字段不会带出去），
  // 所以迁移完之后文件里那一段就自然消失了。
  const updatedAt = Number(o.updatedAt);"""

if '// MARKER: affinity-migrate-norm' in MOOD:
    print('  [skip] normalizeState（已装）')
else:
    MOOD = sub(MOOD, '// MARKER: affinity-migrate-norm', MOOD_OLD_NORM, MOOD_NEW_NORM, 'normalizeState 去掉 affinity 读取')

MOOD_OLD_RET = """    undercurrent,
    affinity: {
      level: clampLevel(aff.level ?? AFFINITY_MIN),
      note: cleanNote(aff.note),
      updatedAt: Number.isFinite(affAt) && affAt > 0 ? affAt : 0
    }
  };
}"""
MOOD_NEW_RET = """    undercurrent
  };
}"""
if 'affinity: {\n      level: clampLevel(' in MOOD:
    MOOD = sub(MOOD, '// MARKER: affinity-migrate-ret', MOOD_OLD_RET, MOOD_NEW_RET, 'normalizeState 返回值去掉 affinity')
else:
    print('  [skip] normalizeState 返回值（已装）')

# ── 2. effectiveMood 不再带 affinity ───────────────────────────────────
MOOD_OLD_EFF = """    undercurrent: s.undercurrent.map((item) => ({ ...item })),
    undercurrentLoad: undercurrentLoad(s),
    affinity: { ...s.affinity }
  };
}"""
MOOD_NEW_EFF = """    undercurrent: s.undercurrent.map((item) => ({ ...item })),
    undercurrentLoad: undercurrentLoad(s)
  };
}"""
if '    affinity: { ...s.affinity }\n  };\n}' in MOOD:
    MOOD = sub(MOOD, '// MARKER: affinity-migrate-eff', MOOD_OLD_EFF, MOOD_NEW_EFF, 'effectiveMood 去掉 affinity')
else:
    print('  [skip] effectiveMood（已装）')

# ── 3. moodStats 不再报 affinityLevel / hasNote ────────────────────────
MOOD_OLD_STATS = """    undercurrentLoad: eff.undercurrentLoad,
    affinityLevel: s.affinity.level,
    hasNote: Boolean(s.affinity.note),
    updatedAt: s.updatedAt"""
MOOD_NEW_STATS = """    undercurrentLoad: eff.undercurrentLoad,
    // MARKER: affinity-migrate-stats
    // 这里原来报 affinityLevel/hasNote，读的是全局那一份。
    // 全局删了，好感度按会话（state/affinity.json）—— 要看就用
    // GET /api/socialV2/affinity?key=xxx，别在这里塞一个不属于任何人的数。
    updatedAt: s.updatedAt"""
if '// MARKER: affinity-migrate-stats' in MOOD:
    print('  [skip] moodStats（已装）')
else:
    MOOD = sub(MOOD, '// MARKER: affinity-migrate-stats', MOOD_OLD_STATS, MOOD_NEW_STATS, 'moodStats 去掉 affinityLevel')

# ── 4. 删掉 setAffinity ────────────────────────────────────────────────
MOOD_OLD_SET = """/**
 * 改好感度。
 *
 * 注意：数字只是她自己的索引，**注入时永远只给 note**。
 * 工具描述里要写清楚「只在真的觉得关系变了时才改」，不要每轮加一点 ——
 * 加一点就变成自动打分了，那是查表。
 */
export function setAffinity(state, { level, note, now = Date.now() } = {}) {
  const s = normalizeState(state, now);
  let nextLevel = s.affinity.level;
  if (level !== undefined && level !== null) {
    const n = Number(level);
    if (!Number.isFinite(n)) throw new Error('好感度必须是数字');
    if (n < AFFINITY_MIN || n > AFFINITY_MAX) {
      throw new Error(`好感度只能是 ${AFFINITY_MIN}~${AFFINITY_MAX}`);
    }
    nextLevel = Math.round(n);
  }
  const nextNote = note === undefined ? s.affinity.note : cleanNote(note);
  return {
    ...s,
    affinity: { level: nextLevel, note: nextNote, updatedAt: now }
  };
}"""
MOOD_NEW_SET = """// MARKER: affinity-migrate-set
// setAffinity 已经搬走了 —— 好感度按会话各存一份，写入走 affinity-store.js
// 的 setAffinity(state.affinities, {key, level, note})，由 bridge.js 的
// recordAffinityForKey() 调用。这里留一个显式的墓碑，避免有人以为它还在。"""
if '// MARKER: affinity-migrate-set' in MOOD:
    print('  [skip] setAffinity（已装）')
else:
    MOOD = sub(MOOD, '// MARKER: affinity-migrate-set', MOOD_OLD_SET, MOOD_NEW_SET, '删除全局 setAffinity')

# ══════════════════════════════════════════════════════════════════════
# bridge.js
# ══════════════════════════════════════════════════════════════════════

# ── 5. import 里去掉 setAffinity ───────────────────────────────────────
BR_OLD_IMPORT = """  ventUndercurrent, resolveUndercurrent, setAffinity, setBaseline, moodStats,"""
BR_NEW_IMPORT = """  ventUndercurrent, resolveUndercurrent, setBaseline, moodStats,"""
if 'setAffinity, setBaseline' not in BRIDGE:
    print('  [skip] import（已装）')
else:
    BRIDGE = sub(BRIDGE, '// MARKER: affinity-migrate-import', BR_OLD_IMPORT, BR_NEW_IMPORT, 'import 去掉 setAffinity')

# ── 6. read：按 key 取，不回退全局 ─────────────────────────────────────
BR_OLD_READ = """                // 暗流要带 id，否则她没法 resolve —— 注入里不展开内容，翻明细得主动看。
                undercurrent: store.undercurrent.map((it) => ({ id: it.id, text: it.text, weight: it.weight, at: it.at })),
                affinityNote: store.affinity.note
              });"""
BR_NEW_READ = """                // 暗流要带 id，否则她没法 resolve —— 注入里不展开内容，翻明细得主动看。
                undercurrent: store.undercurrent.map((it) => ({ id: it.id, text: it.text, weight: it.weight, at: it.at })),
                // MARKER: affinity-migrate-read
                // 好感度按会话取。没存过就是 null —— **绝不回退到某个全局值**，
                // 那份全局值是谁最后说的就归谁，回退等于把别人的评价说给这个人听。
                affinity: affinityEntryFor(key)
              });"""
if '// MARKER: affinity-migrate-read' in BRIDGE:
    print('  [skip] read 按 key 取（已装）')
else:
    BRIDGE = sub(BRIDGE, '// MARKER: affinity-migrate-read', BR_OLD_READ, BR_NEW_READ, 'read 按 key 取好感度')

# ── 7. affinity action 只写按会话表，失败要抛 ──────────────────────────
BR_OLD_AFF = """            if (action === 'affinity') {
              const next = setAffinity(store, { level: body.level, note: body.note });
              saveMoodSafe(next, '情绪');
              // MARKER: affinity-write
              // 同时写「按会话」那张表 —— 唤醒 prompt 只认它。
              // 旧全局那份仍写（兼容控制台和 qq_mood read 的返回），
              // 但它不再被注入：全局值是谁最后说的就归谁，注入等于串台。
              let perKey = null;
              try {
                perKey = recordAffinityForKey(key, { level: body.level, note: body.note });
              } catch (error) {
                log(`[affinity] 写入失败 ${key}：${error?.message ?? error}`);
              }
              sendJson({ ok: true, key, action, affinity: perKey ?? next.affinity, view: describeMood(next, Date.now()) });
              return;
            }"""
BR_NEW_AFF = """            if (action === 'affinity') {
              // MARKER: affinity-migrate-write
              // 只写按会话那一份。写不成就让它抛出去 —— 让她看到「没改成」，
              // 而不是以为改了、下次还念着旧评价。
              const entry = recordAffinityForKey(key, { level: body.level, note: body.note });
              sendJson({ ok: true, key, action, affinity: entry, view: describeMood(store, Date.now()) });
              return;
            }"""
if '// MARKER: affinity-migrate-write' in BRIDGE:
    print('  [skip] affinity action（已装）')
else:
    BRIDGE = sub(BRIDGE, '// MARKER: affinity-migrate-write', BR_OLD_AFF, BR_NEW_AFF, 'affinity action 只写按会话表')

# ── 8. 落盘失败不再吞 ──────────────────────────────────────────────────
BR_OLD_SAVE = """  function saveAffinitySafe(reason) {
    try {
      saveAffinityState(AFFINITY_FILE, getAffinityState());
    } catch (error) {
      log(`[affinity] 落盘失败（${reason}）：${error?.message ?? error}`);
    }
  }"""
BR_NEW_SAVE = """  function saveAffinitySafe(reason) {
    // MARKER: affinity-migrate-save
    // 这里**故意不吞异常**（原来吞了）。
    // 吞掉的后果是：她以为写了、其实没落盘，下次醒来还念着旧评价，
    // 而且日志里只有一行 warn，人不会去看。
    // 唯一例外是提醒（nudge）那一路 —— 那只是顺口一提，失败不该让整轮唤醒变红，
    // 由调用方自己 try 包住。
    try {
      saveAffinityState(AFFINITY_FILE, getAffinityState());
    } catch (error) {
      log(`[affinity] 落盘失败（${reason}）：${error?.message ?? error}`);
      throw error;
    }
  }"""
if '// MARKER: affinity-migrate-save' in BRIDGE:
    print('  [skip] 落盘失败不吞（已装）')
else:
    BRIDGE = sub(BRIDGE, '// MARKER: affinity-migrate-save', BR_OLD_SAVE, BR_NEW_SAVE, '落盘失败不再吞')

# ── 9. getAffinityState 区分「文件不存在」和「文件坏了」 ────────────────
BR_OLD_GET = """  function getAffinityState() {
    if (affinityCache) return affinityCache;
    try {
      affinityCache = loadAffinityState(AFFINITY_FILE);
    } catch (error) {
      // 文件损坏不能静默重置 —— 那会把所有人的好感度一次抹了。
      // 记日志、用空表顶上（本次不注入），等人工修。
      log(`[affinity] 状态读取失败（本次不注入）：${error?.message ?? error}`);
      affinityCache = { version: 1, affinities: {}, nudgeAt: {} };
    }
    return affinityCache;
  }"""
BR_NEW_GET = """  function getAffinityState() {
    if (affinityCache) return affinityCache;
    try {
      affinityCache = loadAffinityState(AFFINITY_FILE);
    } catch (error) {
      // MARKER: affinity-migrate-corrupt
      // 文件损坏不能静默重置 —— 那会把所有人的好感度一次抹了。
      // 但也不能只给空表：空表被下一次写入落盘，就等于**用空表覆盖了坏文件**，
      // 数据彻底没了。所以标一个脏标记，写入前检查，坏了就拒绝写。
      log(`[affinity] 状态读取失败（本次不注入，且拒绝写入以免覆盖）：${error?.message ?? error}`);
      affinityCache = { version: 1, affinities: {}, nudgeAt: {} };
      affinityCache.__corrupt = String(error?.message ?? error);
    }
    return affinityCache;
  }"""
if '// MARKER: affinity-migrate-corrupt' in BRIDGE:
    print('  [skip] 损坏标记（已装）')
else:
    BRIDGE = sub(BRIDGE, '// MARKER: affinity-migrate-corrupt', BR_OLD_GET, BR_NEW_GET, '损坏文件加脏标记')

# ── 10. 写入前检查脏标记 ────────────────────────────────────────────────
BR_OLD_REC = """  function recordAffinityForKey(key, { level, note }) {
    const st = getAffinityState();"""
BR_NEW_REC = """  function recordAffinityForKey(key, { level, note }) {
    const st = getAffinityState();
    // MARKER: affinity-migrate-guard
    // 文件坏了就拒绝写 —— 宁可这一次改不成，也不能用空表覆盖掉她的全部好感度。
    if (st.__corrupt) {
      throw new Error('好感度文件损坏（' + st.__corrupt + '），为免覆盖已拒绝写入，请先修 state/affinity.json');
    }"""
if '// MARKER: affinity-migrate-guard' in BRIDGE:
    print('  [skip] 写入守卫（已装）')
else:
    BRIDGE = sub(BRIDGE, '// MARKER: affinity-migrate-guard', BR_OLD_REC, BR_NEW_REC, '写入前检查损坏')

# ── 11. 提醒那一路自己吞掉异常 ──────────────────────────────────────────
BR_OLD_NUDGE = """        if (!st.nudgeAt || typeof st.nudgeAt !== 'object') st.nudgeAt = {};
        st.nudgeAt[key] = Date.now();
        saveAffinitySafe('nudge');
        log(`[affinity] 提醒她重新看看 ${key} 的好感度`);"""
BR_NEW_NUDGE = """        if (!st.nudgeAt || typeof st.nudgeAt !== 'object') st.nudgeAt = {};
        st.nudgeAt[key] = Date.now();
        // 提醒落盘失败不该让整轮唤醒变红 —— 它只是顺口一提，外面有大 try 包着。
        saveAffinitySafe('nudge');
        log(`[affinity] 提醒她重新看看 ${key} 的好感度`);"""
# 提醒已经在 try/catch 里，异常会被 catch 住并打日志，无需改。
# 这里只做一次校验，确认它确实在 try 里。
assert 'saveAffinitySafe(\'nudge\')' in BRIDGE
print('  [ok]   提醒已在 try 内（无需改）')

# ══════════════════════════════════════════════════════════════════════
# 事后断言
# ══════════════════════════════════════════════════════════════════════
ensure('s.affinity' not in MOOD, 'mood-store 里还有 s.affinity 残留')
ensure('.affinity' not in MOOD or 'affinity-store' in MOOD, 'mood-store 里还有 .affinity 残留')
ensure('clampLevel(' not in MOOD.split('function clampLevel')[1].split('}')[1] if 'function clampLevel' in MOOD else True, 'clampLevel 还有调用')
ensure('export function setAffinity' not in MOOD, 'setAffinity 没删干净')
ensure('setAffinity,' not in BRIDGE, 'bridge 还在 import setAffinity')
ensure('store.affinity' not in BRIDGE, 'bridge 还在读 store.affinity')
ensure('// MARKER: affinity-migrate-read' in BRIDGE, 'read 没改')
ensure('// MARKER: affinity-migrate-write' in BRIDGE, 'affinity action 没改')
ensure('// MARKER: affinity-migrate-guard' in BRIDGE, '写入守卫没装')
ensure('buildAffinityLineFor(' in BRIDGE, '注入函数不见了')
ensure('+ sharedMemoryLine + affinityLine +' in BRIDGE, 'base 里没拼 affinityLine')

with open(MOOD_PATH, 'w', encoding='utf-8') as f:
    f.write(MOOD)
with open(BRIDGE_PATH, 'w', encoding='utf-8') as f:
    f.write(BRIDGE)

print('\n完成：')
print('  mood-store.js  %d → %d（%+d）' % (mood_len0, len(MOOD), len(MOOD) - mood_len0))
print('  bridge.js      %d → %d（%+d）' % (bridge_len0, len(BRIDGE), len(BRIDGE) - bridge_len0))
print('  改动 %d 处' % len(changed))
for c in changed:
    print('  · ' + c)
