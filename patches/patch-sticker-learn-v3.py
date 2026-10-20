"""表情策略 v3：加「从群里学表情」+「被怼就回图」的条件反射。

背景（对比实测）：
  群里另一个 DeepSeek bot（超级无敌可怕的蓝色大肥鱼）有行为：
      「遇到有人怼他就发表情包」——被 INFINITY 教了一次就学会并稳定复现。
  咱这只：qq_collect_sticker / qq_sticker_note / qq_get_sticker_image 全为 0 次。

根因：策略里的「学习」条款只讲「看到新表情不确定含义时去看图」，
      是**针对已有库**的；完全没有教她**从群友发的表情里收**，
      也没有形成「被怼 ⇒ 立刻回一张」这种明确的条件-动作。

改法（v3，仍在 sticker-lib.js 内改文案，不动逻辑）：
  1) 「学习」条款重写：明确让她收藏群友表情并写下什么时候用
  2) 新增「被怼就回图」的硬条件-动作（学另一个 bot 的做法）
"""
import os
import re
import shutil
import time

P = '/opt/qq-bridge/src/sticker-lib.js'
src = open(P, encoding='utf-8').read()

if 'MARKER: sticker-learn-v3' in src:
    print('[skip] 已打过')
    raise SystemExit(0)

OLD = """    '- 兜底：发表情失败（比如被限流、图找不到）就**直接跳过，别重试**，把文字说完继续聊；为一张表情卡住一整轮不值得。',
    '- 学习：看到新表情不确定含义时，先用 qq_get_sticker_image 看图，再用 qq_sticker_note 记下你的理解，下次就能更准地选。'"""

NEW = """    '- **被怼就回一张（硬条件）**：有人怼你、调侃你胖/圆/吃白饭/菜、或拿你跟别人比时，**先回一张表情，再补一句话**——这比纯嘴硬更像真人。库里 `吃白饭`/`大肥鱼`/`劣等模型` 类就是为这个场合准备的。',
    '- 兜底：发表情失败（比如被限流、图找不到）就**直接跳过，别重试**，把文字说完继续聊；为一张表情卡住一整轮不值得。',
    '- **从群里学表情（重要）**：群友发的表情如果好用、好玩、有攻击性，用 qq_collect_sticker（messageId + 一句 remark）收进你自己的库——这样你会越来越懂这个群的梗。收完用 qq_sticker_note 记下**什么时候用**（比如「被怼时用」），下次就选得准。',
    '- 看图与记笔记：含义不确定时先用 qq_get_sticker_image 看图，再用 qq_sticker_note 记下你的理解。**收藏与记笔记都别频繁**（每分钟最多 2 次、每小时 10 次）。'"""

n = src.count(OLD)
print(f'锚点匹配: {n}')
if n != 1:
    print('锚点异常，放弃')
    raise SystemExit(1)

src = src.replace(OLD, NEW)
src = src.replace(
    '// MARKER: sticker-drive-v2 —— 降低决策成本 + 点名高优先场景，提升实际使用率',
    '// MARKER: sticker-learn-v3 —— v2 降低决策成本 + v3 加「群里学表情」「被怼就回图」',
)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak-stickerlearn-{stamp}'
shutil.copy2(P, bak)
open(P + '.tmp', 'w', encoding='utf-8').write(src)
os.replace(P + '.tmp', P)
print(f'[ok] 已打 v3；备份 -> {bak}')
print(f'  MARKER: {src.count("sticker-learn-v3")}')
print(f'  被怼硬条件: {src.count("被怼就回一张")}')
print(f'  从群里学:   {src.count("从群里学表情")}')
print(f'  collect_sticker 提及: {src.count("qq_collect_sticker")}')
