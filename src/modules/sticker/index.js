// ── 表情库（AI 侧工具面）：/api/socialV2/sticker-* ───────────────────
//
// 五条路由原挂在 bridge.js 的 if 链里（原 L6755–6842、L7845–7909）。这一族是
// qq_get_sticker_image / qq_sticker_note / qq_set_sticker_remark /
// qq_list_stickers 四条 MCP 工具的后端 —— 所以和 sticker-console 那三条
// 「控制台专用」的 /api/stickers/* 不是同一件事，两者刻意分成两个模块。
//
// **鉴权口径（与老 if 链逐条对齐，不要图省事套 rejectAgent）**：
//   这一族走的是 agent 通道，`x-agent-token` 必须带，并且依次校验
//     ①agentTokenOk(key, token)     —— 令牌得是这个会话的
//     ②v2SessionAllowed(key)        —— 会话得在当前模式允许范围内
//     ③v2ToolEnabled('<flag>')      —— 这个工具得没被关掉
//   外加最前面的 stickerEnabled()：表情包体系整体关闭时一律 403。
//   改这里任何一条校验的顺序，都会直接改变 AI 的可见面。
//
// 依赖里有两个「会被重新赋值」的 main() 变量：
//   lastForcedAgentStickerSync —— POST sticker-list 的 10 秒刷新节流，模块要读也要写，
//                                 所以交 getter + setter，不能交快照值。
//   stickerEntries / stickerSyncedAt —— 由 stickerHelpers 的访问器提供。

/** 表情包体系是否开着。关闭时这一族全部 403。 */
function stickerEnabled(ctx) {
  return ctx.stickerHelpers.enabled();
}

/**
 * 这一族共用的 agent 校验。
 * @returns {string|null} 拒绝原因；null 表示放行。
 */
function rejectBadAgent(ctx, { req, key, flag, toolName }) {
  const token = req.headers['x-agent-token'];
  if (token && !ctx.agentTokenOk(key, token)) return 'agent token 无效';
  if (token && !ctx.v2SessionAllowed(key)) return '目标不在当前模式允许范围内';
  if (token && !ctx.v2ToolEnabled(flag)) return `工具未启用：${toolName}`;
  return null;
}

async function listStickers({ req, url, sendJson }) {
  if (!stickerEnabled(this.ctx)) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
  const ctx = this.ctx;
  const key = String(url.searchParams.get('key') ?? '').trim();
  const query = String(url.searchParams.get('query') ?? '').trim();
  const maxCount = Math.max(1, Number(ctx.cfg.socialV2?.sticker?.maxListCount) || 100);
  const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
  // GET 上**不支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
  // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
  // 需要强制同步时用同一路径的 POST，或控制台的 POST /api/stickers/sync。
  const force = false;
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  const denial = rejectBadAgent(ctx, { req, key, flag: 'listStickers', toolName: 'qq_list_stickers' });
  if (denial) { sendJson({ ok: false, error: denial }, 403); return; }
  try {
    const h = ctx.stickerHelpers;
    const synced = await h.syncStickerLibrary(force);
    const list = h.formatStickerList(synced?.entries ?? h.entries(), query, count);
    sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? h.syncedAt(), fromCache: synced?.fromCache ?? false });
  } catch (error) {
    sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
  }
}

async function listStickersForce({ req, sendJson, readBody }) {
  if (!stickerEnabled(this.ctx)) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
  const ctx = this.ctx;
  const h = ctx.stickerHelpers;
  const body = await readBody();
  const key = String(body.key ?? '').trim();
  const query = String(body.query ?? '').trim();
  const maxCount = Math.max(1, Number(ctx.cfg.socialV2?.sticker?.maxListCount) || 100);
  const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
  let force = body.refresh === true;
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  const denial = rejectBadAgent(ctx, { req, key, flag: 'listStickers', toolName: 'qq_list_stickers' });
  if (denial) { sendJson({ ok: false, error: denial }, 403); return; }
  // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
  if (req.headers['x-agent-token'] && force) {
    const now = Date.now();
    if (now - h.lastForcedSync() < 10000) force = false;
    else h.setLastForcedSync(now);
  }
  try {
    const synced = await h.syncStickerLibrary(force);
    const list = h.formatStickerList(synced?.entries ?? h.entries(), query, count);
    sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? h.syncedAt(), fromCache: synced?.fromCache ?? false });
  } catch (error) {
    sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
  }
}

async function stickerImage({ req, url, sendJson }) {
  if (!stickerEnabled(this.ctx)) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
  const ctx = this.ctx;
  const key = String(url.searchParams.get('key') ?? '').trim();
  const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
  if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
  const denial = rejectBadAgent(ctx, { req, key, flag: 'getStickerImage', toolName: 'qq_get_sticker_image' });
  if (denial) { sendJson({ ok: false, error: denial }, 403); return; }
  const m = ctx.mediaHelpers;
  try {
    const entry = await ctx.stickerHelpers.getStickerImageData(stickerId);
    const fetched = await ctx.safeFetchBuffer(entry.url, m.maxMediaBytes());
    const dims = m.getImageDimensions(fetched.buffer);
    if (dims && dims.width * dims.height > m.maxMediaPixels()) {
      sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
      return;
    }
    const mimeType = m.mimeFromBuffer(fetched.buffer) || m.mimeFromUrl(entry.url);
    sendJson({
      ok: true,
      key,
      sticker: {
        id: entry.id,
        desc: entry.desc || '',
        localNote: entry.localNote || '',
        tags: entry.tags || [],
        url: entry.url,
        md5: entry.md5,
      },
      image: { mimeType, data: fetched.buffer.toString('base64') },
    });
  } catch (error) {
    // 引用写错（找不到 / 重名）是调用方的问题，用 400 让它去换 id；
    // 只有真的取图失败（网络、超限）才该是 500。老代码一律 500，是回落 catch 前的隐患。
    sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, Number(error?.statusCode) || 500);
  }
}

async function stickerNote({ req, sendJson, readBody }) {
  if (!stickerEnabled(this.ctx)) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
  const ctx = this.ctx;
  const body = await readBody();
  const key = String(body.key ?? '').trim();
  const stickerId = String(body.stickerId ?? '').trim();
  if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
  const denial = rejectBadAgent(ctx, { req, key, flag: 'stickerNote', toolName: 'qq_sticker_note' });
  if (denial) { sendJson({ ok: false, error: denial }, 403); return; }
  const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
  const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
  const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
  const entry = ctx.stickerHelpers.applyStickerNoteV2(stickerId, note, tags, usage);
  if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
  ctx.log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
  sendJson({ ok: true, key, sticker: entry });
}

async function stickerRemark({ req, sendJson, readBody }) {
  if (!stickerEnabled(this.ctx)) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
  const ctx = this.ctx;
  const body = await readBody();
  const key = String(body.key ?? '').trim();
  const stickerId = String(body.stickerId ?? '').trim();
  if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
  const denial = rejectBadAgent(ctx, { req, key, flag: 'setStickerRemark', toolName: 'qq_set_sticker_remark' });
  if (denial) { sendJson({ ok: false, error: denial }, 403); return; }
  try {
    const entry = await ctx.stickerHelpers.setStickerRemarkV2(stickerId, String(body.remark ?? ''));
    ctx.log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
    sendJson({ ok: true, key, sticker: entry });
  } catch (error) {
    sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
  }
}

const inject = [
  'cfg', 'log',
  'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled',
  'stickerHelpers', 'mediaHelpers', 'safeFetchBuffer',
];

const routes = [
  { method: 'GET', path: '/api/socialV2/sticker-list', kind: 'exact', handler: listStickers },
  { method: 'POST', path: '/api/socialV2/sticker-list', kind: 'exact', handler: listStickersForce },
  { method: 'GET', path: '/api/socialV2/sticker-image', kind: 'exact', handler: stickerImage },
  { method: 'POST', path: '/api/socialV2/sticker-note', kind: 'exact', handler: stickerNote },
  { method: 'POST', path: '/api/socialV2/sticker-remark', kind: 'exact', handler: stickerRemark },
];

export default { name: 'sticker', title: '表情库（AI 工具面）', inject, routes };
