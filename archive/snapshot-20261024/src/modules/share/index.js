// 阶段24：主动报告信号（share-signal）与跨会话共享记忆（shared-memory）。
// 原 src/bridge.js 两段 if 链（share-signal 约 L7623、shared-memory 约 L7764）。
//
// 鉴权口径（两条一样，写进 rejectV2）：
//   带 x-agent-token 时才校验 agentTokenOk → v2SessionAllowed → v2ToolEnabled(<flag>)；
//   不带令牌 = 控制台调用，一律放行（集中闸门已挡 anon）。
//   share-signal 的 flag 按 action 分：signal → shareSignal，policy → reportPolicy。
//   shared-memory 的 flag 固定 sharedMemory。
//
// 依赖：
//   纯逻辑全部是叶子模块的 import（share-signal-store.js / shared-memory-store.js），交引用安全；
//   getShareState / persistShareState / getSharedMemoryState / persistSharedMemoryState
//   是 main() 内函数，声明在本注入点之后 ⇒ 必须包箭头。
//   agentTokenOk / v2SessionAllowed / v2ToolEnabled 来自 modules-ctx-ops-token。

function rejectV2({ req, sendJson, key, tool, what }) {
  const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
  if (!agentToken) return false;
  if (!this.ctx.agentTokenOk(key, agentToken)) {
    sendJson({ ok: false, error: 'agent token 无效' }, 403);
    return true;
  }
  if (!this.ctx.v2SessionAllowed(key)) {
    sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
    return true;
  }
  if (tool && !this.ctx.v2ToolEnabled(tool)) {
    sendJson({ ok: false, error: `工具未启用：${what || tool}` }, 403);
    return true;
  }
  return false;
}

// ── 主动报告信号 ───────────────────────────────────────────────────────────
async function shareSignal({ req, url, sendJson, readBody }) {
  const body = req.method === 'POST' ? (await readBody()) ?? {} : {};
  const q = url.searchParams;
  const rawAction = String(body.action ?? q.get('action') ?? 'stats').trim();
  const action = ['signal', 'policy', 'stats'].includes(rawAction) ? rawAction : null;
  if (!action) {
    sendJson({ ok: false, error: 'action 必须是 signal / policy / stats' }, 400);
    return;
  }
  const key = String(body.key ?? q.get('key') ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }

  const needFlag = action === 'signal' ? 'shareSignal' : 'reportPolicy';
  if (rejectV2.call(this, { req, sendJson, key, tool: needFlag })) return;

  const h = this.ctx.shareHelpers;
  const st = h.getShareState();
  if (!st) {
    sendJson({ ok: false, error: '报告状态文件读取失败，请让主人检查 state/share-signal.json' }, 500);
    return;
  }
  const nowMs = Date.now();

  if (action === 'stats') {
    sendJson({
      ok: true,
      key,
      stats: this.ctx.shareStatsOf(st, { now: nowMs }),
      policy: this.ctx.normalizeSharePolicy(st.policy),
      pending: st.signals.map((s) => ({
        id: s.id, eventId: s.eventId, sourceGroup: s.sourceGroup,
        summary: s.summary, valence: s.valence, createdAt: s.createdAt
      })),
      recentDeliveries: st.deliveries.slice(-5).map((d) => ({
        eventId: d.eventId, at: d.at, answered: d.answered,
        settled: d.settled, summary: d.summary
      })),
      hardLimits: {
        minIntervalMs: this.ctx.SHARE_HARD_MIN_INTERVAL_MS,
        maxPerDay: this.ctx.SHARE_HARD_MAX_PER_DAY,
        maxSignals: this.ctx.SHARE_MAX_SIGNALS
      }
    });
    return;
  }

  if (action === 'signal') {
    // 只有群会话能报：主人私聊自身不能反复制造来信，这是计划里的硬规则。
    if (!this.ctx.isGroupKey(key)) {
      sendJson({
        ok: false,
        error: '主动报告只能由群会话发起：私聊里没有「群事件」，不该自己制造来信'
      }, 403);
      return;
    }
    // 也不能替别的群报：A 群发生的事从 B 群报出来就是串台。
    const sourceGroup = String(body.sourceGroup ?? key).trim() || key;
    if (sourceGroup !== key) {
      sendJson({
        ok: false,
        error: `只能报告本群的事：sourceGroup 必须是当前会话 ${key}`
      }, 403);
      return;
    }
    const r = this.ctx.addSignal(st, {
      eventId: body.eventId,
      summary: body.summary,
      valence: body.valence,
      sourceGroup,
      willingness: body.willingness,
      now: nowMs
    });
    if (!r.ok) {
      sendJson({ ok: false, error: this.ctx.shareRejectReason(r.reason), reason: r.reason }, 400);
      return;
    }
    h.persistShareState({
      action: 'signal',
      key,
      detail: {
        eventId: r.signal.eventId,
        summary: r.signal.summary,
        valence: r.signal.valence,
        willingness: r.signal.willingness
      }
    });
    this.ctx.log(`[share] 收到待报告信号（${key}，valence ${r.signal.valence}）：${r.signal.summary}`);
    sendJson({ ok: true, accepted: true, signal: r.signal, pending: st.signals.length });
    return;
  }

  // action === 'policy'
  // setPolicy 内部是 {...before, ...raw}，传 undefined 会把已有的自定义值
  // 打回默认。所以这里只挑真正给了的字段。
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.quietStartHour !== undefined && body.quietStartHour !== null) patch.quietStartHour = body.quietStartHour;
  if (body.quietEndHour !== undefined && body.quietEndHour !== null) patch.quietEndHour = body.quietEndHour;
  if (body.maxPerDay !== undefined && body.maxPerDay !== null) patch.maxPerDay = body.maxPerDay;
  if (body.minIntervalMs !== undefined && body.minIntervalMs !== null) patch.minIntervalMs = body.minIntervalMs;
  const changedKeys = Object.keys(patch);
  const r = this.ctx.setSharePolicy(st, patch, { now: nowMs });
  h.persistShareState({ action: 'policy', key, detail: { changed: changedKeys, before: r.before, after: r.after } });
  if (changedKeys.length) {
    this.ctx.log(`[share] 报告策略更新（${key}）：${changedKeys.join('/')} → 间隔 ${Math.round(r.after.minIntervalMs / 60000)} 分钟、每日 ${r.after.maxPerDay} 条、安静 ${r.after.quietStartHour}-${r.after.quietEndHour} 点`);
  }
  // 被夹回原值时明确告诉她，别说「改了」其实没改。
  const clamped = [];
  for (const k of changedKeys) {
    if (JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]) && String(patch[k]) !== String(r.after[k])) {
      clamped.push(k);
    }
  }
  sendJson({
    ok: true,
    before: r.before,
    after: r.after,
    clamped,
    note: clamped.length
      ? '有几项被系统硬上限夹回更保守的值（报告最短 6 小时一次、每日最多 4 条）'
      : null
  });
}

// ── 跨会话共享记忆 ─────────────────────────────────────────────────────────
// 四个 action：read / remember / forget / list。
// 鉴权口径与旁边 memory-append 一致：带 x-agent-token 时必须校验
// 令牌 + 会话在允许范围内 + 工具开关。不带令牌 = 控制台调用。
async function sharedMemory({ req, url, sendJson, readBody }) {
  const body = req.method === 'POST' ? (await readBody()) ?? {} : {};
  const q = url.searchParams;
  const rawAction = String(body.action ?? q.get('action') ?? 'read').trim();
  const action = ['read', 'remember', 'forget', 'list'].includes(rawAction) ? rawAction : null;
  if (!action) {
    sendJson({ ok: false, error: 'action 必须是 read / remember / forget / list' }, 400);
    return;
  }
  const key = String(body.key ?? q.get('key') ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }

  if (rejectV2.call(this, { req, sendJson, key, tool: 'sharedMemory', what: 'qq_shared_memory' })) return;

  const h = this.ctx.shareHelpers;
  const reader = h.sharedMemoryReaderFor(key);
  if (!reader) {
    // 非主人私聊没有读者身份。给一句人话，别让她以为「没有记忆」。
    sendJson({
      ok: false,
      error: '这个会话没有跨会话记忆权限：私聊只对主人开放，群里请在本群会话内使用'
    }, 403);
    return;
  }

  const store = h.getSharedMemoryState();
  if (!store) {
    sendJson({ ok: false, error: '共享记忆文件读取失败，请让主人检查 state/shared-memory.json' }, 500);
    return;
  }

  const nowMs = Date.now();
  try {
    if (action === 'read') {
      const groupOnly = String(body.group ?? q.get('group') ?? '').trim();
      if (groupOnly) {
        // 显式查阅某个群的群专属摘要：只有主人能点，且只给摘要。
        if (reader.kind !== 'owner') {
          sendJson({ ok: false, error: '只有主人可以按群查阅' }, 403);
          return;
        }
        const items = this.ctx.listGroupScopeForOwner(store, groupOnly, { now: nowMs });
        sendJson({
          ok: true, key, action, group: groupOnly,
          count: items.length,
          items: items.map((it) => ({
            id: it.id, text: it.text, importance: it.importance,
            pinned: it.pinned, lastMentionAt: it.lastMentionAt
          }))
        });
        return;
      }
      const items = this.ctx.listItems(store, { reader, now: nowMs });
      sendJson({
        ok: true, key, action,
        reader: reader.kind === 'owner' ? 'owner' : `group:${reader.id}`,
        count: items.length,
        stats: this.ctx.sharedMemoryStats(store, { now: nowMs }),
        items: items.map((it) => ({
          id: it.id,
          text: it.text,
          scope: it.scope,
          importance: it.importance,
          pinned: it.pinned,
          expiresAt: it.expiresAt || null
        }))
      });
      return;
    }

    if (action === 'list') {
      // 和 read 的区别：list 只回清单与统计，不展开正文（给控制台/体检用）。
      sendJson({
        ok: true, key, action,
        stats: this.ctx.sharedMemoryStats(store, { now: nowMs }),
        items: this.ctx.listItems(store, { reader, now: nowMs }).map((it) => ({
          id: it.id, scope: it.scope, importance: it.importance, pinned: it.pinned
        }))
      });
      return;
    }

    if (action === 'remember') {
      const text = String(body.text ?? '').trim();
      if (!text) { sendJson({ ok: false, error: 'text（要记什么）不能为空' }, 400); return; }
      // scope 不传时按当前会话给一个**最保守**的默认：
      // 群里默认 group:<本群>，私聊默认 owner_private。
      // 想跨群共享必须显式写 shared + visibleGroups。
      const defaultScope = reader.kind === 'owner'
        ? 'owner_private'
        : `group:${reader.id}`;
      const scopeRaw = String(body.scope ?? '').trim() || defaultScope;
      const visibleGroups = Array.isArray(body.visibleGroups) ? body.visibleGroups.map(String) : [];
      // 群里不许自己往 owner_private 里写（那等于绕过注入线的反向通道）。
      if (reader.kind !== 'owner' && /^owner_private$/.test(scopeRaw)) {
        sendJson({ ok: false, error: '群会话不能写 owner_private 层' }, 403);
        return;
      }
      // 群会话写 shared 时，visibleGroups 只能点自己这一群，
      // 不许把一个群的内容顺手公开到别的群去。
      if (reader.kind === 'group') {
        const bad = visibleGroups.filter((g) => String(g) !== String(reader.id));
        if (bad.length) {
          sendJson({ ok: false, error: `群会话只能把内容共享到本群：${bad.join(',')}` }, 403);
          return;
        }
        if (/^shared$/.test(scopeRaw) && !visibleGroups.length) visibleGroups.push(reader.id);
      }
      const dup = this.ctx.findSimilar(store, { text, reader, now: nowMs });
      const result = this.ctx.addItem(store, {
        text,
        scope: scopeRaw,
        visibleGroups,
        importance: body.importance,
        sourceRef: body.sourceRef ? String(body.sourceRef) : key,
        expiresAt: body.expiresAtMs ? nowMs + Math.max(60000, Number(body.expiresAtMs) || 0) : undefined,
        pinned: body.pinned === true,
        now: nowMs
      });
      this.ctx.pruneStore(store, {
        max: this.ctx.SHARED_MEMORY_MAX_ITEMS,
        maxArchived: this.ctx.SHARED_MEMORY_MAX_ARCHIVED,
        now: nowMs
      });
      const saved = h.persistSharedMemoryState(store, {
        action: 'remember', key, detail: { id: result.item.id, scope: result.item.scope, created: result.created }
      });
      if (!saved) { sendJson({ ok: false, error: '写入失败，详见服务日志' }, 500); return; }
      sendJson({
        ok: true, key, action,
        created: result.created,
        duplicateOf: dup ? dup.id : null,
        item: {
          id: result.item.id, text: result.item.text, scope: result.item.scope,
          visibleGroups: result.item.visibleGroups, importance: result.item.importance,
          pinned: result.item.pinned
        }
      });
      return;
    }

    if (action === 'forget') {
      const id = String(body.id ?? '').trim();
      if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
      const target = (store.items || []).find((it) => it && it.id === id);
      if (!target) { sendJson({ ok: false, error: `没有这条记忆：${id}` }, 404); return; }
      // 能不能忘，取决于「你看不看得到」——看不到的东西不许忘，
      // 否则群会话可以按 id 试探并抹掉别处的条目。
      if (!this.ctx.canRead(target, reader, nowMs)) {
        sendJson({ ok: false, error: '没有这条记忆（或不在你可视范围内）' }, 403);
        return;
      }
      const r = this.ctx.forgetItem(store, id, { now: nowMs });
      if (!r.ok) {
        const why = r.reason === 'pinned'
          ? '这条是主人钉住的约定，不能忘；要改请用 remember 覆盖或让主人解除'
          : (r.reason === 'already-forgotten' ? '这条已经忘掉了' : '没有这条记忆');
        sendJson({ ok: false, error: why, reason: r.reason }, 409);
        return;
      }
      h.persistSharedMemoryState(store, { action: 'forget', key, detail: { id } });
      sendJson({ ok: true, key, action, id, status: r.item.status, recoverable: true });
      return;
    }
  } catch (error) {
    sendJson({ ok: false, error: `共享记忆操作失败：${error?.message ?? error}` }, 500);
  }
}

// GET 是 stats/read 的便捷形态，POST 是主用法；两条 if 原本不判 method，所以两个都登记。
export const shareRoutes = [
  { method: 'GET', path: '/api/socialV2/share-signal', kind: 'exact', handler: shareSignal },
  { method: 'POST', path: '/api/socialV2/share-signal', kind: 'exact', handler: shareSignal },
  { method: 'GET', path: '/api/socialV2/shared-memory', kind: 'exact', handler: sharedMemory },
  { method: 'POST', path: '/api/socialV2/shared-memory', kind: 'exact', handler: sharedMemory }
];

export default {
  name: 'share',
  title: '主动报告与跨会话记忆',
  inject: [
    'log', 'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled',
    'shareHelpers', 'shareStatsOf', 'normalizeSharePolicy', 'setSharePolicy', 'addSignal',
    'shareRejectReason', 'isGroupKey',
    'SHARE_HARD_MIN_INTERVAL_MS', 'SHARE_HARD_MAX_PER_DAY', 'SHARE_MAX_SIGNALS',
    'listItems', 'listGroupScopeForOwner', 'findSimilar', 'addItem', 'pruneStore',
    'canRead', 'forgetItem', 'sharedMemoryStats',
    'SHARED_MEMORY_MAX_ITEMS', 'SHARED_MEMORY_MAX_ARCHIVED'
  ],
  routes: shareRoutes
};