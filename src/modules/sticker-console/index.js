// ── 表情库管理（/api/stickers/*，控制台）────────────────────────────
//
// 四条路由原挂在 bridge.js 的 if 链里（原 L7872–7924）。它们是控制台用来
// 浏览 / 同步 / 标注表情库的，AI 侧走的是 /api/socialV2/sticker-* 那几条，互不相干。
//
// 依赖说明（这一族的关键是「引用会变」）：
//   stickerEntries / stickerSyncedAt 都是 main() 里的 `let`，syncStickerLibrary
//   拉完会把 stickerEntries **整体换成新数组**（L1676、L2268、L2281 三处赋值）。
//   所以这里**不能**拿快照值，全部通过 accessors 现取 —— 否则第一次同步之后
//   模块就会一直对着旧数组说话。
//
//   syncStickerLibrary / applyStickerNoteV2 / setStickerRemarkV2 是 main() 内的
//   函数声明，但它们自己闭包着上面的 let，宿主把它们包进 stickerHelpers 后
//   行为与老 if 链完全一致；formatStickerList 则是顶层 import 的纯函数，直接交引用。
//
//   唯一的例外是配置项 maxListCount：它从 this.ctx.cfg 现读，而 cfg 是 main()
//   里的 const（只改属性不改引用），所以直接注入即可。

import { readSightings } from '../../sticker-sightings.js';

/** 拒绝智能体调用。返回 true 表示已经响应完毕。（口径与其它模块逐字一致） */
function rejectAgent({ req, sendJson }) {
  if (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '') {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  return false;
}

async function listStickers({ req, url, sendJson }) {
  if (rejectAgent({ req, sendJson })) return;
  const h = this.ctx.stickerHelpers;
  const query = String(url.searchParams.get('query') ?? '').trim();
  const maxCount = Math.max(1, Number(this.ctx.cfg.socialV2?.sticker?.maxListCount) || 100);
  const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
  // GET 不触发强制同步（写副作用不挂在读接口上）：同步请用 POST /api/stickers/sync。
  try {
    const synced = await h.syncStickerLibrary(false);
    const list = h.formatStickerList(synced?.entries ?? h.entries(), query, count);
    sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? h.syncedAt(), fromCache: synced?.fromCache ?? false });
  } catch (error) {
    sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
  }
}

async function syncStickers({ req, sendJson }) {
  if (rejectAgent({ req, sendJson })) return;
  const h = this.ctx.stickerHelpers;
  try {
    const synced = await h.syncStickerLibrary(true);
    sendJson({ ok: true, total: synced?.entries?.length ?? h.entries().length, syncedAt: synced?.syncedAt ?? h.syncedAt() });
  } catch (error) {
    sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
  }
}

async function noteSticker({ req, sendJson, readBody }) {
  if (rejectAgent({ req, sendJson })) return;
  const h = this.ctx.stickerHelpers;
  const body = await readBody();
  const stickerId = String(body.stickerId ?? '').trim();
  const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
  const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
  const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
  if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
  const entry = h.applyStickerNoteV2(stickerId, note, tags, usage);
  if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
  sendJson({ ok: true, sticker: entry });
}

async function remarkSticker({ req, sendJson, readBody }) {
  if (rejectAgent({ req, sendJson })) return;
  const h = this.ctx.stickerHelpers;
  const body = await readBody();
  const stickerId = String(body.stickerId ?? '').trim();
  if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
  try {
    const entry = await h.setStickerRemarkV2(stickerId, String(body.remark ?? ''));
    sendJson({ ok: true, sticker: entry });
  } catch (error) {
    sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
  }
}

async function sightingStats({ req, url, sendJson }) {
  if (rejectAgent({ req, sendJson })) return;
  const minCount = Math.max(1, Number(url.searchParams.get('minCount')) || 1);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  try {
    const data = readSightings(this.ctx.stateDir, { minCount });
    sendJson({ ok: true, total: data.total, matched: data.matched, updatedAt: data.updatedAt, items: data.items.slice(0, limit) });
  } catch (error) {
    sendJson({ ok: false, error: `读取出场记录失败：${error?.message ?? error}` }, 500);
  }
}

const inject = ['cfg', 'log', 'stateDir', 'stickerHelpers'];

const routes = [
  { method: 'GET', path: '/api/stickers', kind: 'exact', handler: listStickers },
  { method: 'POST', path: '/api/stickers/sync', kind: 'exact', handler: syncStickers },
  { method: 'POST', path: '/api/stickers/note', kind: 'exact', handler: noteSticker },
  { method: 'POST', path: '/api/stickers/remark', kind: 'exact', handler: remarkSticker },
  // 阶段 1 观测层：群里哪些图在反复出现（只读，供后面决定要不要推荐收藏）
  { method: 'GET', path: '/api/stickers/sightings', kind: 'exact', handler: sightingStats },
];

export default { name: 'sticker-console', title: '表情库管理（控制台）', inject, routes };
