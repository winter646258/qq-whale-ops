"""把日程 / 画像也接进 /api/socialV2/prompt（qq_get_prompt）。

为什么：规格对记忆的要求是「记忆会随唤醒和 qq_get_prompt 出现」——memberImpressions
就是这样做的。日程/画像如果只在唤醒里出现，她主动调 qq_get_prompt 时就看不到，
「记得住的人」会退化成「只在被叫醒时才想起来的人」。

顺带解决了验证难题：/prompt 是 GET、可安全地真实调用，不用起第二个桥接实例
（交接文档记录过「两个实例抢状态文件」的事故，不能为验证去冒那个险）。
"""
import os
import sys

P = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'
MARK = 'MARKER: schedule-portrait-prompt'
src = open(P, encoding='utf-8', newline='').read()

if MARK in src:
    print('[skip] 已打过')
    raise SystemExit(0)

anchor = """            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),"""
if src.count(anchor) != 1:
    print(f'[x] 锚点匹配 {src.count(anchor)} 次（预期 1）')
    raise SystemExit(1)

new = """            memory: formatMemoryV2(st),
            // MARKER: schedule-portrait-prompt
            // 日程/画像与 memory 同规格：唤醒里出现，主动查 qq_get_prompt 时也在。
            // 读失败只少这一段，不能让整个 prompt 接口 500。
            schedule: (() => {
              if (cfg.socialV2?.schedule?.enabled === false) return null;
              try { return formatScheduleForPrompt(scheduleStore(), { key }); }
              catch (error) { log(`[reserved2] prompt 日程读取失败 ${key}：${error?.message ?? error}`); return null; }
            })(),
            portrait: (() => {
              if (cfg.socialV2?.portrait?.enabled === false) return null;
              try { return formatPortraitForPrompt(portraitStore()); }
              catch (error) { log(`[reserved2] prompt 画像读取失败：${error?.message ?? error}`); return null; }
            })(),
            participation: formatParticipationV2(st),"""

src = src.replace(anchor, new, 1)
with open(P + '.tmp', 'wb') as fh:
    fh.write(src.encode('utf-8'))
os.replace(P + '.tmp', P)
print(f'[ok] prompt 端点已接日程/画像（{P}）')
