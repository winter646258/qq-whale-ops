// ── 记忆读写（/api/socialV2/memory*）──────────────────────────────────
//
// 阶段19。原先挂在 main() 的 if 链 L8027/L8044/L8110/L8136/L8162。
//
// 这是全套里最敏感的一族：她在这里改的是「自己记得什么」。
// 所以每条路由的鉴权是三层叠加的：
//   ① agentTokenOk(key, token)      —— 这个 key 的令牌对不对
//   ② v2SessionAllowed(key)         —— 这个会话在当前模式下允不允许出现
//   ③ v2ToolEnabled('memory')       —— 记忆工具开了没有
// 而 memory-update 还要额外过一道 v2ToolEnabled('memoryUpdate')：
// 它比 append 危险（会覆盖已有印象），必须能单独掐掉。
//
// 三个类别的语义别搞混：
//   activeTopic      当前在聊的话题，带 pendingQuestion / participants
//   pendingThought   想说还没说的念头，带 motivation / expiresAt（过期自动过滤）
//   memberImpression 对某个群友的印象，每次交互累加 interactionCount
//
// 印象是**单标签限 40 字、最多 20 条**。这里特意限长：原来只限条数，
// 于是长出过 144 字的「印象」——那是小作文，不是印象。
//
// memberImpressions 是个普通对象，键是群友名字。名字来自模型，所以
// __proto__ / constructor / prototype 必须显式拒绝，否则原型链污染。

const CATEGORIES = ['activeTopic', 'pendingThought', 'memberImpression'];
const BAD_NAMES = ['__proto__', 'constructor', 'prototype'];

function badCategory(category) {
  return !CATEGORIES.includes(category);
}

// 三层鉴权，返回 true 表示已经发出了拒绝响应
function rejectV2({ req, sendJson, key, tool = 'memory', what = 'qq_memory_*' }) {
  const ctx = this.ctx;
  const token = req.headers['x-agent-token'];
  if (!token) return false;
  if (!ctx.agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
  if (!ctx.v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
  if (!ctx.v2ToolEnabled(tool)) { sendJson({ ok: false, error: `工具未启用：${what}` }, 403); return true; }
  return false;
}

async function appendMemory({ req, sendJson, readBody }) {
  const ctx = this.ctx;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  const category = String(body.category ?? '').trim();
  const content = String(body.content ?? '').trim();
  const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
  if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
  if (badCategory(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
  if (category === 'memberImpression' && !String(extra.target || '').trim()) {
    sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400);
    return;
  }
  if (rejectV2.call(this, { req, sendJson, key, tool: 'memory', what: 'qq_memory_append' })) return;
  const st = ctx.getSocialV2State(key);
  ctx.appendMemoryV2(st, category, content, extra);
  sendJson({ ok: true, key, category, content, memory: ctx.formatMemoryV2(st) });
}

async function updateMemory({ req, sendJson, readBody }) {
  const ctx = this.ctx;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  const category = String(body.category ?? '').trim();
  const oldContent = String(body.oldContent ?? '').trim();
  const target = ctx.redactKnownTokensOnly(String(body.target ?? '').trim());
  const newContent = body.newContent !== undefined && body.newContent !== null
    ? ctx.redactKnownTokensOnly(String(body.newContent).trim())
    : undefined;
  const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
  const redactExtra = (v) => ctx.redactKnownTokensOnly(String(v ?? '')).trim();
  const cleanNewExtra = {
    ...newExtra,
    pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
    participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
    motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
    target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
  };
  if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
  if (badCategory(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
  if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
  if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
  if (rejectV2.call(this, { req, sendJson, key, tool: 'memory', what: 'qq_memory_*' })) return;
  // update 单独一个开关：它比 append 危险（会覆盖已有印象），要能单独掐掉。
  if (rejectV2.call(this, { req, sendJson, key, tool: 'memoryUpdate', what: 'qq_memory_update' })) return;

  const st = ctx.getSocialV2State(key);
  if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
    const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
    if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
    if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
    if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
    if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
  } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
    const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
    if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
    if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
    if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
    if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
  } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
    const oldTarget = target;
    if (BAD_NAMES.includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
    const im = st.memberImpressions[oldTarget] || {};
    const newTarget = String(cleanNewExtra.target || oldTarget).trim();
    if (!newTarget || BAD_NAMES.includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
    if (newContent !== undefined) {
      // 单标签限 40 字、最多 20 条 —— 印象不是小作文。
      im.traits = newContent.split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.slice(0, 40))
        .slice(0, 20);
    }
    if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
    if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
    st.memberImpressions[newTarget] = im;
    // 她真的动手重写了印象 ⇒ 重置维护计时（提醒随之消失）
    st.lastImpressionRefreshAt = Date.now();
  }
  ctx.saveSocialV2State();
  sendJson({ ok: true, key, category, memory: ctx.formatMemoryV2(st) });
}

async function queryMemory({ req, url, sendJson }) {
  const ctx = this.ctx;
  const key = String(url.searchParams.get('key') ?? '').trim();
  const category = String(url.searchParams.get('category') ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectV2.call(this, { req, sendJson, key, tool: 'memory', what: 'qq_memory_query' })) return;
  const st = ctx.getSocialV2State(key);
  const raw = {
    activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
    pendingThoughts: Array.isArray(st.pendingThoughts)
      ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20)
      : [],
    memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
  };
  if (category === 'activeTopic') {
    raw.pendingThoughts = [];
    raw.memberImpressions = {};
  } else if (category === 'pendingThought') {
    raw.activeTopics = [];
    raw.memberImpressions = {};
  } else if (category === 'memberImpression') {
    raw.activeTopics = [];
    raw.pendingThoughts = [];
  }
  sendJson({ ok: true, key, category, formatted: ctx.formatMemoryV2({ ...st, ...raw }), raw });
}

async function removeMemory({ req, sendJson, readBody }) {
  const ctx = this.ctx;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  const category = String(body.category ?? '').trim();
  const content = String(body.content ?? '').trim();
  const target = String(body.target ?? '').trim();
  if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
  if (badCategory(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
  if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
  if (category === 'memberImpression' && BAD_NAMES.includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
  if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
  if (rejectV2.call(this, { req, sendJson, key, tool: 'memory', what: 'qq_memory_remove' })) return;
  const st = ctx.getSocialV2State(key);
  if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
    st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
  } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
    st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
  } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
    delete st.memberImpressions[target];
  }
  ctx.saveSocialV2State();
  sendJson({ ok: true, key, category, memory: ctx.formatMemoryV2(st) });
}

async function clearMemory({ req, sendJson, readBody }) {
  const ctx = this.ctx;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  const category = String(body.category ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (category && badCategory(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
  if (rejectV2.call(this, { req, sendJson, key, tool: 'memory', what: 'qq_memory_clear' })) return;
  const st = ctx.getSocialV2State(key);
  if (!category || category === 'activeTopic') st.activeTopics = [];
  if (!category || category === 'pendingThought') st.pendingThoughts = [];
  if (!category || category === 'memberImpression') st.memberImpressions = {};
  ctx.saveSocialV2State();
  sendJson({ ok: true, key, category: category || 'all', memory: ctx.formatMemoryV2(st) });
}

const routes = [
  { method: 'POST', path: '/api/socialV2/memory-append', kind: 'exact', handler: appendMemory },
  { method: 'POST', path: '/api/socialV2/memory-update', kind: 'exact', handler: updateMemory },
  { method: 'GET', path: '/api/socialV2/memory', kind: 'exact', handler: queryMemory },
  { method: 'POST', path: '/api/socialV2/memory-remove', kind: 'exact', handler: removeMemory },
  { method: 'POST', path: '/api/socialV2/memory-clear', kind: 'exact', handler: clearMemory },
];

export default {
  name: 'memory',
  title: '记忆读写',
  inject: [
    'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled', 'redactKnownTokensOnly',
    'getSocialV2State', 'appendMemoryV2', 'formatMemoryV2', 'saveSocialV2State'
  ],
  routes,
};