#!/usr/bin/env python3
"""把好感度写进她真正会看的地方 —— 改 qq_mood 的工具描述。

用法：
    python3 patch-affinity-desc.py [项目根目录]

默认 /opt/qq-bridge；传参可改隔离副本。

为什么改：
  昨晚诊断发现，全量 1334 次工具调用里 qq_mood 只被调过 2 次。
  根因在描述的第一句：「read=看现在什么心情（唤醒提示里本来就有摘要，不用常看）」。
  这句话对**心情**成立（心情确实有摘要），但好感度会跟着一起被劝退 ——
  而好感度在摘要里**没有**，只能靠 read 或改的时候才看得到。
  她要是不主动看，那套「按会话存好感度」就等于没上线。

改什么：
  1. 把 affinity 那一段从「你对这个人的好感度（1~10，配一句 note 你怎么看他）」
     扩写成：note 会进每次醒来，只在该改的时候改，别每轮加一点。
  2. read 后面补一句：好感度不在摘要里，想看要单独 read。
  3. 明确「按会话各存一份」，防止她以为改一次就全群通用。
"""
import sys
import os

ROOT = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge'
PATH = os.path.join(ROOT, 'src', 'mcp-snowluma-safe.js')

with open(PATH, 'r', encoding='utf-8') as f:
    SRC = f.read()

len0 = len(SRC)

OLD = "'你自己的情绪。read=看现在什么心情（唤醒提示里本来就有摘要，不用常看）；set=写现在的心情（label 几个字，reason 为什么，可带 pleasure/arousal/dominance 三个 -1~1 的数，不传就只改文字）；vent=有件事压着没说，写进去（text，weight 0~1 表示多重）；resolve=那件事说出口了或者自己放下了，拿出来（id 从 read 里拿）；affinity=你对这个人的好感度（1~10，配一句 note 你怎么看他）；baseline=长期底色（一次最多挪 0.05，别常调——你觉得最近确实变了才调）。心情会自己慢慢淡掉，不用手动清。想写的时候才写，别每轮都改。'"

NEW = """'你自己的情绪，以及你怎么看待当前这个会话里的人。read=看一下（心情、压着没说的事、你对这个人的评价）。注意：唤醒提示里只带心情摘要，**好感度不在摘要里**，想确认得单独 read。set=写现在的心情（label 几个字，reason 为什么，可带 pleasure/arousal/dominance 三个 -1~1 的数，不传就只改文字）；vent=有件事压着没说，写进去（text，weight 0~1 表示多重）；resolve=那件事说出口了或者自己放下了，拿出来（id 从 read 里拿）；affinity=你对**当前这个会话里的人**的好感度（1~10，配一句 note 你怎么看他）。这句 note 会原样进你每次醒来的提示，所以它写的是「你怎么看这个人」，不是流水账；**只在你真觉得关系变了的时候才改**，别每轮加一点、也别每聊几句就微调——那会变成自动打分，而人不是靠打分认识人的。好感度按会话各存一份：私聊里改的不会带到群里，群里改的也不会带到私聊，各是各的。baseline=长期底色（一次最多挪 0.05，别常调——你觉得最近确实变了才调）。心情会自己慢慢淡掉，不用手动清。想写的时候才写，别每轮都改。'"""

# 幂等判据用「新描述里独有的那句话」—— 这个文件是 JS，
# 写 `// MARKER` 进源码会把它放进字符串里，语义上没问题但容易被误读成注释。
MARKER = '好感度不在摘要里'

if MARKER in SRC:
    print('  [skip] 工具描述（已装）')
else:
    n = SRC.count(OLD)
    if n != 1:
        raise SystemExit('FAIL: 工具描述锚点命中 %d 次（应为 1）' % n)
    SRC = SRC.replace(OLD, NEW, 1)
    print('  [ok]   工具描述')

# 事后断言
assert '好感度不在摘要里' in SRC, '没提到「不在摘要里」'
assert '按会话各存一份' in SRC, '没提到按会话'
assert '自动打分' in SRC, '没提防自动打分'
assert 'qq_mood' in SRC, 'qq_mood 不见了'

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(SRC)

print('\n完成：mcp-snowluma-safe.js %d → %d（%+d）' % (len0, len(SRC), len(SRC) - len0))
