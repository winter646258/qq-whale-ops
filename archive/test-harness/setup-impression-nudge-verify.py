"""隔离验证：buildWakePromptV2 里的【记印象】/【印象维护】是否真的渲染。

方法（沿用之前验证过的）：临时给 main() 内加环境变量控制的测试出口，
在 /tmp 副本里跑，验证完立刻还原。
"""
import os
import shutil
import sys
import time

SRC = '/opt/qq-bridge/src/bridge.js'
DST = '/tmp/in2/bridge.js'

os.makedirs('/tmp/in2', exist_ok=True)
shutil.copy2(SRC, DST)
os.symlink('/opt/qq-bridge/node_modules', '/tmp/in2/node_modules') if not os.path.exists('/tmp/in2/node_modules') else None
# 状态文件也复制（验证要读真实会话数据）
os.makedirs('/tmp/in2/state', exist_ok=True)
shutil.copy2('/opt/qq-bridge/state/social-v2.json', '/tmp/in2/state/social-v2.json')

src = open(DST, encoding='utf-8').read()

hook = """  if (process.env.BRIDGE_TEST_EXPORT === '1') {
    globalThis.__bridgeTest = { getSocialV2State, buildWakePromptV2, formatMemoryV2 };
  }

  await pumpMux();"""
if 'BRIDGE_TEST_EXPORT' in src:
    print('副本里已有钩子')
elif "  await pumpMux();" in src:
    src = src.replace("  await pumpMux();", hook)
    open(DST, 'w', encoding='utf-8').write(src)
    print('钩子已注入副本')
else:
    print('✖ 找不到 pumpMux 锚点')
    sys.exit(1)
