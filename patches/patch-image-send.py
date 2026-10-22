#!/usr/bin/env python3
"""
让 qq_generate_image 画完直接把图发出去。

为什么需要这个补丁
------------------
`qq_generate_image` 只把 url / 本地路径当文本回给模型，而 `/api/send/*` 走
`onebotSend`，那里只构造 `{type:'text'}` 一个消息段 —— 发送路径根本没有图片能力。
于是她画完一张图，主人那边什么都收不到，图躺在 `state/images/` 里，钱已经花了。

2026-10-22 早上主人说的「token 花了但图发不出来」就是这个，不是超时。

改法（两处）
------------
1. `onebotSend` 加第 6 个参数 `images`：本地 PNG 读成 base64，拼成 image 段；
   文本为空时不再塞空 text 段。顺手加两条防线：只允许 `state/images/` 下的文件、
   单张不超过 `MAX_MEDIA_BYTES`。
2. `/api/socialV2/image` 的 generate 分支：生成成功后直接调 `onebotSend` 发出去，
   返回体多一个 `sent` 字段。发送失败只记日志，不影响生图结果本身。

用法
----
    python3 patch-image-send.py [--dry-run]

约定：每处必须恰好命中 1 次，任何一处对不上就整体不写盘。
"""

import re
import sys
from pathlib import Path

BRIDGE = Path('/opt/qq-bridge/src/bridge.js')

DRY = '--dry-run' in sys.argv


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        print(f'❌ {label}：命中 {n} 处（要求恰好 1 处），不写盘')
        sys.exit(1)
    print(f'✅ {label}：命中 1 处')
    return text.replace(old, new, 1)


src = BRIDGE.read_text(encoding='utf-8')
orig = src

# ── 1. onebotSend 支持图片段 ───────────────────────────────────────────────
old_send_sig = """  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {"""
new_send_sig = """  // images：本地图片绝对路径数组。为空时行为与旧版完全一致（只发文本）。
  // 存在的理由见 /api/socialV2/image 的 generate 分支 —— 生图工具只回路径，必须由这里发出去。
  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null, images = []) {"""
src = sub(src, old_send_sig, new_send_sig, 'onebotSend 增加 images 参数')

old_text_seg = """    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';"""
new_text_seg = """    if (rawMessage.trim()) {
      segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    }
    // 图片段：只接受生图目录里的文件，避免这条通道被 prompt injection 用来读任意本地文件。
    const imageRoot = path.join(STATE_DIR, 'images') + path.sep;
    for (const file of images) {
      const abs = path.resolve(String(file));
      if (!abs.startsWith(imageRoot)) {
        throw new Error(`只允许发送生图目录里的图片：${abs}`);
      }
      const buf = fs.readFileSync(abs);
      if (!buf.length) throw new Error(`图片是空的：${abs}`);
      if (buf.length > MAX_MEDIA_BYTES) {
        throw new Error(`图片太大（${Math.round(buf.length / 1024)}KB > ${Math.round(MAX_MEDIA_BYTES / 1024)}KB）`);
      }
      segments.push({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } });
    }
    if (!segments.length) throw new Error('消息不能为空');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';"""
src = sub(src, old_text_seg, new_text_seg, 'onebotSend 拼图片段')

# ── 2. 生图成功后直接发出去 ────────────────────────────────────────────────
old_gen = """            const result = await generateImageNow({ prompt, size: body.size });
            sendJson({ ok: true, key, action, scene: permit.scene, ...result });"""
new_gen = """            const result = await generateImageNow({ prompt, size: body.size });
            // 画完就发：工具只把 url/本地路径当文本回给模型，她自己看不到图，主人也收不到。
            // 不发等于白画一张（$0.01），所以默认发。发送失败只记日志，生图结果照常返回。
            let sent = false;
            try {
              if (result?.path) {
                const [sendKind, sendId] = String(key).split(':');
                if ((sendKind === 'group' || sendKind === 'private') && Number(sendId) > 0) {
                  await onebotSend(sendKind, Number(sendId), '', null, null, [result.path]);
                  sent = true;
                  log(`[reserved2] 生图已发送（${key}）：${path.basename(result.path)}`);
                }
              }
            } catch (error) {
              log(`[reserved2] 生图后发送失败（${key}）：${error?.message ?? error}`);
            }
            sendJson({ ok: true, key, action, scene: permit.scene, sent, ...result });"""
src = sub(src, old_gen, new_gen, '生图成功后直接发送')

if src == orig:
    print('⚠️ 没有任何变化')
    sys.exit(0)

if DRY:
    print('\n— dry-run，未写盘 —')
    sys.exit(0)

backup = BRIDGE.with_suffix('.js.bak-20261022-image-send')
backup.write_text(orig, encoding='utf-8')
BRIDGE.write_text(src, encoding='utf-8')
print(f'\n✅ 已写入 {BRIDGE}')
print(f'   备份：{backup}')
