"""强化表情使用驱动力：三处调整。

问题（实测）：群会话 201 次工具调用，表情相关 0 次。
    私聊同一分钟她调过 send_sticker → 能力没问题。
    策略提示在提示词里（stickerLine 已拼入 base），但没驱动她。

诊断：策略第 3 条「不确定就先 qq_get_sticker_image 看图再决定，不要瞎发」
      把决策成本抬高了 —— 看图要花一轮工具调用，她倾向直接放弃。

改法（都只在 sticker-lib.js 里改文案，不动逻辑）：
  1) 降低决策成本：允许「模糊也能发」，去掉"不要瞎发"的威慑
  2) 强化自嘲场景：明确点名"自嘲/被调侃/接梗"是配表情的高优先场景
  3) 给出"发不出就跳过"的兜底，避免她为了表情卡住一轮
"""
import os
import re
import shutil
import time

P = '/opt/qq-bridge/src/sticker-lib.js'
src = open(P, encoding='utf-8').read()

if 'MARKER: sticker-drive-v2' in src:
    print('[skip] 已打过')
    raise SystemExit(0)

OLD = """export function buildStickerStrategyHint() {
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    '- 频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '- 选择：优先用备注（desc）和你的记忆（localNote/tags）能准确对上语境的；没有备注/不确定的表情，先 qq_get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 qq_send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 qq_send_message / qq_reply 作为单独气泡发出，再单独发表情。需要引用/点名时传 replyToMessageId / atUserId（群聊）。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里；不要把表情包当回复的唯一内容（偶尔可以，但别让群友觉得你在敷衍）。',
    '- 学习：看到新表情不确定含义时，先用 qq_get_sticker_image 看图，再用 qq_sticker_note 记下你的理解，下次就能更准地选。'
  ].join('\\n');
}"""

NEW = """// MARKER: sticker-drive-v2 —— 降低决策成本 + 点名高优先场景，提升实际使用率
export function buildStickerStrategyHint() {
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- **什么时候该配一张（高优先，别错过）**：自嘲（说自己胖/圆/菜/白吃饭/被调侃）、接梗、怼人回击、赞同夸人、无语、赢了输了、告别晚安、别人发了表情时回一张。这些场合**顺手来一张比纯文字更像真人**。',
    '- 频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '- 选择（别纠结）：看着差不多就直接发。轮换名单里的图**就是为了让你随手用的**，不需要逐张确认；实在拿不准含义又想确认的，才去看图。**不要因为选不出就不发。**',
    '- 发送：用 qq_send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 qq_send_message / qq_reply 作为单独气泡发出，再单独发表情。需要引用/点名时传 replyToMessageId / atUserId（群聊）。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里；不要把表情包当回复的唯一内容（偶尔可以，但别让群友觉得你在敷衍）。',
    '- 兜底：发表情失败（比如被限流、图找不到）就**直接跳过，别重试**，把文字说完继续聊；为一张表情卡住一整轮不值得。',
    '- 学习：看到新表情不确定含义时，先用 qq_get_sticker_image 看图，再用 qq_sticker_note 记下你的理解，下次就能更准地选。'
  ].join('\\n');
}"""

n = src.count(OLD)
print(f'找到原函数: {n} 处')
if n != 1:
    print('锚点异常，放弃')
    raise SystemExit(1)

src = src.replace(OLD, NEW)
stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak-stickerdrive-{stamp}'
shutil.copy2(P, bak)
open(P + '.tmp', 'w', encoding='utf-8').write(src)
os.replace(P + '.tmp', P)
print(f'已改写策略提示')
print(f'备份 -> {bak}')
print(f'MARKER 落盘: {src.count("MARKER: sticker-drive-v2")} 处')
