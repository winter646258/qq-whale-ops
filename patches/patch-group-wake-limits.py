"""群聊独立降频：autoReplyCheckMsInGroup / maxWakePerHourInGroup。

背景：
  之前为了压群聊话多，直接把全局 autoReplyCheckMs 30s→180s、
  maxWakePerHour 12→8 改了。实测证明这两个是**全局读取**（`cfg.socialV2?.…`，
  不含 key 判断），会连私聊一起拖慢 —— 而私聊的 frequency 是各会话单独调过的
  （0.08/0.1/0.15/0.3 各不相同），不该被群聊需求冲掉。

改法（与已有的 resolveSendLimitsV2 同一思路）：
  新增 resolveWakeLimitsV2(key)：
    - 非群聊 → 用全局值（行为完全不变）
    - 群聊 → 优先读 *InGroup，未配置/非法则回退全局
  两处读取点改用它。

配置新增（默认为 null = 回退全局，保证旧配置行为不变）：
  socialV2.autoReplyCheckMsInGroup
  socialV2.wake.maxWakePerHourInGroup
"""
import os
import shutil
import time

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()

if 'resolveWakeLimitsV2' in src:
    print('[skip] 已打过')
    raise SystemExit(0)

# ── ① 新增归一键（放在 v2ToolEnabled 前，确保先于使用定义）──────
anchor = "  function v2ToolEnabled(flag) {"
helper = """  /**
   * 解析某个会话适用的「唤醒频率」阈值。
   *
   * 全局 autoReplyCheckMs / wake.maxWakePerHour 对所有会话生效；
   * 群聊可用 *InGroup 单独调慢，未配置（null/空/非法）时回退全局值，
   * 保证私聊与旧配置行为完全不变。
   */
  function resolveWakeLimitsV2(key) {
    const isGroup = String(key ?? '').startsWith('group:');
    const g = cfg.socialV2 ?? {};
    const w = g.wake ?? {};
    const pick = (globalVal, groupVal, fallback) => {
      const base = Number(globalVal);
      const baseOk = Number.isFinite(base) && base > 0 ? base : fallback;
      if (!isGroup) return baseOk;
      if (groupVal === null || groupVal === undefined || groupVal === '') return baseOk;
      const n = Number(groupVal);
      return Number.isFinite(n) && n > 0 ? n : baseOk;
    };
    return {
      autoReplyCheckMs: pick(g.autoReplyCheckMs, g.autoReplyCheckMsInGroup, 30000),
      maxWakePerHour: pick(w.maxWakePerHour, w.maxWakePerHourInGroup, 12),
      isGroup,
    };
  }

"""
if src.count(anchor) != 1:
    print(f'✖ helper 锚点异常: {src.count(anchor)}')
    raise SystemExit(1)
src = src.replace(anchor, helper + anchor, 1)

# ── ② scheduleReplyCheckV2 用它取 delay ─────────────────────────
OLD1 = "    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);"
NEW1 = "    let delay = Math.max(1000, resolveWakeLimitsV2(key).autoReplyCheckMs);"
if src.count(OLD1) != 1:
    print(f'✖ 锚点1 异常: {src.count(OLD1)}')
    raise SystemExit(1)
src = src.replace(OLD1, NEW1)

# ── ③ scheduleWakeV2 用它取 maxPerHour ──────────────────────────
OLD2 = """    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;"""
NEW2 = """    const __wlim = resolveWakeLimitsV2(key);
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = __wlim.maxWakePerHour;"""
if src.count(OLD2) != 1:
    print(f'✖ 锚点2 异常: {src.count(OLD2)}')
    raise SystemExit(1)
src = src.replace(OLD2, NEW2)

# ── ④ 配置默认值加两个群聊专用字段 + 归一键 ────────────────────
OLD3 = """        maxWakePerMinute: 1,
        maxWakePerHour: 12,"""
NEW3 = """        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        // 群聊专用唤醒上限（可选）。不配则回退到上面的全局值。
        // 群聊通常更热闹，需要更慢，但私聊不该被拖慢。
        maxWakePerHourInGroup: null,"""
if src.count(OLD3) != 1:
    print(f'✖ 锚点3 异常: {src.count(OLD3)}')
    raise SystemExit(1)
src = src.replace(OLD3, NEW3)

OLD4 = "      autoReplyCheckMs: 30000,"
NEW4 = """      autoReplyCheckMs: 30000,
      // 群聊专用的「说完话回来检查」间隔（可选）。不配则回退全局。
      autoReplyCheckMsInGroup: null,"""
if src.count(OLD4) != 1:
    print(f'✖ 锚点4 异常: {src.count(OLD4)}')
    raise SystemExit(1)
src = src.replace(OLD4, NEW4)

# ── ⑤ 控制台归一化清单加上（并放过 null）──────────────────────
OLD5 = "            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {"
NEW5 = "            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'maxWakePerHourInGroup', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {"
if src.count(OLD5) != 1:
    print(f'✖ 锚点5 异常: {src.count(OLD5)}')
    raise SystemExit(1)
src = src.replace(OLD5, NEW5)

# 顶层 autoReplyCheckMsInGroup 的归一化（加在 autoReplyCheckMs 归一化之后）
if "merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);" not in src:
    print('✖ 找不到 autoReplyCheckMs 归一化')
    raise SystemExit(1)
src = src.replace(
    "            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);",
    """            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
            // 群聊专用值：显式 null/空 表示「回退全局」，不能归一成 0
            const _ga = merged.autoReplyCheckMsInGroup;
            if (_ga === null || _ga === undefined || _ga === '') {
              merged.autoReplyCheckMsInGroup = null;
            } else {
              const _gn = Number(_ga);
              merged.autoReplyCheckMsInGroup = Number.isFinite(_gn) ? Math.max(1000, Math.round(_gn)) : null;
            }""")

# wake 归一键里也放过 null
src = src.replace(
    "                const n = Number(merged.wake[k]);\n                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;",
    """                // 群聊专用阈值：显式 null/空 表示回退全局
                if (k === 'maxWakePerHourInGroup' && (merged.wake[k] === null || merged.wake[k] === '')) {
                  merged.wake[k] = null;
                } else {
                  const n = Number(merged.wake[k]);
                  merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                }""",
    1)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak-grouplimits-{stamp}'
shutil.copy2(P, bak)
open(P + '.tmp', 'w', encoding='utf-8').write(src)
os.replace(P + '.tmp', P)
print(f'[ok] 已打补丁；备份 -> {bak}')
print(f'  resolveWakeLimitsV2: {src.count("resolveWakeLimitsV2")} 处')
print(f'  群聊配置字段: {src.count("maxWakePerHourInGroup")} / {src.count("autoReplyCheckMsInGroup")}')
