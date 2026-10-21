#!/usr/bin/env python3
"""修 turnContext 的作用域问题（线上 P0）。

上一版把 `let turnContext = null;` 插在配置加载区（约第 1015 行），但
`deliverPromptNow` 在另一个函数的闭包里，访问不到 → 每次唤醒都抛
`turnContext is not defined`，所有补投全部失败。

改成挂在 globalThis 上：作用域一定对，且和这个变量的语义相符（进程内单例）。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

OLD_DECL = """
  // 当前这一轮是谁在说话。生图端口靠它判断「这个请求是不是来自正在进行的对话」——
  // 一个已经结束的回合里，不该还能借道调用花钱的工具。
  let turnContext = null;
"""

OLD_WRITE = "    turnContext = { key, reason: String(opts.wakeReason || ''), at: Date.now() };"
NEW_WRITE = "    globalThis.__qqTurnContext = { key, reason: String(opts.wakeReason || ''), at: Date.now() };"

OLD_READ = "    const ctx = turnContext;"
NEW_READ = "    const ctx = globalThis.__qqTurnContext;"

text = TARGET.read_text(encoding='utf-8')

if 'globalThis.__qqTurnContext' in text:
    print('已是修后形态，跳过')
    sys.exit(0)

for old, label in ((OLD_DECL, '删除局部声明'), (OLD_WRITE, '写入点'), (OLD_READ, '读取点')):
    n = text.count(old)
    if n != 1:
        print(f'❌ [{label}] 期望 1 处，实际 {n} 处，不写盘')
        sys.exit(1)
    print(f'   ✓ {label}')

text = text.replace(OLD_DECL, '\n  // 当前这一轮是谁在说话 —— 挂在 globalThis 上，因为写读两处跨函数作用域。\n')
text = text.replace(OLD_WRITE, NEW_WRITE)
text = text.replace(OLD_READ, NEW_READ)

if 'globalThis.__qqTurnContext' not in text or 'turnContext = {' in text:
    print('❌ 替换后校验失败，不写盘')
    sys.exit(1)

TARGET.write_text(text, encoding='utf-8')
print('✅ 作用域已修（globalThis.__qqTurnContext）')
