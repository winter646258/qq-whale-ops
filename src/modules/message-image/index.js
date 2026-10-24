// 消息图片按需读取：`GET /api/images/message`。
//
// 鉴权：两路并存。
//   - 带 x-agent-token：必须匹配该会话的 agentToken，且 v2ToolEnabled('getImages')、模式允许。
//   - 不带 token：reserved2 模式直接拒（图片不自动内联，必须带令牌取）；
//     closed-agent 模式由操作者通道读取，但仍要求 getImages 开关（与老逻辑一致）。
//
// 依赖：cfg / log（基础块）+ currentMode / agentTokenOk / v2ToolEnabled / modeAllowed /
// findMessageMedia / fetchMediaData，全部交访问器或箭头 —— 前四个都在 startConsoleServer()
// 作用域内，后两个声明于 main() 中段，均晚于注入点。

function wrap(fn) {
  return async function handler(args) {
    try {
      return await fn.call(this, args);
    } catch (error) {
      args.sendJson({ ok: false, error: error?.message ?? String(error) }, Number(error?.statusCode) || 500);
      return undefined;
    }
  };
}

const messageImage = wrap(async function messageImage({ req, url, sendJson }) {
  const ctx = this.ctx;
  const key = String(url.searchParams.get('key') ?? '').trim();
  const messageId = String(url.searchParams.get('messageId') ?? '').trim();
  const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return undefined; }
  if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return undefined; }
  const currentMode = ctx.currentMode();
  if (currentMode === 'reserved2' && !agentToken) {
    sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
    return undefined;
  }
  if (currentMode === 'chat' || currentMode === 'reserved') {
    sendJson({ ok: false, error: '一代 chat/reserved 模式图片已自动内联，按需图片工具仅 reserved2 模式可用' }, 403);
    return undefined;
  }
  if (agentToken && !ctx.agentTokenOk(key, agentToken)) {
    sendJson({ ok: false, error: 'agent token 无效' }, 403);
    return undefined;
  }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0 || !ctx.modeAllowed(key, kind, id, ctx.cfg, currentMode)) {
    sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
    return undefined;
  }
  if (agentToken && !ctx.v2ToolEnabled('getImages')) {
    sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
    return undefined;
  }
  if (!agentToken && currentMode === 'closed-agent' && !ctx.v2ToolEnabled('getImages')) {
    sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
    return undefined;
  }
  const media = ctx.findMessageMedia(key, messageId);
  if (!media.length) {
    sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
    return undefined;
  }
  try {
    const images = await ctx.fetchMediaData(media);
    sendJson({ ok: true, messageId, media, images });
  } catch (error) {
    ctx.log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
    sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
  }
  return undefined;
});

export default {
  name: 'message-image',
  title: '消息图片按需读取',
  inject: ['cfg', 'log', 'currentMode', 'agentTokenOk', 'v2ToolEnabled', 'modeAllowed', 'findMessageMedia', 'fetchMediaData'],
  routes: [
    { method: 'GET', path: '/api/images/message', kind: 'exact', handler: messageImage },
  ],
};