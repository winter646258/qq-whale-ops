#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch-image-approval-tool.py —— 让智能体知道两条新路径（工具描述 + 审批查询工具）

用法：
    python3 patch-image-approval-tool.py [目标 mcp-snowluma-safe.js]

改 5 处：
  1. `qq_generate_image` 描述：说清「好友私聊也能要图，但要先问主人」，
     以及服务端会返回 `status: 'pending-approval'` 而不是图。
  2. `qq_send_message` 的 key 描述：说清「在主人私聊里可以代发到好友私聊」。
  3. `qq_send_sticker` 描述：同上（短一句）。
  4. 新增 `qq_image_approval` 工具：查待审申请。
  5. 登记到 TOOL_CONFIG_FLAGS。

为什么工具描述也要改：
  智能体只能看到描述。描述说「只有主人私聊/主人 @ 你才能用」，她就会在好友
  私聊里直接放弃、甚至不试。描述不改，功能装了等于没装 —— 这个坑在
  shared-memory 上踩过一次（`sharedMemoryLine` 算了却没进 prompt）。

坑（都踩过）：
  - MARKER 之间**不能有前缀关系**：`imgapprove-tool` 是
    `imgapprove-tool-desc` 的子串，于是第二处被误判成「已装」直接跳过。
  - MARKER 必须是**合法 JS 注释**：写成 `#` 会让整文件语法错；写进单引号
    字符串里会变成字符串内容（换行还会直接 SyntaxError）。
"""

import sys
import io

TARGET = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/mcp-snowluma-safe.js'

with io.open(TARGET, 'r', encoding='utf-8') as f:
    SRC = f.read()

changed = []


def ensure(cond, msg):
    if not cond:
        print('FAIL: ' + msg)
        sys.exit(1)


def apply(marker, anchor, addition, label, expect=1):
    global SRC
    if marker in SRC:
        print('  - %s：已装，跳过' % label)
        return
    n = SRC.count(anchor)
    ensure(n == expect, '%s 的锚点命中 %d 次（期望 %d）：%r' % (label, n, expect, anchor[:100]))
    SRC = SRC.replace(anchor, addition, 1)
    changed.append(label)


# ── 1. qq_generate_image 描述 ─────────────────────────────────────────────
apply('// MARKER: ia-desc-image',
      "'画一张图。只有主人私聊、或主人在群里 @ 你/叫你名字时才能用（其余场景服务端会拒绝，别硬试）。prompt 写清要什么：主体、风格、构图、色调。一张约 40 秒、花 $0.01，别连着画。返回 url（会过期）和本地路径（长期保留）。',",
      r"""'画一张图。prompt 写清要什么：主体、风格、构图、色调。一张约 40 秒、花 $0.01，别连着画。返回 url（会过期）和本地路径（长期保留）。\n'  // MARKER: ia-desc-image
    + '谁能画：① 主人私聊、或主人在群里 @ 你/叫你名字时，直接画；② 好友私聊里也能要，但**不会立刻画**——'
    + '服务端会返回 status="pending-approval" 和 approvalId，意思是已经把请求转给主人了，等主人点头才画，'
    + '画好会直接发到对方会话。收到 pending-approval 就如实告诉对方「我去问问」然后结束，别重试、别说「马上画」。'
    + '③ 其他场景（群里别人喊你、陌生人私聊）服务端会拒绝，别硬试。',""",
      '生图工具描述')

# ── 2. qq_send_message 的 key 描述补代发 ──────────────────────────────────
apply('// MARKER: ia-desc-send', """    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),""",
      """    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号。在主人私聊里，可以用主人自己的令牌填好友的 private:QQ号，代主人给那位好友发消息（只限私聊、目标必须是好友；群不行）。其他会话只能发自己。'),  // MARKER: ia-desc-send
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),""",
      '发送工具描述（代发）')

# ── 3. qq_send_sticker 描述补一句 ─────────────────────────────────────────
STICKER_OLD = ("'在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。"
               "注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply "
               "作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。"
               "真人偶尔用表情包很自然，但别刷屏。',")
STICKER_NEW = ("'在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。"
               "注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply "
               "作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。"
               "真人偶尔用表情包很自然，但别刷屏。和 qq_send_message 一样，主人私聊里可以填好友的 private:QQ号代发（只限私聊好友）。',  // MARKER: ia-desc-sticker")
apply('// MARKER: ia-desc-sticker', STICKER_OLD, STICKER_NEW, '表情工具描述（代发）')

# ── 4. 新增 qq_image_approval 工具 ────────────────────────────────────────
apply('// MARKER: ia-query-tool', """// MARKER: ghosttool
server.connect(new StdioServerTransport());""", r"""// MARKER: ia-query-tool
// 生图审批的查询入口。批准动作**不在**这里：主人在 QQ 里回「通过 / 拒绝」，
// 那条路径会直接触发画图和回执。工具只让她查得清「谁在等、等到哪一步」。
server.tool(
  'qq_image_approval',
  '查好友的生图申请（谁想要图、要画什么、批了没有）。主人问「谁要图来着」「刚才那个批了吗」时用它。'
  + '注意：**批准/拒绝不在这里做**——主人在 QQ 私聊里直接回「通过」或「拒绝」就行（可以带编号，比如「通过 ia3f2」）。'
  + '这个工具只是让她能查清楚状况，不要拿它去替主人做决定。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/image-approval?action=list', {
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查生图申请失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// MARKER: ghosttool
server.connect(new StdioServerTransport());""", '审批查询工具')

# ── 5. 登记到 TOOL_CONFIG_FLAGS ───────────────────────────────────────────
apply('// MARKER: ia-flag', "  qq_generate_image: 'image',", """  qq_generate_image: 'image',
  qq_image_approval: 'image',  // MARKER: ia-flag""", '工具开关登记')

with io.open(TARGET, 'w', encoding='utf-8') as f:
    f.write(SRC)

print('\n已改动：' + ('、'.join(changed) if changed else '（无，全部已装）'))
print('文件大小：%d 字节' % len(SRC.encode('utf-8')))
