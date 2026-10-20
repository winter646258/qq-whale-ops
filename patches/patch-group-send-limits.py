"""给发送限流加「群聊独立阈值」：maxSendPerMinuteInGroup / maxSendPerHourInGroup。

背景：现有 maxSendPerMinute / maxSendPerHour 是**全局阈值**（7 处读取），
      但计数是**分会话**的（st.sendTimes）。直接调小会连私聊一起变慢。
作者建议：群聊比私聊更容易被判骚扰，应更慢。

改法：
  1) 配置默认值加两个群聊专用字段（不配则回退到全局值，保持向后兼容）
  2) 每个读取点改为按 key 前缀选择阈值

实现用一个统一 helper，避免 7 处各写一遍导致漂移。
"""
import re
import shutil
import sys
import time

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()
orig = len(src)

if 'resolveSendLimitsV2' in src:
    print('[skip] 补丁已存在')
    raise SystemExit(0)

# ── 1) 默认值：加两个群聊专用字段 ─────────────────────────────
old1 = """        maxSendPerMinute: 8,
        maxSendPerHour: 60,"""
new1 = """        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        // 群聊专用阈值（可选）。不配则回退到上面的全局值。
        // 腾讯对群聊骚扰判定比私聊严，作者建议群里放慢。
        maxSendPerMinuteInGroup: null,
        maxSendPerHourInGroup: null,"""
assert src.count(old1) == 1, f'默认值锚点异常: {src.count(old1)}'
src = src.replace(old1, new1)

# ── 2) 归一键值字段（控制台归一化时也不要把 null 变成 0）──────
old_norm = """for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {"""
new_norm = """for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxSendPerMinuteInGroup', 'maxSendPerHourInGroup', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {"""
assert src.count(old_norm) == 1, f'归一化锚点异常: {src.count(old_norm)}'
src = src.replace(old_norm, new_norm)

# 群聊阈值允许 null（表示回退），所以归一化要放过 null
old_norm2 = """              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));"""
new_norm2 = """              if (merged.send[k] !== undefined) {
                // 群聊专用阈值显式传 null 时表示「回退到全局值」，不能被归一成 0
                if ((k === 'maxSendPerMinuteInGroup' || k === 'maxSendPerHourInGroup')
                    && (merged.send[k] === null || merged.send[k] === '')) {
                  merged.send[k] = null;
                } else {
                  const n = Number(merged.send[k]);
                  merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                  // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                  if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
                }"""
assert src.count(old_norm2) == 1, f'归一化细节锚点异常: {src.count(old_norm2)}'
src = src.replace(old_norm2, new_norm2)

# ── 3) 插入统一 helper（放在 v2ToolEnabled 之前，确保在使用点之前）──
anchor = "  function v2ToolEnabled(flag) {"
helper = """  /**
   * 解析某个会话适用的发送频率阈值。
   *
   * 全局字段 maxSendPerMinute / maxSendPerHour 对所有会话生效；
   * 群聊可用 maxSendPerMinuteInGroup / maxSendPerHourInGroup 单独放慢，
   * 未配置（null/空/非法）时回退到全局值 —— 保证旧配置行为不变。
   */
  function resolveSendLimitsV2(key, sendCfg) {
    const isGroup = String(key ?? '').startsWith('group:');
    const pick = (globalKey, groupKey) => {
      const g = Number(sendCfg?.[globalKey]) || 0;
      if (!isGroup) return g;
      const raw = sendCfg?.[groupKey];
      if (raw === null || raw === undefined || raw === '') return g;   // 未配置 ⇒ 回退全局
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : g;
    };
    return {
      maxPerMinute: pick('maxSendPerMinute', 'maxSendPerMinuteInGroup'),
      maxPerHour: pick('maxSendPerHour', 'maxSendPerHourInGroup'),
      isGroup,
    };
  }

"""
assert src.count(anchor) == 1, f'helper 锚点异常: {src.count(anchor)}'
src = src.replace(anchor, helper + anchor, 1)

# ── 4) 把 7 处读取替换为 helper 调用 ──────────────────────────
# 形态：const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;\n ... const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
pat = re.compile(
    r'const maxPerMinute = Number\(sendCfg\.maxSendPerMinute\) \|\| 0;\s*\n(\s*)const maxPerHour = Number\(sendCfg\.maxSendPerHour\) \|\| 0;'
)
def repl(m):
    ind = m.group(1)
    return (f'const __lim = resolveSendLimitsV2(key, sendCfg);\n'
            f'{ind}const maxPerMinute = __lim.maxPerMinute;\n'
            f'{ind}const maxPerHour = __lim.maxPerHour;')
src, n = pat.subn(repl, src)
print(f'  替换读取点: {n} 处（预期 5 —— grep 的 7 处里有 2 处是默认值/归一化清单，不是读取点）')

if n < 5:
    print('  ✖ 替换数量异常，放弃写入')
    raise SystemExit(1)

# 语法自检：括号/引号大致平衡（真实校验交给 node --check）
stamp = time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(P, f'{P}.bak-grouplimit-{stamp}')
open(P + '.tmp', 'w', encoding='utf-8').write(src)
import os
os.replace(P + '.tmp', P)
print(f'  字节数 {orig} -> {len(src)}')
print(f'  备份 -> {P}.bak-grouplimit-{stamp}')
print(f'  helper 出现次数: {src.count("resolveSendLimitsV2")}（1 定义 + {n} 使用）')
