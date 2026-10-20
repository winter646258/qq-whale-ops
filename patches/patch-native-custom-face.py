"""让 QQ 收藏表情以「原生表情」发出（而不是可下载的图片）。

问题（2026-10-20 实测）：
  sendStickerV2 一律把表情下载成 base64 走 image 段：
      segments.push({ type: 'image', data: { file: 'base64://...' } })
  结果对方看到的是「可下载的图片」，收藏栏里存不进 —— 她在群里也自己说了：
      19:44:39  「？那就是表情，你那边显示成图了」

网关有专门动作（SnowLuma 源码注释）：
  name: "send_custom_face"
  summary: "发送账号收藏表情（emoji_id 或 MD5），保留表情显示样式"
  它把段落组装成带 sub_type=1 的 image 段，对方看到的是「表情」。

改法：
  source==='qq'（真·账号收藏表情，有 emoji_id/md5）→ 优先走 send_custom_face；
  需要 @ 时回退图片方式（该通道只支持 reply_to，不支持 at）；
  send_custom_face 失败也自动回退图片方式（保持可用性）。
  本地导入（source!=='qq'，没有 emoji_id）→ 只能走图片，保持原样。

顺带：QQ 收藏表情回退时给 image 段补 sub_type/summary（与网关同一套字段）。
"""
import os
import shutil
import time

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()

if 'MARKER: native-custom-face' in src:
    print('[skip] 已打过')
    raise SystemExit(0)

# ── ① 通道选择：条件下载 ────────────────────────────────────────
OLD1 = """    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });"""

NEW1 = """    // MARKER: native-custom-face
    // ── 通道选择：QQ 收藏表情优先走网关的原生表情通道 ──────────────────
    // 原实现一律下载成 base64 走 image 段，对方看到的是「可下载的图片」，
    // 收藏栏里存不进。网关的 send_custom_face 会把段落组装成带 sub_type=1 的
    // image 段（其注释写明「保留表情显示样式」），对方看到的才是「表情」。
    // 限制：该通道只支持 reply_to、不支持 @，所以需要 @ 时回退图片方式。
    const stickerIdForFace = String(entry.id || entry.md5 || '');
    const isQqFace = String(entry.source) === 'qq' && stickerIdForFace !== '';
    const wantAt = atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '';
    const useNativeFace = isQqFace && !wantAt;

    // 非原生通道（以及原生通道失败后的回退）仍需图片字节。
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image = null;
    if (!useNativeFace) {
      try {
        image = await safeFetchBuffer(url);
      } catch (error) {
        throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
      }
      segments.push({
        type: 'image',
        data: {
          file: 'base64://' + image.buffer.toString('base64'),
          // QQ 收藏表情回退时补齐与网关同款的「表情」标记
          ...(isQqFace ? { sub_type: 1, summary: '[动画表情]' } : {})
        }
      });
    }"""

if src.count(OLD1) != 1:
    print(f'✖ 锚点1 异常: {src.count(OLD1)}')
    raise SystemExit(1)
src = src.replace(OLD1, NEW1)

# ── ② sendChain 内：优先原生通道，失败回退 ──────────────────────
OLD2 = """        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {"""

NEW2 = """        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        // ① 优先用网关原生表情通道：对方看到「表情」，不是可下载的图片。
        if (useNativeFace) {
          const faceParams = kind === 'private'
            ? { emoji_id: stickerIdForFace, user_id: Number(id) }
            : { emoji_id: stickerIdForFace, group_id: Number(id) };
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            faceParams.reply_to = String(replyToMessageId).trim();
          }
          try {
            const faceRes = await bot.request('send_custom_face', faceParams);
            if (faceRes && faceRes.status === 'ok' && faceRes.retcode === 0) {
              log(`[sticker] 发送原生表情 ${key}: ${stickerIdForFace}`);
              sendResolve(faceRes.data);
              return;
            }
            log(`[sticker] send_custom_face 被拒（${faceRes?.wording || faceRes?.retcode || 'unknown'}），回退图片方式`);
          } catch (error) {
            log(`[sticker] send_custom_face 异常（${error?.message ?? error}），回退图片方式`);
          }
          // 回退：补上图片段后继续走原来的 HTTP 通道
          const fallback = await safeFetchBuffer(url);
          segments.push({ type: 'image', data: { file: 'base64://' + fallback.buffer.toString('base64'), sub_type: 1, summary: '[动画表情]' } });
        }
        const res = await fetch(`${httpUrl}/${action}`, {"""

if src.count(OLD2) != 1:
    print(f'✖ 锚点2 异常: {src.count(OLD2)}')
    raise SystemExit(1)
src = src.replace(OLD2, NEW2)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak-nativeface-{stamp}'
shutil.copy2(P, bak)
open(P + '.tmp', 'w', encoding='utf-8').write(src)
os.replace(P + '.tmp', P)
print(f'[ok] 已打补丁；备份 -> {bak}')
print(f'  MARKER: {src.count("MARKER: native-custom-face")}')
print(f'  send_custom_face: {src.count("send_custom_face")} 处')
print(f'  useNativeFace: {src.count("useNativeFace")} 处')
