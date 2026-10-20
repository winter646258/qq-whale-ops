"""让「明确找她」的唤醒绕过频率上限（根治 @ 被 probability 挤掉的问题）。

问题（实测 2026-10-20 17:37-17:39）：
  唤醒频率检查只看次数、不看原因：
      if (recentHour >= maxPerHour) { log('唤醒频率超限，跳过 ${reason}'); return; }
  于是低优先级的 probability 触发把额度用光后，**用户 @ 她也会被丢弃**：
      17:37:34 唤醒频率超限，跳过 group:906710082（atMention）
      17:39:38 唤醒频率超限，跳过 group:906710082（atMention）

改法：
  复用已有的 WAKE_PRIORITY 表（private 100 / atMention 90 / question 80 …）。
  规定：优先级 >= 80 的唤醒（private / atMention / question）属于「明确找她」，
        **不占用也不受** maxWakePerMinute / maxWakePerHour 约束；
  其余（speaker/nameMention/keyword/anyMessage/replyCheck/timeout/proactiveCheck）
        照旧计入并受上限约束。

  这样额度池只服务「自发/弱触发」，用户明确叫她永远放行。

顺带：
  - wakeTimes 记录不变（仍只存时间戳），改动最小
  - 新增配置 wake.exemptHighPriorityFromLimit（默认 true），可关掉恢复旧行为
"""
import os
import shutil
import time

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()

if 'MARKER: wake-priority-exempt' in src:
    print('[skip] 已打过')
    raise SystemExit(0)

# ── ① 唤醒频率检查处：按优先级分流 ─────────────────────────────
OLD = """    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控
    const now = Date.now();
    const __wlim = resolveWakeLimitsV2(key);
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = __wlim.maxWakePerHour;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}）`);
      return;
    }"""

NEW = """    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控。
    // MARKER: wake-priority-exempt
    // 但「明确找她」的唤醒（private / atMention / question，优先级 >= 80）
    // 不受此限：否则群里的低优先级触发（probability 等）会把额度用光，
    // 导致用户 @ 她也被丢弃（实测 17:37:34 / 17:39:38 各发生一次）。
    const now = Date.now();
    const __wlim = resolveWakeLimitsV2(key);
    const exemptHigh = (cfg.socialV2?.wake?.exemptHighPriorityFromLimit ?? true) !== false;
    const reasonBase = String(reason ?? '').split(':')[0];
    const HIGH_PRIORITY = new Set(['private', 'atMention', 'question']);
    const isExplicit = exemptHigh && HIGH_PRIORITY.has(reasonBase);
    if (!isExplicit) {
      const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
      const maxPerHour = __wlim.maxWakePerHour;
      const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
        log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}）`);
        return;
      }
    } else if ((st.wakeTimes || []).filter((t) => now - t < 3600000).length >= (__wlim.maxWakePerHour || 12)) {
      // 只打日志，不拦：便于观察高优先级唤醒的占比
      log(`[reserved2] 高优先级唤醒放行（${reason}），本小时已唤醒 ${(st.wakeTimes || []).filter((t) => now - t < 3600000).length} 次`);
    }"""

if src.count(OLD) != 1:
    print(f'✖ 锚点异常: {src.count(OLD)}')
    raise SystemExit(1)
src = src.replace(OLD, NEW)

# ── ② 配置默认值加开关 ─────────────────────────────────────────
OLD2 = """        // 群聊专用唤醒上限（可选）。不配则回退到上面的全局值。
        // 群聊通常更热闹，需要更慢，但私聊不该被拖慢。
        maxWakePerHourInGroup: null,"""
NEW2 = """        // 群聊专用唤醒上限（可选）。不配则回退到上面的全局值。
        // 群聊通常更热闹，需要更慢，但私聊不该被拖慢。
        maxWakePerHourInGroup: null,
        // 高优先级唤醒（private / atMention / question）是否豁免频率上限。
        // 默认 true：额度只服务弱触发，用户明确叫她永远放行。
        exemptHighPriorityFromLimit: true,"""
if src.count(OLD2) != 1:
    print(f'✖ 锚点2 异常: {src.count(OLD2)}')
    raise SystemExit(1)
src = src.replace(OLD2, NEW2)

# ── ③ 控制台归一化：让这个布尔也能被改 ─────────────────────────
if "for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'maxWakePerHourInGroup', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs'])" in src:
    src = src.replace(
        "'maxWakePerHourInGroup', 'noActionLimit'",
        "'maxWakePerHourInGroup', 'noActionLimit'", 1)
# 单独处理布尔
if 'exemptHighPriorityFromLimit' in src and src.count('if (merged.wake.exemptHighPriorityFromLimit !== undefined)') == 0:
    src = src.replace(
        "            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'maxWakePerHourInGroup', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {",
        "            if (merged.wake.exemptHighPriorityFromLimit !== undefined) merged.wake.exemptHighPriorityFromLimit = merged.wake.exemptHighPriorityFromLimit !== false;\n            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'maxWakePerHourInGroup', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {",
        1)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak-wakeexempt-{stamp}'
shutil.copy2(P, bak)
open(P + '.tmp', 'w', encoding='utf-8').write(src)
os.replace(P + '.tmp', P)
print(f'[ok] 已打补丁；备份 -> {bak}')
print(f'  MARKER: {src.count("MARKER: wake-priority-exempt")}')
print(f'  HIGH_PRIORITY: {src.count("HIGH_PRIORITY")}')
print(f'  exempt 开关: {src.count("exemptHighPriorityFromLimit")} 处')
