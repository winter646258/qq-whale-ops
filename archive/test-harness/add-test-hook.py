"""验证钩子 v2：把出口放进 main() 内部（pumpMux 之前），仅环境变量开启。"""

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()

# 1) 移除之前放错位置（main 外面）的钩子
wrong = """if (process.env.BRIDGE_TEST_EXPORT === '1') {
  // 仅供隔离验证使用：把闭包函数挂到 globalThis（默认不启用）
  globalThis.__bridgeTest = { getSocialV2State, buildWakePromptV2, formatMemoryV2 };
}
"""
if wrong in src:
    src = src.replace(wrong, '')
    print('已移除放错位置的钩子')

# 2) 放到 main() 内部
anchor = "  await pumpMux();\n}"
assert src.count(anchor) == 1, f'锚点匹配数异常: {src.count(anchor)}'
hook = """  if (process.env.BRIDGE_TEST_EXPORT === '1') {
    // 仅供隔离验证：把闭包函数挂到 globalThis（默认不启用，环境变量控制）
    globalThis.__bridgeTest = { getSocialV2State, buildWakePromptV2, formatMemoryV2 };
  }

  await pumpMux();
}"""
src = src.replace(anchor, hook)

open(P + '.tmp', 'w', encoding='utf-8').write(src)
import os
os.replace(P + '.tmp', P)
print('钩子已放进 main() 内部')
