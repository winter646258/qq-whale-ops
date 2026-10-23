#!/usr/bin/env python3
"""给生图加一道「同一会话防连点」闸门。

背景（2026-10-23 线上实录）：
  12:22:36 / 12:22:46 / 12:23:04，同一个群会话在 28 秒里连发三次生图请求。
  每次要 36 秒左右才出图，一张 $0.01，也就是说一轮对话可能烧掉三张的钱，
  而且前两张的结果被后来的请求挤掉、根本发不出去。

做法：记录每个 key 上一次「真正开始画」的时间，60 秒内再来就 429 挡回去，
      提示里明确说「上一张还在画，别重复调」，让她自己停下而不是重试。
      只拦 generate；status 不受影响。
"""
import io
import sys

TARGET = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge'

MARK = '// MARKER: image-rate-limit'
THROTTLE_MS = 60000

DECL_ANCHOR = "  // 生图审批 + 主人私聊跨会话代发"
DECL_ADD = """  // MARKER: image-rate-limit
  // 同一会话 60 秒内只允许真正开画一次：一轮对话里连点三次 = 三张的钱 + 前两张白发。
  const IMAGE_THROTTLE_MS = 60_000;
  const imageLastStartAt = new Map();
"""

GATE_ANCHOR = """            log(`[reserved2] 生图请求（${permit.scene}，${key}）：${prompt.slice(0, 60)}`);
            const result = await generateImageNow({ prompt, size: body.size });"""
GATE_ADD = """            // MARKER: image-rate-limit
            // 防连点：上一张还在画（或者刚画完不到一分钟）就不要再花一次钱。
            const lastStart = Number(imageLastStartAt.get(key) || 0);
            const sinceLast = Date.now() - lastStart;
            if (lastStart && sinceLast < IMAGE_THROTTLE_MS) {
              const waitSec = Math.ceil((IMAGE_THROTTLE_MS - sinceLast) / 1000);
              log(`[reserved2] 生图被限流（${key}）：${waitSec} 秒内已画过一次，这次不画`);
              sendJson({
                ok: false,
                error: `上一张还在画（${waitSec} 秒前刚画过一张），别重复调 —— 画完会直接发出来。`,
                throttled: true,
                retryAfterMs: IMAGE_THROTTLE_MS - sinceLast
              }, 429);
              return;
            }
            imageLastStartAt.set(key, Date.now());
            log(`[reserved2] 生图请求（${permit.scene}，${key}）：${prompt.slice(0, 60)}`);
            const result = await generateImageNow({ prompt, size: body.size });"""


def main():
    p = f'{TARGET}/src/bridge.js'
    src = io.open(p, encoding='utf-8', newline='').read()
    if MARK in src:
        print('  已装，跳过')
        return 0

    n = src.count(DECL_ANCHOR)
    assert n == 1, f'声明锚点命中 {n} 次'
    src = src.replace(DECL_ANCHOR, DECL_ADD + DECL_ANCHOR, 1)

    n = src.count(GATE_ANCHOR)
    assert n == 1, f'闸门锚点命中 {n} 次（可能是生图端点被改过）'
    src = src.replace(GATE_ANCHOR, GATE_ADD, 1)

    assert src.count('imageLastStartAt') == 3, f'imageLastStartAt 出现 {src.count("imageLastStartAt")} 次（应为 3）'
    io.open(p, 'w', encoding='utf-8', newline='').write(src)
    print(f'  改了：防连点声明 + 限流闸门')
    return 0


if __name__ == '__main__':
    sys.exit(main())
