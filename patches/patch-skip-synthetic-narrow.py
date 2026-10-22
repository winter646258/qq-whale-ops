#!/usr/bin/env python3
"""收窄 skip-synthetic-keyword：只跳过关键词匹配，不要吞掉 question/probability。

## 之前的问题

`patch-skip-synthetic-keyword.py` 在关键词段开头加了

    if (String(plainContent ?? '').trimStart().startsWith('[拍一拍]')) return null;

`return null` 会直接跳出整个 `evaluateWakeTriggerV2`，于是**排在关键词段之后的
判定全被吞掉**：

    question      （`if (tr.question && isDirectedAtAi(plainContent))`）
    speakerIds    （指定成员）
    probability   （随机唤醒）

排在它之前的不受影响（`atMention` / `isDirectedAtOthers` / `nameMention`）。

## 改法

把早退降级为条件式，只挡关键词那一段：

    if (Array.isArray(tr.keywords) && tr.keywords.length
        && !String(plainContent ?? '').trimStart().startsWith('[拍一拍]')) {

这样 `[拍一拍]` 模板文本仍然不会被关键词命中，而 question / speaker / probability
照常工作 —— 有人拍她的同时还问了句话，提问判定仍然生效。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

OLD = """      if (String(plainContent ?? '').trimStart().startsWith('[拍一拍]')) return null;
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();"""

# 上面 OLD 写成两行拼接更稳，这里精确定义一次
OLD_EXACT = """    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      // MARKER: skip-synthetic-keyword
      // 「[拍一拍] 小鲸鱼 拍了拍 761403447」是 QQ 生成的模板，昵称出现是构造使然，
      // 不是人说的话。关键词恰好等于发送者昵称时（「小鲸鱼」），maskOtherMemberNamesV2
      // 会跳过「完全同名」而不挖，于是这类模板一直把她叫醒。拍一拍有独立通道，这里直接放行。
      if (String(plainContent ?? '').trimStart().startsWith('[拍一拍]')) return null;
      const lower = String(plainContent ?? '').toLowerCase();"""

NEW_EXACT = """    // MARKER: skip-synthetic-keyword —— 只挡关键词，不动 question/speaker/probability。
    // 「[拍一拍] 小鲸鱼 拍了拍 761403447」是 QQ 生成的模板，昵称出现是构造使然，
    // 不是人说的话。关键词恰好等于发送者昵称时（「小鲸鱼」），maskOtherMemberNamesV2
    // 会跳过「完全同名」而不挖，于是这类模板一直把她叫醒。拍一拍有独立通道
    // （handlePokeEvent 带 pokedMe 判断后走 scheduleWakeV2(key,'poke')），不靠关键词。
    if (Array.isArray(tr.keywords) && tr.keywords.length
        && !String(plainContent ?? '').trimStart().startsWith('[拍一拍]')) {
      const lower = String(plainContent ?? '').toLowerCase();"""


def main():
    text = TARGET.read_text(encoding='utf-8')

    n = text.count(OLD_EXACT)
    if n != 1:
        print(f'❌ 待收窄段命中 {n} 次（应为 1）')
        return 1
    text = text.replace(OLD_EXACT, NEW_EXACT)

    # 关键：全文不得再出现「早退式」写法
    bad = "trimStart().startsWith('[拍一拍]')) return null;"
    if bad in text:
        print('❌ 仍有早退式写法残留')
        return 1
    assert text.count('MARKER: skip-synthetic-keyword') == 1
    TARGET.write_text(text, encoding='utf-8')
    print('✅ skip-synthetic-keyword 已收窄为条件式，question/probability 不再被吞')
    return 0


if __name__ == '__main__':
    sys.exit(main())
