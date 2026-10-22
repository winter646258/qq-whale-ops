#!/usr/bin/env python3
"""修 qq_generate_image 的 MCP 层超时：默认 15 秒 → 180 秒。

现象（12:45 实测）：私聊里她先说「超时」，35 秒后图才到。

原因：MCP 工具的 agentApi 没传 timeoutMs，落到 `init.timeoutMs || 15000`
（mcp-snowluma-safe.js:126）。生图实测 35~50 秒，所以工具在 15 秒时 abort，
她据此回「超时」；而 bridge 侧 generateImageNow 用的是
`AbortController` + 180 秒（bridge.js:8998），请求没被打断，几十秒后画完，
再由 patch-image-send 新增的自动发送把图发出去。

于是用户看到的就是：先被回一句超时，图随后才冒出来。

修法：把这个工具的 timeoutMs 对齐到 bridge 侧的 180 秒。
协议层不用动 —— setup-dsh.mjs 给 mcp-snowluma 配的 toolCallTimeoutMs 是
725 秒，绰绰有余。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/mcp-snowluma-safe.js')

OLD = """        body: JSON.stringify({ key, token, action: 'generate', prompt, size }),
        headers: { 'x-agent-token': token }
      });"""

NEW = """        body: JSON.stringify({ key, token, action: 'generate', prompt, size }),
        headers: { 'x-agent-token': token },
        // 生图实测 35~50 秒；bridge 侧 AbortController 是 180 秒，这里必须对齐。
        // 用 agentApi 默认的 15000ms 会让工具先 abort，而她其实画完了、图稍后才发。
        timeoutMs: 180000
      });"""


def main():
    text = TARGET.read_text(encoding='utf-8')
    n = text.count(OLD)
    if n != 1:
        print(f'❌ 命中 {n} 次（应为 1），拒绝写盘')
        return 1
    TARGET.write_text(text.replace(OLD, NEW), encoding='utf-8')
    print('✅ mcp-snowluma-safe.js：qq_generate_image 已补 timeoutMs: 180000')
    return 0


if __name__ == '__main__':
    sys.exit(main())
