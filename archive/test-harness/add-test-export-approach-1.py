"""验证补丁（用后即撤）：临时导出 __bridgeTest，用于隔离验证唤醒提示词。

只加一个导出，不改任何逻辑；验证完立刻还原。
"""
import shutil
import time

P = '/opt/qq-bridge/src/bridge.js'
MARK = 'export const __bridgeTest = { getSocialV2State, buildWakePromptV2 };\n'
src = open(P, encoding='utf-8').read()

if MARK in src:
    print('已存在导出，跳过')
    raise SystemExit(0)

old = "main().catch((error) => {"
assert src.count(old) == 1, f'锚点匹配数异常: {src.count(old)}'
src = src.replace(old, MARK + old)

stamp = time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(P, f'{P}.bak.testexport-{stamp}')
open(P + '.tmp', 'w', encoding='utf-8').write(src)
import os
os.replace(P + '.tmp', P)
print(f'已临时加导出（备份 {P}.bak.testexport-{stamp}）')
