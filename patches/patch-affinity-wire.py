#!/usr/bin/env python3
"""好感度接线：按会话存储 + 注入 prompt + 长期未改提醒。

用法：
    python3 patch-affinity-wire.py [bridge.js 路径]

默认改 /opt/qq-bridge/src/bridge.js；传参可改隔离副本。

五处落点：
  1. import  affinity-store
  2. 状态文件路径 AFFINITY_FILE
  3. 接线层：读/写/注入/提醒
  4. qq_mood action=affinity 写入点：同时写新表（旧全局仍写，保证兼容）
  5. buildWakePromptV2 注入 affinityLine

设计约束（主人 2026-10-22 定，别改）：
  · 按会话各存一份，没存过就是没有 —— **绝不回退到全局**。
    老文件 state/情绪.json 里那份全局 affinity 是「最后在哪说的就归谁」，
    拿它当所有人的默认值，正是要消灭的串台。
  · 保持手动，不由系统自动打分。只在长期没动过时提醒一句。
  · **只注入 note 原文，不注入数字**（图里「不被数字框住，喜欢谁由她自己判断」）。
"""
import sys

SRC_PATH = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'

with open(SRC_PATH, 'r', encoding='utf-8') as f:
    SRC = f.read()

orig_len = len(SRC)
changed = []


def ensure(cond, msg):
    if not cond:
        raise SystemExit('FAIL: ' + msg)


def apply(marker, anchor, addition, label, before=False):
    """插入；marker 已存在则跳过（幂等）。anchor 命中数必须恰好 1。"""
    global SRC
    if marker in SRC:
        print('  [skip] %s（已装）' % label)
        return
    n = SRC.count(anchor)
    ensure(n == 1, '%s 的锚点命中 %d 次（应为 1）：%r' % (label, n, anchor[:80]))
    if before:
        SRC = SRC.replace(anchor, addition + anchor, 1)
    else:
        SRC = SRC.replace(anchor, addition, 1)
    changed.append(label)
    print('  [ok]   %s' % label)


# ── 1. import ────────────────────────────────────────────────────────────
IMPORT_ANCHOR = "} from './group-digest-store.js';"
IMPORT_ADD = r"""} from './group-digest-store.js';

// MARKER: affinity
// 好感度：按会话各存一份（不再共用 mood-store 里那个全局单值）。
// 只注入 note 原文不注入数字；只在她长期没动过时提醒，不自动打分。
import {
  getAffinity,
  setAffinity as setAffinityByKey,
  shouldNudgeAffinity,
  formatAffinityLine,
  formatAffinityNudge,
  loadAffinityState,
  saveAffinityState,
  normalizeAffinityKey
} from './affinity-store.js';"""

apply('// MARKER: affinity\n', IMPORT_ANCHOR, IMPORT_ADD, 'import')

# ── 2. 状态文件 ──────────────────────────────────────────────────────────
FILE_ANCHOR = "const SLEEP_REVIEW_FILE = path.join(STATE_DIR, 'sleep-review.json');"
FILE_ADD = FILE_ANCHOR + r"""

// MARKER: affinity-file
const AFFINITY_FILE = path.join(STATE_DIR, 'affinity.json');"""

apply('// MARKER: affinity-file', FILE_ANCHOR, FILE_ADD, '状态文件路径')

# ── 3. 接线层 ────────────────────────────────────────────────────────────
WIRE_ANCHOR = "  // MARKER: group-digest-wire"
WIRE_ADD = r"""  // MARKER: affinity-wire
  // ── 好感度的接线层 ────────────────────────────────────────────────────
  //
  // 三件事：读当前会话的好感度、拼进唤醒 prompt、长期没动过时提一句。
  // 全部只读 + 一次可能的落盘，不新增定时器。

  let affinityCache = null;

  function getAffinityState() {
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
  }

  function saveAffinitySafe(reason) {
    try {
      saveAffinityState(AFFINITY_FILE, getAffinityState());
    } catch (error) {
      log(`[affinity] 落盘失败（${reason}）：${error?.message ?? error}`);
    }
  }

  /** 当前会话对她眼里「这个人」的评价（没有就是 null）。 */
  function affinityEntryFor(key) {
    try {
      return getAffinity(getAffinityState().affinities, key);
    } catch {
      return null;
    }
  }

  /**
   * 写入某个会话的好感度，并记一次「已提醒」时间清零用不上。
   * 供 qq_mood action=affinity 调用（旧的全局写入仍然保留，见调用点）。
   */
  function recordAffinityForKey(key, { level, note }) {
    const st = getAffinityState();
    const { map } = setAffinityByKey(st.affinities, { key, level, note, now: Date.now() });
    st.affinities = map;
    // 她自己改过，就没必要再提醒「该看看了」
    if (st.nudgeAt) delete st.nudgeAt[normalizeAffinityKey(key) ?? key];
    saveAffinitySafe('write');
    return map[normalizeAffinityKey(key) ?? key];
  }

  /** 唤醒 prompt 里的好感度行 +（间隔足够时）一句提醒。 */
  function buildAffinityLineFor(key) {
    if (cfg.socialV2?.affinity?.enabled === false) return '';
    const entry = affinityEntryFor(key);
    if (!entry) return '';
    let out = formatAffinityLine({ entry, key, ownerQQ: cfg.ownerQQ });
    try {
      const st = getAffinityState();
      if (shouldNudgeAffinity({ entry, lastNudgedAt: st.nudgeAt?.[key], now: Date.now() })) {
        out += formatAffinityNudge({ entry, key, ownerQQ: cfg.ownerQQ });
        if (!st.nudgeAt || typeof st.nudgeAt !== 'object') st.nudgeAt = {};
        st.nudgeAt[key] = Date.now();
        saveAffinitySafe('nudge');
        log(`[affinity] 提醒她重新看看 ${key} 的好感度`);
      }
    } catch (error) {
      log(`[affinity] 提醒判定跳过 ${key}：${error?.message ?? error}`);
    }
    return out;
  }

""" + WIRE_ANCHOR

apply('// MARKER: affinity-wire', WIRE_ANCHOR, WIRE_ADD, '接线层')

# ── 4. qq_mood action=affinity 同时写新表 ───────────────────────────────
MOOD_ANCHOR = """            if (action === 'affinity') {
              const next = setAffinity(store, { level: body.level, note: body.note });
              saveMoodSafe(next, '情绪');
              sendJson({ ok: true, key, action, affinity: next.affinity, view: describeMood(next, Date.now()) });
              return;
            }"""
MOOD_ADD = """            if (action === 'affinity') {
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

apply('// MARKER: affinity-write', MOOD_ANCHOR, MOOD_ADD, 'qq_mood 写入点')

# ── 5. 注入 ─────────────────────────────────────────────────────────────
BASE_ANCHOR = "    const groupDigestLine = buildGroupDigestLineFor(key);"
INJECT_ADD = """    // MARKER: affinity-inject
    const affinityLine = buildAffinityLineFor(key);
""" + BASE_ANCHOR

apply('// MARKER: affinity-inject', BASE_ANCHOR, INJECT_ADD, '注入声明')

# 拼进 base：先把 memoryLine 后面加上 affinityLine
BASE2_FROM = "const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + moodLine + imageLine + wakeLine + memoryLine + sharedMemoryLine + groupDigestLine + sleepReviewLine +"
BASE2_TO = "const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + moodLine + imageLine + wakeLine + memoryLine + sharedMemoryLine + affinityLine + groupDigestLine + sleepReviewLine +"

if '+ sharedMemoryLine + affinityLine +' in SRC:
    print('  [skip] base 拼接（已装）')
else:
    n = SRC.count(BASE2_FROM)
    ensure(n == 1, 'base 拼接锚点命中 %d 次（应为 1）' % n)
    SRC = SRC.replace(BASE2_FROM, BASE2_TO, 1)
    changed.append('base 拼接')
    print('  [ok]   base 拼接')

# ── 事后断言 ────────────────────────────────────────────────────────────
ensure(SRC.count('buildAffinityLineFor(') == 2, 'buildAffinityLineFor 应出现 2 次（定义+调用）')
ensure(SRC.count('recordAffinityForKey(') == 2, 'recordAffinityForKey 应出现 2 次（定义+调用）')
ensure('+ sharedMemoryLine + affinityLine +' in SRC, 'base 里没拼上 affinityLine')
# 只注入 note 不注入数字：调用点必须是 formatAffinityLine({ entry, key, ownerQQ })，
# 不能把 level 或 entry.level 传进注入链路（数字只在 store 内部判断提醒用）。
ensure('formatAffinityLine({ entry, key, ownerQQ: cfg.ownerQQ })' in SRC, 'formatAffinityLine 调用形态不对')
ensure('entry.level' not in SRC, '注入链路不该出现 entry.level（只注 note 原文）')
ensure(SRC.count('// MARKER: affinity\n') == 1, 'affinity MARKER 重复')
ensure(SRC.count('// MARKER: affinity-wire') == 1, 'affinity-wire MARKER 重复')

with open(SRC_PATH, 'w', encoding='utf-8') as f:
    f.write(SRC)

print('\n完成：%s → %s 字节（%+d），改动 %d 处' % (
    orig_len, len(SRC), len(SRC) - orig_len, len(changed)))
for c in changed:
    print('  · ' + c)
