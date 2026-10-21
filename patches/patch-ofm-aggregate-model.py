#!/usr/bin/env python3
"""修复 OFM 聚合渠道把带 provider 前缀的 catalog id 当上游 model 名发出去。

现象
    DSH 选「中转站」(our-free-model / deepseek/deepseek-v4.1-flash) 后，上游
    windking 返回 404：
        Model "deepseek/deepseek-v4.1-flash" is not available for this group
    而直连发裸名 deepseek-v4.1-flash 是 200。

根因
    src/adapter.js 的 payloadFor 里：buildPayload(wire, entry.id, ...) —— 第二个
    参数是 catalog 里带前缀的 id，buildPayload 会把它原样放进请求体的 model 字段。

    聚合渠道的上游是「别人的网关」，它没有我们的 provider 命名空间，只认自己的
    裸模型名。所以 deepseek/xxx 必被拒。

修法
    仅在 aggregate 渠道改用 entry.modelId（裸名）。其它渠道不动：
      - sealed(EAC)：deepseek-ai/deepseek-v4.1-flash 就是上游自己的模型名，拆了反错
      - kilo：同理
      - 直连：id 本来就是 DSH 侧的，走 endpointFor(entry.id)
    幂等：已是修后形态直接跳过。
"""
import pathlib
import sys

TARGET = pathlib.Path(
    '/root/.dsh/profiles/web/node_modules/dsh-our-free-model/src/adapter.js'
)

MARK = 'const wireModel = aggregate ? entry.modelId : entry.id'

OLD = (
    "      const payload = buildPayload(wire, entry.id, input, options, ceiling, resolveImage, sink)\n"
)

NEW = (
    "      // 聚合渠道的上游是别人的网关，只认自己的裸模型名。entry.id 带着我们的\n"
    "      // provider 前缀（deepseek/deepseek-v4.1-flash），原样发过去必然 404\n"
    "      // \"not available for this group\"。其它渠道的 entry.id 就是上游模型名，不能拆。\n"
    "      const wireModel = aggregate ? entry.modelId : entry.id\n"
    "      const payload = buildPayload(wire, wireModel, input, options, ceiling, resolveImage, sink)\n"
)

if not TARGET.exists():
    print(f'❌ 文件不存在: {TARGET}')
    sys.exit(1)

text = TARGET.read_text(encoding='utf-8')

if MARK in text:
    print('已是修后形态，跳过')
    sys.exit(0)

count = text.count(OLD)
if count != 1:
    print(f'❌ 期望命中 1 处，实际 {count} 处，不写盘')
    sys.exit(1)

text = text.replace(OLD, NEW)

if MARK not in text:
    print('❌ 替换后校验失败，不写盘')
    sys.exit(1)

TARGET.write_text(text, encoding='utf-8')
print('✅ adapter.js 已修（aggregate 渠道改用裸模型名）')
