#!/usr/bin/env python3
"""关键词匹配跳过「拍一拍」这类系统生成的文本。

## 问题

`maskOtherMemberNamesV2` 处理不了这一种：**关键词恰好等于发送者本人的昵称**。

实测 18:26 之后残留的两次唤醒：

    18:26:18 计划唤醒 group:906710082（keyword:小鲸鱼）
    18:29:14 计划唤醒 group:906710082（keyword:小鲸鱼）

对应的消息是：

    sender='小鲸鱼'  text='[拍一拍] 小鲸鱼 拍了拍 761403447'
    sender='小鲸鱼在潜水'  text='[拍一拍] 小鲸鱼在潜水 拍了拍 761403447'

这两条文本是 QQ **自动生成的模板**（`[拍一拍] <谁> 拍了拍 <谁>`），
里面出现昵称是构造使然，不是人说的话。而 `maskOtherMemberNamesV2` 故意跳过
`name === kwStr` 的情况（为了保住「正好有人这样叫她」），于是「小鲸鱼」这个
关键词被发送者自己的名字命中了。

## 改法

关键词段开头加一条早退：`plainContent` 以 `[拍一拍]` 开头就不做关键词匹配。

拍一拍本身有独立通道（`scheduleWakeV2(key, 'poke')`，且已经带
`pokedMe = targetIsSelf || (kind === 'private' && !targetId)` 的目标判断），
所以跳过关键词匹配不会漏掉「有人拍她」这件事 —— 只是不再因为模板里的
昵称而被误唤起。

## 边界

如果有人真的手打一条以 `[拍一拍]` 开头的消息，这条会不被关键词唤醒。
代价可接受：这种文本在群里就是歧义源，at 段与 question 判定仍照常工作。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

OLD = """    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {"""

NEW = """    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      // MARKER: skip-synthetic-keyword
      // 「[拍一拍] 小鲸鱼 拍了拍 761403447」是 QQ 生成的模板，昵称出现是构造使然，
      // 不是人说的话。关键词恰好等于发送者昵称时（「小鲸鱼」），maskOtherMemberNamesV2
      // 会跳过「完全同名」而不挖，于是这类模板一直把她叫醒。拍一拍有独立通道，这里直接放行。
      if (String(plainContent ?? '').trimStart().startsWith('[拍一拍]')) return null;
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {"""


def main():
    text = TARGET.read_text(encoding='utf-8')
    if 'MARKER: skip-synthetic-keyword' in text:
        print('· 已装 skip-synthetic-keyword，跳过')
        return 0
    n = text.count(OLD)
    if n != 1:
        print(f'❌ 锚点命中 {n} 次（应为 1）')
        return 1
    text = text.replace(OLD, NEW)
    assert text.count('MARKER: skip-synthetic-keyword') == 1
    TARGET.write_text(text, encoding='utf-8')
    print('✅ 关键词段已跳过 [拍一拍] 模板文本')
    return 0


if __name__ == '__main__':
    sys.exit(main())
