#!/usr/bin/env python3
"""修上一版宽限分支的疏漏：reason 没带过去，导致 scene 恒判 byMention=false。

现场日志（15:00）：

    14:59:49 [image] 授予额度（group:906710082，question）
    15:00:05 [image] 收回额度（group:906710082）
    15:00:11 [image] 宽限放行（group:906710082，回合结束后 6s）
    15:00:11 status → {"ok":false,"error":"只有主人私聊、或主人在群里@你/叫你名字时才能画"}

宽限本身生效了（放行日志在），但 imageSceneFor 拿到的是空 reason，
byMention 判不出来。上一版我在 turn/end 已经把 reason 存进
__qqTurnContextEnded 了，这里却仍然写死空串 —— 一行的事。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

OLD = """      ctx = { key, reason: '', at: Number(ended.at || 0), grace: true };"""
NEW = """      ctx = { key, reason: String(ended.reason || ''), at: Number(ended.at || 0), grace: true };"""


def main():
    text = TARGET.read_text(encoding='utf-8')
    n = text.count(OLD)
    if n != 1:
        print(f'❌ 命中 {n} 次（应为 1），拒绝写盘')
        return 1
    TARGET.write_text(text.replace(OLD, NEW), encoding='utf-8')
    print('✅ bridge.js：宽限分支补上 reason 传递')
    return 0


if __name__ == '__main__':
    sys.exit(main())