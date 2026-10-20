"""补「记印象」驱动 + 修「印象维护」的前置条件。

问题（实测）：
  群会话 107 次工具调用，记忆类 0 次；memberImpressions 为空。
  根因：memoryMaintenanceLine 要求「已有印象」才提醒（impressionStale 条件里
       有 Object.keys(memberImpressions).length > 0），所以印象为空时
       永远不触发 ⇒ 她从没被提示过要记印象。

改法：
  ① 新增「记印象」驱动：会话里还没有任何印象、但活跃度够（recentMessages >= 门槛）时，
     提示她挑 1~2 个人记一句短标签，并给出确切参数（含 extra.target）。
  ② 维护提醒保留原逻辑（已有印象且过时 ⇒ 提示重写）。
  ③ 两者共用「冷却计时」lastImpressionNudgeAt，避免每轮唠叨；
     该字段必须进 loadSocialV2State 白名单（否则重启丢失 ⇒ 每轮都念）。
"""
import os
import shutil
import time

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()

if 'MARKER: impression-nudge' in src:
    print('[skip] 已打过')
    raise SystemExit(0)

# ── 锚点 1：现有的 memoryMaintenanceLine 块 ──────────────────────
OLD1 = """    const impressionRefreshDays = Math.max(1, Number(cfg.socialV2?.memory?.impressionRefreshDays) || 7);
    const lastImpressionRefreshAt = Number(st.lastImpressionRefreshAt) || 0;
    const impressionStale = Object.keys(st.memberImpressions || {}).length > 0
      && (lastImpressionRefreshAt === 0 || Date.now() - lastImpressionRefreshAt > impressionRefreshDays * 86400 * 1000);
    const memoryMaintenanceLine = impressionStale
      ? `【印象维护】你手上的【对群友的印象】可能已经过时了。挑 1~2 个改一下：先用 qq_memory_query 看现在的印象，再用 qq_memory_update（category=memberImpression，target=对方昵称，newContent="标签A、标签B"）把你现在的判断重写掉，一条几个字就够，别攒成一堆旧标签。改完不用汇报。\\n\\n`
      : '';"""

NEW1 = """    // MARKER: impression-nudge
    const impressionRefreshDays = Math.max(1, Number(cfg.socialV2?.memory?.impressionRefreshDays) || 7);
    const lastImpressionRefreshAt = Number(st.lastImpressionRefreshAt) || 0;
    const impressionCount = Object.keys(st.memberImpressions || {}).length;
    const impressionStale = impressionCount > 0
      && (lastImpressionRefreshAt === 0 || Date.now() - lastImpressionRefreshAt > impressionRefreshDays * 86400 * 1000);
    // ① 「记印象」驱动：还没留过印象、但会话已经有足够往来时，提示她开始记。
    //    门槛与冷却都可配；默认 0 条印象 + 最近消息 >= 20 条时才提，12 小时最多念一次。
    const nudgeEnabled = cfg.socialV2?.memory?.nudgeImpressions !== false;
    const nudgeMinRecent = Math.max(1, Number(cfg.socialV2?.memory?.nudgeMinRecentMessages) || 20);
    const nudgeCooldownMs = Math.max(1, Number(cfg.socialV2?.memory?.nudgeCooldownHours) || 12) * 3600 * 1000;
    const recentMsgCount = Array.isArray(st.recentMessages) ? st.recentMessages.length : 0;
    const lastNudgeAt = Number(st.lastImpressionNudgeAt) || 0;
    const nudgeAllowed = nudgeEnabled && (nudgeCooldownMs === 0 || Date.now() - lastNudgeAt > nudgeCooldownMs);
    const shouldStartNudge = nudgeAllowed && impressionCount === 0 && recentMsgCount >= nudgeMinRecent;
    const shouldRefreshNudge = nudgeAllowed && impressionStale;
    const memoryMaintenanceLine = shouldStartNudge
      ? `【记印象】你还没给这个地方的人留过印象。挑 1~2 个打过交道的，用 qq_memory_append（category=memberImpression，content="短标签"，extra.target="对方昵称"）各记一句——一条几个字就够（例：话多、爱怼人、爱发怪图、说话客气）。想先看看都有谁，可以用 qq_get_active_members。不用记全，也不用汇报。\\n\\n`
      : (shouldRefreshNudge
        ? `【印象维护】你手上的【对群友的印象】可能已经过时了。挑 1~2 个改一下：先用 qq_memory_query 看现在的印象，再用 qq_memory_update（category=memberImpression，target=对方昵称，newContent="标签A、标签B"）把你现在的判断重写掉，一条几个字就够，别攒成一堆旧标签。改完不用汇报。\\n\\n`
        : '');
    // 念过一次就记时间（冷却用）。必须落盘，否则重启后每轮都念。
    if (shouldStartNudge || shouldRefreshNudge) st.lastImpressionNudgeAt = Date.now();"""

if src.count(OLD1) != 1:
    print(f'✖ 锚点1 匹配异常: {src.count(OLD1)}')
    raise SystemExit(1)

src = src.replace(OLD1, NEW1)

# ── 锚点 2：状态加载白名单（加 lastImpressionNudgeAt）─────────────
OLD2 = """            // 印象维护计时。默认给「现在」：宁可第一次提醒晚一轮，
            // 也绝不因为字段缺失而每轮唤醒都唠叨一次。
            lastImpressionRefreshAt: Number(val.lastImpressionRefreshAt) > 0 ? Number(val.lastImpressionRefreshAt) : Date.now()"""
NEW2 = """            // 印象维护计时。默认给「现在」：宁可第一次提醒晚一轮，
            // 也绝不因为字段缺失而每轮唤醒都唠叨一次。
            lastImpressionRefreshAt: Number(val.lastImpressionRefreshAt) > 0 ? Number(val.lastImpressionRefreshAt) : Date.now(),
            // 「记印象」驱动的冷却计时；缺省 0 表示从未念过（允许首次提醒）。
            lastImpressionNudgeAt: Number(val.lastImpressionNudgeAt) > 0 ? Number(val.lastImpressionNudgeAt) : 0"""

if src.count(OLD2) != 1:
    print(f'✖ 锚点2 匹配异常: {src.count(OLD2)}')
    raise SystemExit(1)

src = src.replace(OLD2, NEW2)

# ── 锚点 3：新建会话初始化 ───────────────────────────────────────
OLD3 = """        memberImpressions: {},
        lastImpressionRefreshAt: Date.now()
      };"""
NEW3 = """        memberImpressions: {},
        lastImpressionRefreshAt: Date.now(),
        lastImpressionNudgeAt: 0
      };"""
if src.count(OLD3) != 1:
    print(f'✖ 锚点3 匹配异常: {src.count(OLD3)}')
    raise SystemExit(1)
src = src.replace(OLD3, NEW3)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak-impnudge-{stamp}'
shutil.copy2(P, bak)
open(P + '.tmp', 'w', encoding='utf-8').write(src)
os.replace(P + '.tmp', P)
print(f'[ok] 已打补丁；备份 -> {bak}')
print(f'  MARKER 出现: {src.count("MARKER: impression-nudge")}')
print(f'  记印象提示: {src.count("【记印象】")}')
print(f'  维护提示:   {src.count("【印象维护】")}')
print(f'  冷却字段:   {src.count("lastImpressionNudgeAt")} 处（预期 4）')
