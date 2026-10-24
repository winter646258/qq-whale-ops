// AI 工具面 · 生活类（情绪 / 日记迁移 / 反馈 / B 站 / Spotify）
// 阶段26：从 bridge.js 的 if 链搬出来（原来同属 v2:extras 族）。
//
// 这一族共同点：**都是「她自己用」的接口**，鉴权走
//   带 x-agent-token → agentTokenOk → v2SessionAllowed → v2ToolEnabled(<flag>)
//   不带令牌        → 控制台
// 所以不能统一套 rejectAgent，每个 handler 自己走一遍（细节还各有不同的先后，
// 例如 mood 的 cfg 开关在工具开关之后、feedback 的限频在鉴权之后）。
import { DIARY_JSONL, DIARY_LEGACY_MD, readDiary, writeDiary, parseLegacyMarkdown } from '../../diary-store.js';
import { describeMood, setMood, ventUndercurrent, resolveUndercurrent, setBaseline, moodStats } from '../../mood-store.js';

// 带令牌才校验的三道门；返回 true = 已应答、调用方直接 return。
function rejectAi(ctx, req, sendJson, key, tool, what) {
  const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
  if (!agentToken) return false;
  if (!ctx.agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
  if (!ctx.v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
  if (!ctx.v2ToolEnabled(tool)) { sendJson({ ok: false, error: `工具未启用：${what}` }, 403); return true; }
  return false;
}

// ── GET/POST /api/socialV2/mood ────────────────────────────────────────────
async function mood({ req, url, sendJson, readBody }) {
  try {
    const ctx = this.ctx;
    const q = url.searchParams;
    const body = req.method === 'POST' ? ((await readBody()) ?? {}) : {};
    const key = String(body.key ?? q.get('key') ?? '').trim();
    const action = String(body.action ?? q.get('action') ?? 'read').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (rejectAi(ctx, req, sendJson, key, 'mood', 'qq_mood')) return;
    if (ctx.cfg.socialV2?.mood?.enabled === false) { sendJson({ ok: false, error: 'qq_mood 已在配置里关闭' }, 403); return; }

    const store = ctx.aiExtrasHelpers.moodStore();
    if (action === 'read') {
      sendJson({
        ok: true, key, action,
        view: describeMood(store, Date.now()),
        stats: moodStats(store, Date.now()),
        // 暗流要带 id，否则她没法 resolve —— 注入里不展开内容，翻明细得主动看。
        undercurrent: store.undercurrent.map((it) => ({ id: it.id, text: it.text, weight: it.weight, at: it.at })),
        // MARKER: affinity-migrate-read
        // 好感度按会话取。没存过就是 null —— **绝不回退到某个全局值**，
        // 那份全局值是谁最后说的就归谁，回退等于把别人的评价说给这个人听。
        affinity: ctx.aiExtrasHelpers.affinityEntryFor(key)
      });
      return;
    }
    if (action === 'set') {
      const next = setMood(store, { label: body.label, reason: body.reason, pleasure: body.pleasure, arousal: body.arousal, dominance: body.dominance });
      ctx.aiExtrasHelpers.saveMoodSafe(next, '情绪');
      sendJson({ ok: true, key, action, view: describeMood(next, Date.now()), stats: moodStats(next, Date.now()) });
      return;
    }
    if (action === 'vent') {
      const next = ventUndercurrent(store, { text: body.text, weight: body.weight });
      ctx.aiExtrasHelpers.saveMoodSafe(next, '情绪');
      sendJson({ ok: true, key, action, view: describeMood(next, Date.now()), undercurrent: next.undercurrent });
      return;
    }
    if (action === 'resolve') {
      const r = resolveUndercurrent(store, body.id ?? q.get('id'));
      if (!r.item) { sendJson({ ok: false, error: '找不到这件事（id=' + String(body.id ?? '') + '）' }, 404); return; }
      ctx.aiExtrasHelpers.saveMoodSafe(r.state, '情绪');
      sendJson({ ok: true, key, action, resolved: r.item, view: describeMood(r.state, Date.now()), undercurrent: r.state.undercurrent });
      return;
    }
    if (action === 'affinity') {
      // MARKER: affinity-migrate-write
      // 只写按会话那一份。写不成就让它抛出去 —— 让她看到「没改成」，
      // 而不是以为改了、下次还念着旧评价。
      const entry = ctx.aiExtrasHelpers.recordAffinityForKey(key, { level: body.level, note: body.note });
      sendJson({ ok: true, key, action, affinity: entry, view: describeMood(store, Date.now()) });
      return;
    }
    if (action === 'baseline') {
      const r = setBaseline(store, { pleasure: body.pleasure, arousal: body.arousal, dominance: body.dominance });
      ctx.aiExtrasHelpers.saveMoodSafe(r.state, '情绪');
      sendJson({ ok: true, key, action, moved: r.moved, baseline: r.state.baseline, view: describeMood(r.state, Date.now()) });
      return;
    }
    sendJson({ ok: false, error: '不认识的 action：' + action + '（可用 read/set/vent/resolve/affinity/baseline）' }, 400);
  } catch (error) {
    sendJson({ ok: false, error: '情绪操作失败：' + (error?.message ?? error) }, 500);
  }
}

// ── POST /api/socialV2/diary/migrate ──────────────────────────────────────
async function diaryMigrate({ sendJson }) {
  try {
    const ctx = this.ctx;
    const target = ctx.path.join(ctx.rootDir, 'diary', DIARY_JSONL);
    const legacy = ctx.path.join(ctx.rootDir, 'diary', DIARY_LEGACY_MD);
    const existing = readDiary(target);
    if (existing.length) {
      sendJson({ ok: true, skipped: true, reason: '目标 jsonl 已有内容，不覆盖', total: existing.length });
      return;
    }
    const parsed = parseLegacyMarkdown(legacy);
    if (!parsed.length) { sendJson({ ok: true, migrated: 0, reason: '旧日记没有可迁移的条目' }); return; }
    // 旧数据没有机器时间戳：给个递增的占位 t，保证排序稳定；time 保留原文。
    const base = Date.now() - parsed.length * 1000;
    for (let i = 0; i < parsed.length; i += 1) {
      parsed[i].t = base + i * 1000;
      if (!parsed[i].id) parsed[i].id = 'd' + (i + 1).toString(16).padStart(5, '0');
    }
    writeDiary(target, parsed);
    ctx.log(`日记迁移：从 ${DIARY_LEGACY_MD} 迁入 ${parsed.length} 条（时间戳保留原文，未纠时区）`);
    sendJson({ ok: true, migrated: parsed.length, total: parsed.length });
  } catch (error) {
    sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
  }
}

// ── POST /api/socialV2/feedback ───────────────────────────────────────────
async function feedback({ req, sendJson, readBody }) {
  const ctx = this.ctx;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
  const rawMessage = String(body.message ?? '').trim();
  if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
  if (rejectAi(ctx, req, sendJson, key, 'feedback', 'qq_report_feedback')) return;
  // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
  const fNow = Date.now();
  const fTimes = ctx.aiExtrasHelpers.feedbackTimes().get(key) || [];
  const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
  const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
  if (fRecentMinute >= 5 || fRecentHour >= 20) { sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429); return; }
  fTimes.push(fNow);
  ctx.aiExtrasHelpers.feedbackTimes().set(key, fTimes.slice(-100));
  const maxLength = Math.max(1, Number(ctx.cfg.socialV2?.feedback?.maxLength) || 500);
  const message = ctx.truncateText(rawMessage, maxLength);
  ctx.aiExtrasHelpers.appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
  ctx.log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
  ctx.appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
  if (ctx.cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && ctx.cfg.ownerQQ) {
    ctx.log(`[reserved2] 错误级反馈，可通知 owner ${ctx.cfg.ownerQQ}（当前仅记录日志）`);
  }
  sendJson({ ok: true, key, level, message });
}

// ── ANY /api/socialV2/spotify ─────────────────────────────────────────────
async function spotify({ req, url, sendJson, readBody }) {
  try {
    const ctx = this.ctx;
    const body = req.method === 'POST' ? ((await readBody()) ?? {}) : {};
    const q = url.searchParams;
    const key = String(body.key ?? q.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (rejectAi(ctx, req, sendJson, key, 'spotify', 'spotify')) return;

    const action = String(body.action ?? q.get('action') ?? 'now-playing').trim();
    const ACTIONS = ['search', 'now-playing', 'playlists', 'playlist-items', 'saved-tracks', 'status'];
    if (!ACTIONS.includes(action)) {
      sendJson({ ok: false, error: `action 必须是 ${ACTIONS.join(' / ')}` }, 400);
      return;
    }

    const sp = ctx.aiExtrasHelpers.spotifyClient();
    if (!sp.configured && action !== 'status') {
      sendJson({ ok: false, error: 'Spotify 还没配置：config.json 里的 spotify.clientId / clientSecret 是空的。' }, 503);
      return;
    }
    if (action === 'status') {
      sendJson({ ok: true, action, configured: sp.configured, authorized: sp.hasRefreshToken(),
        scope: sp.grantedScope(),
        remind: sp.hasRefreshToken() ? '' : '还没授权用户级权限：搜索能用，看正在播放/歌单需要主人点一次授权。' });
      return;
    }
    if (action === 'search') {
      const r = await sp.search(body.keyword ?? body.q, { type: body.type, limit: body.limit });
      sendJson({ ok: true, action, ...r }); return;
    }
    if (action === 'now-playing') {
      const r = await sp.nowPlaying();
      sendJson({ ok: true, action, ...r }); return;
    }
    if (action === 'playlists') {
      sendJson({ ok: true, action, items: await sp.myPlaylists(body.limit) }); return;
    }
    if (action === 'playlist-items') {
      sendJson({ ok: true, action, items: await sp.playlistItems(body.playlistId ?? body.id, body.limit) }); return;
    }
    sendJson({ ok: true, action, items: await sp.mySavedTracks(body.limit) });
  } catch (error) {
    const needsAuth = Boolean(error?.needsAuth);
    this.ctx.log(`[spotify] 查询失败：${error?.message ?? error}`);
    sendJson({ ok: false, error: String(error?.message ?? error), needsAuth }, needsAuth ? 401 : 502);
  }
}

export default {
  name: 'ai-extras',
  title: 'AI 工具面 · 情绪/日记/反馈/外部服务',
  inject: [
    'cfg', 'log', 'path', 'rootDir',
    'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled',
    'truncateText', 'appendActivity',
    'aiExtrasHelpers',
  ],
  routes: [
    { method: 'GET', path: '/api/socialV2/mood', kind: 'exact', handler: mood },
    { method: 'POST', path: '/api/socialV2/mood', kind: 'exact', handler: mood },
    { method: 'GET', path: '/api/socialV2/spotify', kind: 'exact', handler: spotify },
    { method: 'POST', path: '/api/socialV2/spotify', kind: 'exact', handler: spotify },
    { method: 'POST', path: '/api/socialV2/diary/migrate', kind: 'exact', handler: diaryMigrate },
    { method: 'POST', path: '/api/socialV2/feedback', kind: 'exact', handler: feedback },
  ],
};