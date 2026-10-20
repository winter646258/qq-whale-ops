"""给 bridge.js 加「印象定期重写」提醒。

两处改动：
  1. buildWakePromptV2：记忆板块后面按需追加一条维护提醒（默认 7 天冷却）
  2. memory-update 的 memberImpression 落盘处：真的改了印象就重置计时

设计要点：提醒只在「距上次真的重写印象」超过阈值时出现，改了就不再念 ——
不是定时刷屏。
"""
import shutil
import time

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()
orig_len = len(src)

# ── 1) 唤醒提示词里插入印象维护提醒 ────────────────────────────
old1 = """    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? `${memoryText}\\n\\n` : '';
"""
new1 = """    const memoryText = formatMemoryV2(st);
    // 印象会累积（memberImpression 追加是合并 traits，上限 10 条），久了就变味。
    // 只在「距上次真的重写」超过阈值时念一句；她改过就重置计时，不会天天唠叨。
    const impressionRefreshDays = Math.max(1, Number(cfg.socialV2?.memory?.impressionRefreshDays) || 7);
    const lastImpressionRefreshAt = Number(st.lastImpressionRefreshAt) || 0;
    const impressionStale = Object.keys(st.memberImpressions || {}).length > 0
      && (lastImpressionRefreshAt === 0 || Date.now() - lastImpressionRefreshAt > impressionRefreshDays * 86400 * 1000);
    const memoryMaintenanceLine = impressionStale
      ? `【印象维护】你手上的【对群友的印象】可能已经过时了。挑 1~2 个改一下：先用 qq_memory_query 看现在的印象，再用 qq_memory_update（category=memberImpression，target=对方昵称，newContent="标签A、标签B"）把你现在的判断重写掉，一条几个字就够，别攒成一堆旧标签。改完不用汇报。\\n\\n`
      : '';
    const memoryLine = memoryText || memoryMaintenanceLine
      ? `${memoryText}${memoryText && memoryMaintenanceLine ? '\\n' : ''}${memoryMaintenanceLine}\\n`
      : '';
"""
assert src.count(old1) == 1, f'第1处匹配数异常: {src.count(old1)}'
src = src.replace(old1, new1)

# ── 2) 真的重写了印象 ⇒ 重置计时 ──────────────────────────────
old2 = """            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
          }
"""
new2 = """            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
            // 她真的动手重写了印象 ⇒ 重置维护计时（提醒随之消失）
            st.lastImpressionRefreshAt = Date.now();
          }
"""
assert src.count(old2) == 1, f'第2处匹配数异常: {src.count(old2)}'
src = src.replace(old2, new2)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak.{stamp}'
shutil.copy2(P, bak)
tmp = P + '.tmp'
open(tmp, 'w', encoding='utf-8').write(src)
import os
os.replace(tmp, P)

print(f'备份 -> {bak}')
print(f'字节数 {orig_len} -> {len(src)}')
for probe in ('memoryMaintenanceLine', 'impressionRefreshDays', 'lastImpressionRefreshAt = Date.now()'):
    print(f'  落盘确认「{probe}」: {src.count(probe)} 次')
