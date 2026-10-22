#!/usr/bin/env python3
"""群聊近况（D）+ 睡眠整合接线。

用法：
    python3 patch-group-digest-wire.py [bridge.js 路径]

默认改 /opt/qq-bridge/src/bridge.js；传参可改隔离副本。

六处落点：
  1. import  group-digest-store
  2. 状态文件路径 SLEEP_REVIEW_FILE（睡眠回顾的「今天做过没」记账）
  3. 接线层：群近况判定 + 拼摘要；睡眠回顾判定 + 拼素材
  4. buildWakePromptV2 里加 groupDigestLine（D）
  5. buildWakePromptV2 里加 sleepReviewLine（睡眠整合）
  6. base 拼接行加这两段

关键前提（踩过的坑，别改）：
  · 主人说话必须用 `isOwner && !isSelf` 判断 —— recordSentMessagesV2 写她自己
    的消息时 isOwner 也是 true（见 /opt/qq-bridge/src/bridge.js 的
    recordSentMessagesV2），只查 isOwner 会把她自己的话当成主人在问。
  · 睡眠回顾「今天做过没」必须落盘，否则重启后每轮都念一次。
  · 两段都必须算完再拼进 base —— 只算不拼 = 装了没生效。
"""
import sys
import os

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
IMPORT_ANCHOR = "} from './share-signal-store.js';"
IMPORT_ADD = r"""} from './share-signal-store.js';

// MARKER: group-digest
// 群聊近况（D：主人问起才给）+ 睡眠整合（每天 4 点后她第一次醒来时回顾）。
// 纯逻辑在 group-digest-store.js，这里只负责取数据、拼句子、记账。
import {
  asksAboutGroups,
  pickGroupFor,
  formatGroupDigest,
  listGroupCandidates,
  shouldSleepReview,
  markSleepReviewed,
  formatSleepReviewMaterial,
  localDayOf
} from './group-digest-store.js';"""

apply('// MARKER: group-digest', IMPORT_ANCHOR, IMPORT_ADD, 'import')

# ── 2. 状态文件 ──────────────────────────────────────────────────────────
FILE_ANCHOR = "const SHARE_SIGNAL_FILE = path.join(STATE_DIR, 'share-signal.json');"
FILE_ADD = FILE_ANCHOR + r"""

// MARKER: group-digest-file
// 睡眠回顾的「今天做过没」记账（{ reviewDays: { [key]: 'YYYY-MM-DD' } }）。
const SLEEP_REVIEW_FILE = path.join(STATE_DIR, 'sleep-review.json');"""

apply('// MARKER: group-digest-file', FILE_ANCHOR, FILE_ADD, '状态文件路径')

# ── 3. 接线层 ────────────────────────────────────────────────────────────
WIRE_ANCHOR = "  function v2ToolEnabled(flag) {"
WIRE_ADD = r"""  // MARKER: group-digest-wire
  // ── 群聊近况 + 睡眠整合的接线层 ────────────────────────────────────────
  //
  // 两件事都只在**唤醒 prompt 拼装时**发生，不新增定时器、不主动投递：
  //   · D：主人私聊里问起某个群 → 只注入那一个群的最近几条。
  //   · 睡眠整合：4 点后她第一次自然醒来 → 注入「今天发生过什么」+ 提醒补日记。

  let sleepReviewCache = null;

  function getSleepReviewState() {
    if (sleepReviewCache) return sleepReviewCache;
    try {
      const raw = readJsonSafe(SLEEP_REVIEW_FILE, null, false);
      sleepReviewCache = raw && typeof raw === 'object' ? raw : { reviewDays: {} };
      if (!sleepReviewCache.reviewDays || typeof sleepReviewCache.reviewDays !== 'object') sleepReviewCache.reviewDays = {};
    } catch (error) {
      // 读不出来就当没做过 —— 最坏结果是多念一次，不会丢数据。
      log(`[sleep-review] 状态读取失败：${error?.message ?? error}`);
      sleepReviewCache = { reviewDays: {} };
    }
    return sleepReviewCache;
  }

  function saveSleepReviewState() {
    try {
      atomicWriteJson(SLEEP_REVIEW_FILE, getSleepReviewState());
    } catch (error) {
      log(`[sleep-review] 状态落盘失败：${error?.message ?? error}`);
    }
  }

  /**
   * 取这个会话里**主人**最后说的一句话。
   *
   * ⚠️ 必须是 `isOwner && !isSelf`：recordSentMessagesV2 写她自己发的消息时
   * isOwner 也是 true，只查 isOwner 会把她的发言当成主人在问。
   */
  function lastOwnerUtterance(st) {
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (m && m.isOwner && !m.isSelf) {
        const text = String(m.plain ?? m.text ?? '').trim();
        if (text) return text;
      }
    }
    return '';
  }

  /**
   * D：主人问起群时，返回那个群的近况文本；否则空串。
   *
   * 只在主人私聊里生效 —— 群里她自己就在现场，不需要再从记忆里翻。
   */
  function buildGroupDigestLineFor(key) {
    if (!key || key !== `private:${cfg.ownerQQ}`) return '';
    try {
      const st = getSocialV2State(key);
      const said = lastOwnerUtterance(st);
      if (!said || !asksAboutGroups(said)) return '';
      const candidates = listGroupCandidates(socialV2.conversations);
      if (!candidates.length) return '';
      const target = pickGroupFor(said, candidates);
      if (!target) return '';
      const conv = socialV2.conversations.get(target);
      const messages = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
      const digest = formatGroupDigest({ key: target, messages, now: Date.now() });
      if (!digest) return '';
      log(`[group-digest] 主人问起群，注入 ${target} 的近况（${messages.length} 条里取最后几条）`);
      return digest + '\n\n';
    } catch (error) {
      // 群近况是锦上添花，读不出来就当没问过，绝不连累唤醒。
      log(`[group-digest] 跳过 ${key}：${error?.message ?? error}`);
      return '';
    }
  }

  /**
   * 睡眠整合：4 点后第一次醒来时，给她今天发生过的摘要 + 提醒补日记。
   *
   * 图里的要求是「只是提醒，不强制」—— 所以文案里明说可以什么都不做。
   * 做过就落盘记今天，当天不再念。
   */
  function buildSleepReviewLineFor(key) {
    if (cfg.socialV2?.sleepReview?.enabled === false) return '';
    let sleepSt;
    try {
      sleepSt = getSleepReviewState();
    } catch {
      return '';
    }
    const now = new Date();
    const nowMs = now.getTime();
    // 今天 0 点起算「今天」
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const material = formatSleepReviewMaterial({
      conversations: Object.fromEntries(socialV2.conversations),
      now: nowMs,
      dayStartMs: dayStart.getTime()
    });
    if (!shouldSleepReview(sleepSt, { key, now, hasActivity: !!material })) return '';
    markSleepReviewed(sleepSt, { key, now });
    saveSleepReviewState();
    log(`[sleep-review] 注入今日回顾 ${key}（${localDayOf(now)}）`);
    return '【今天过完了】下面是今天发生的事。睡前可以翻一翻：想记的用 qq_diary 写一条（一两句具体的小事，别写总结句），'
      + '想调对谁的好感度就用 qq_mood；不想写、不想动，就直接安静收尾，没人要求你必须留点什么。\n'
      + (material ? material + '\n' : '')
      + '\n';
  }

""" + WIRE_ANCHOR

apply('// MARKER: group-digest-wire', WIRE_ANCHOR, WIRE_ADD, '接线层')

# ── 4/5. 两段注入（都放在 base 拼接行之前）──────────────────────────────
BASE_ANCHOR = "    const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + moodLine + imageLine + wakeLine + memoryLine + sharedMemoryLine + scheduleLine + scheduleReviewLine + portraitLine + participationLine + preSleepLine;"

INJECT_ADD = r"""    // MARKER: group-digest-inject
    // 群近况：只有主人私聊里问了群才给，其他情况一个字都不提。
    const groupDigestLine = buildGroupDigestLineFor(key);
    // 睡眠整合：4 点后第一次醒来时回顾今天（会落盘记账，当天只念一次）。
    const sleepReviewLine = buildSleepReviewLineFor(key);
""" + BASE_ANCHOR

apply('// MARKER: group-digest-inject', BASE_ANCHOR, INJECT_ADD, '两段注入声明')

# ── 6. 拼进 base ────────────────────────────────────────────────────────
# 注意：apply 是替换语义（replace(anchor, addition)），addition 必须自带锚点行。
BASE2_ANCHOR = "const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + moodLine + imageLine + wakeLine + memoryLine + sharedMemoryLine + scheduleLine + scheduleReviewLine + portraitLine + participationLine + preSleepLine;"
BASE2_ADD = "const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + moodLine + imageLine + wakeLine + memoryLine + sharedMemoryLine + groupDigestLine + sleepReviewLine + scheduleLine + scheduleReviewLine + portraitLine + participationLine + preSleepLine;"

if 'groupDigestLine + sleepReviewLine' in SRC:
    print('  [skip] base 拼接（已装）')
else:
    n = SRC.count(BASE2_ANCHOR)
    ensure(n == 1, 'base 拼接锚点命中 %d 次（应为 1）' % n)
    SRC = SRC.replace(BASE2_ANCHOR, BASE2_ADD, 1)
    changed.append('base 拼接')
    print('  [ok]   base 拼接')

# ── 事后断言 ────────────────────────────────────────────────────────────
ensure(SRC.count('asksAboutGroups(') >= 1, 'asksAboutGroups 没接上')
ensure(SRC.count('buildGroupDigestLineFor(') == 2, 'buildGroupDigestLineFor 应出现 2 次（定义+调用）')
ensure(SRC.count('buildSleepReviewLineFor(') == 2, 'buildSleepReviewLineFor 应出现 2 次（定义+调用）')
# 只算不拼 = 装了没生效，这是最危险的失败模式
ensure('+ groupDigestLine + sleepReviewLine +' in SRC, 'base 里没拼上两段')
# 主人判定必须排除自己
ensure('m.isOwner && !m.isSelf' in SRC, '主人判定没排除 isSelf')
# 幂等
ensure(SRC.count('// MARKER: group-digest\n') == 1, 'group-digest MARKER 重复')
ensure(SRC.count('// MARKER: group-digest-wire') == 1, 'group-digest-wire MARKER 重复')

with open(SRC_PATH, 'w', encoding='utf-8') as f:
    f.write(SRC)

print('\n完成：%s → %s 字节（%+d），改动 %d 处' % (
    orig_len, len(SRC), len(SRC) - orig_len, len(changed)))
for c in changed:
    print('  · ' + c)
