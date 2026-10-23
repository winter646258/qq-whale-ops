#!/usr/bin/env python3
"""把好感度的档位接进唤醒 prompt —— 让「关系变了」真的改变说话方式。

用法：
    python3 patch-affinity-tone.py [项目根目录]

默认 /opt/qq-bridge；传参可改隔离副本。

为什么改：
  实测发现 formatAffinityLine 只回吐 note 原文，level(1~10) 根本没进 prompt，
  只用于「14 天没动过就提醒一句」。结果是好感度从 3 涨到 9，注入的还是同一句
  话 —— 她读到「我对他印象是这样」，但不知道「印象 9 分该粘人、2 分该冷淡」。
  链路断在「数字 -> 态度」这一步。

改什么：
  1. 新增 affinityToneFor(level)：把 1~10 折成五档「说话倾向」。
  2. formatAffinityLine 在 note 后面补一行「语气参考」。
  3. 头部设计约束第 3 条同步改写，免得注释和实现打架。

不改什么：
  - 仍然不把数字写进 prompt（主人 2026-10-22 定的第三条），只给方向描述。
  - 不改 note 的存法、不改按会话各存一份、不碰自动打分。
"""
import sys
import os
import subprocess
import shutil
import time

ROOT = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge'
PATH = os.path.join(ROOT, 'src', 'affinity-store.js')

with open(PATH, 'r', encoding='utf-8') as f:
    SRC = f.read()

len0 = len(SRC)

TONE_FN = """/**
 * 好感度档位 -> 说话倾向。
 *
 * 只给方向，不给分数：数字进 prompt 她会直接在聊天里把分数说出来，
 * 而「印象 9 分」对说话方式没有任何可执行的指引，一句「该松一点」才有。
 *
 * @param {number} level 1~10
 * @returns {string} 空串表示没有可用信息
 */
export function affinityToneFor(level) {
  const n = clampAffinityLevel(level);
  if (n === null) return '';
  if (n <= 2) return '还谈不上亲近，客气、话少，不必热络，也不用主动找话题';
  if (n <= 4) return '印象一般，正常相处就行，不用刻意亲近';
  if (n <= 6) return '算熟了，可以放松一点、开开玩笑';
  if (n <= 8) return '有好感，说话会自然松下来：愿意多聊两句、主动接话，也会顺口问一句对方近况';
  return '很亲近，说话不设防：会主动搭话、会护着，偶尔说句软话；被冷落会有点在意';
}"""

OLD_FMT = """  const isOwner = String(key) === `private:${ownerQQ}`;
  return `\u3010\u4f60\u600e\u4e48\u770b${isOwner ? '\u4e3b\u4eba' : '\u8fd9\u4e2a\u4eba'}\u3011${entry.note}\\n\\n`;"""

NEW_FMT = """  const isOwner = String(key) === `private:${ownerQQ}`;
  // MARKER: affinity-tone
  // note 说「我怎么看这个人」，语气行说「因此这话该怎么说」。缺一句，
  // 好感度就只是个静态标签 —— 关系变了，她说话的松紧也得跟着变。
  const tone = affinityToneFor(entry.level);
  const toneLine = tone ? `\uff08\u8bed\u6c14\u53c2\u8003\uff1a${tone}\uff09\\n` : '';
  return `\u3010\u4f60\u600e\u4e48\u770b${isOwner ? '\u4e3b\u4eba' : '\u8fd9\u4e2a\u4eba'}\u3011${entry.note}\\n${toneLine}\\n`;"""

OLD_HDR = """//   3. **\u53ea\u6ce8\u5165 note \u539f\u6587\uff0c\u4e0d\u6ce8\u5165\u6570\u5b57**\uff1a\u56fe\u91cc\u5199\u7684\u662f\u300c\u597d\u611f\u5ea6\uff1a\u4e00\u4e2a\u5927\u6982\u7684\u79e4\uff0c
//      \u4e0d\u88ab\u6570\u5b57\u6846\u4f4f\uff0c\u559c\u6b22\u8c01\u7531\u5979\u81ea\u5df1\u5224\u65ad\u300d\u3002\u6570\u5b57\u7ed9\u5979\u53ea\u4f1a\u8ba9\u5979\u5728\u804a\u5929\u91cc\u628a\u5206\u6570\u8bf4\u51fa\u6765\u3002"""

NEW_HDR = """//   3. **\u53ea\u6ce8\u5165 note \u539f\u6587\u548c\u5206\u6863\u8bed\u6c14\uff0c\u4e0d\u6ce8\u5165\u6570\u5b57**\uff1a\u56fe\u91cc\u5199\u7684\u662f\u300c\u597d\u611f\u5ea6\uff1a\u4e00\u4e2a\u5927\u6982\u7684\u79e4\uff0c
//      \u4e0d\u88ab\u6570\u5b57\u6846\u4f4f\uff0c\u559c\u6b22\u8c01\u7531\u5979\u81ea\u5df1\u5224\u65ad\u300d\u3002\u6570\u5b57\u7ed9\u5979\u53ea\u4f1a\u8ba9\u5979\u5728\u804a\u5929\u91cc\u628a\u5206\u6570\u8bf4\u51fa\u6765\uff1b
//      \u4f46\u53ea\u7ed9 note \u53c8\u4f1a\u8ba9\u300c\u5173\u7cfb\u53d8\u4e86\u300d\u505c\u5728\u6807\u7b7e\u4e0a\u4e0d\u52a8 \u2014\u2014 \u6240\u4ee5\u8865\u4e00\u884c\u5206\u6863\u7684\u8bf4\u8bdd\u503e\u5411\u3002"""

MARKER = 'MARKER: affinity-tone'

if MARKER in SRC:
    print('  [skip] 语气行（已装）')
else:
    n = SRC.count(OLD_FMT)
    if n != 1:
        raise SystemExit('FAIL: formatAffinityLine 锚点命中 %d 次（应为 1）' % n)
    n2 = SRC.count(OLD_HDR)
    if n2 != 1:
        raise SystemExit('FAIL: 头部注释锚点命中 %d 次（应为 1）' % n2)
    ANCHOR = '/**\n * 拼进唤醒 prompt 的那一行。'
    n3 = SRC.count(ANCHOR)
    if n3 != 1:
        raise SystemExit('FAIL: 插入锚点命中 %d 次（应为 1）' % n3)
    SRC = SRC.replace(OLD_FMT, NEW_FMT, 1)
    SRC = SRC.replace(OLD_HDR, NEW_HDR, 1)
    SRC = SRC.replace(ANCHOR, TONE_FN + '\n\n' + ANCHOR, 1)
    print('  [ok]   语气行 + affinityToneFor + 头部注释')

assert 'export function affinityToneFor' in SRC, 'affinityToneFor 没进去'
assert '\u8bed\u6c14\u53c2\u8003' in SRC, '语气行没进 formatAffinityLine'
assert '\u81ea\u52a8\u6253\u5206' in SRC, '动了不该动的地方'
assert '\u6309\u4f1a\u8bdd\u5404\u5b58\u4e00\u4efd' in SRC, '按会话各存一份的约定丢了'

bak = PATH + '.bak-tone-' + time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(PATH, bak)
with open(PATH, 'w', encoding='utf-8') as f:
    f.write(SRC)

chk = subprocess.run(['node', '--check', PATH], capture_output=True, text=True)
if chk.returncode != 0:
    shutil.copy2(bak, PATH)
    raise SystemExit('FAIL: node --check 没过，已回滚\n' + chk.stderr)

print('\n\u5b8c\u6210\uff1aaffinity-store.js %d -> %d (%+d)' % (len0, len(SRC), len(SRC) - len0))
print('\u5907\u4efd\uff1a' + bak)