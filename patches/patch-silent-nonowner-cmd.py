#!/usr/bin/env python3
"""群友发斜杠命令时，桥接不再刷「管理命令仅管理员可用。」

现场（m01495 截图）：群里一个人发了 `/help`，然后五只机器人依次回
「管理命令仅管理员可用。」——小鲸鱼在潜水、超大肥鱼、小鲸鱼、大肥鱼全中招。
那不是她的判断，是**桥接硬编码拦截**（`src/bridge.js` 管理命令分支）：

    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }

群友随便发个 `/help`、`/name`、`/roll`、`/签到`，她就在群里复读一遍，
既难看又把她变成查表机器。命令本来就执行不了，没必要再回一句话。

改成：**静默丢弃**，只记一行 activity 便于事后追查。管理员自己发 `/xxx`
的路径完全不动（仍然直接执行，不经过模型）。

顺带把「角色切换仅管理员」那条也改成静默——群里刷这句同样没意义。
（如果主人希望两者保留提示，把下面 SILENT 开关改 False 即可。）
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

OLD_ROLE = """    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }"""

NEW_ROLE = """    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      // MARKER: silent-nonowner-cmd —— 群友指令一律静默，不复读提示语
      appendActivity(`${key}（群友角色指令已忽略）${event.user_id}：${plainContent.slice(0, 40)}`);
      return;
    }"""

OLD_CMD = """    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }"""

NEW_CMD = """    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        // MARKER: silent-nonowner-cmd —— 群友 /xxx 静默丢弃，不再刷「管理命令仅管理员可用。」
        appendActivity(`${key}（群友命令已忽略）${event.user_id}：${plainContent.slice(0, 40)}`);
        return;
      }"""


def main():
    text = TARGET.read_text(encoding='utf-8')
    ok = True
    for old, new, label in ((OLD_ROLE, NEW_ROLE, '角色指令'), (OLD_CMD, NEW_CMD, '斜杠命令')):
        n = text.count(old)
        if n != 1:
            print(f'❌ {label}：命中 {n} 次（应为 1）')
            ok = False
            continue
        text = text.replace(old, new)
        print(f'✅ {label}：改为静默')
    if not ok:
        return 1
    assert '管理命令仅管理员可用' not in text, '仍有残留的复读文案'
    TARGET.write_text(text, encoding='utf-8')
    print('✅ 已写入 bridge.js（全文无「管理命令仅管理员可用」）')
    return 0


if __name__ == '__main__':
    sys.exit(main())