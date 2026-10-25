// ── 仿真群友模式（旧社交引擎）配置与手动状态（/api/social*）────────────
//
// 阶段18。原先挂在 main() 的 if 链：
//   POST /api/social/state   L5218（手动把某个会话切成 active / idle）
//   GET  /api/social         L5238
//   POST /api/social         L5252（写 config.json 的 social 段 + 热更新）
//   POST /api/social/flush   L5310（把攒着的摘要立刻落盘）
//
// 这一族全是控制台动作，智能体一律 403。
//
// POST /api/social 的那堆字段处理看着啰嗦，但每条都在挡真实事故，别简化：
//   · 旧字段 (burstProbability / followUp*) 在新分句逻辑里已废弃 —— 保存时删；
//   · 数值字段只在「给的是有限非负数」时才写，非法值直接丢弃（不报错、不清零）；
//   · 概率 clamp 到 0~1、contextWindow 限 1~100、min/max 成对保证 min<=max。
// 读 config 仍然 fail-fast：文件损坏就 500，绝不回写。
//
// 注意 ctx.social 是**函数**（() => social），不是对象：对象本身在 L9482 才声明，
// 而注入点在 L4157，直接交值会 TDZ。

function rejectAgent({ req, sendJson }) {
  if (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '') {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  return false;
}

const NUMERIC_FIELDS = [
  'triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs',
  'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs',
  'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs',
  'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow',
  'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs'
];
const PROBABILITY_FIELDS = [
  'triggerProbability', 'idleRetryProbability', 'proactiveProbability',
  'skipProbability', 'surrenderProbability', 'longGapProbability'
];
const BOOLEAN_FIELDS = ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled'];
const RANGE_PAIRS = [
  ['activeCheckMinMs', 'activeCheckMaxMs'],
  ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'],
  ['activeDurationMinMs', 'activeDurationMaxMs'],
  ['proactiveCheckMinMs', 'proactiveCheckMaxMs'],
  ['burstIntervalMinMs', 'burstIntervalMaxMs'],
  ['longGapMinMs', 'longGapMaxMs']
];
const LEGACY_FIELDS = [
  'burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability',
  'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs'
];

function sanitizeSocial(body, file) {
  const merged = { ...(file.social ?? {}), ...body };
  for (const k of LEGACY_FIELDS) delete merged[k];
  for (const k of NUMERIC_FIELDS) {
    if (merged[k] === undefined) continue;
    const n = Number(merged[k]);
    if (Number.isFinite(n) && n >= 0) merged[k] = n;
  }
  for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
    if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
  }
  for (const k of PROBABILITY_FIELDS) {
    if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
  }
  if (merged.contextWindow !== undefined) {
    merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
  }
  for (const k of BOOLEAN_FIELDS) {
    if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
  }
  for (const [minK, maxK] of RANGE_PAIRS) {
    if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
      [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
    }
  }
  if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
  return merged;
}

async function getSocial({ req, sendJson }) {
  const { cfg } = this.ctx;
  const social = this.ctx.social();
  if (rejectAgent({ req, sendJson })) return;
  const stats = {};
  for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
  const states = {};
  const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
  for (const k of keys) states[k] = { phase: social.states.get(k)?.phase ?? 'idle' };
  sendJson({ config: cfg.social, pendingSummaries: stats, states });
}

async function postSocial({ req, sendJson, readBody }) {
  const { cfg, log, path, rootDir, readConfigObject, atomicWriteJson } = this.ctx;
  if (rejectAgent({ req, sendJson })) return;
  const body = (await readBody()) ?? {};
  const configFile = path.join(rootDir, 'config.json');
  const file = readConfigObject(configFile);
  const merged = sanitizeSocial(body, file);
  file.social = merged;
  atomicWriteJson(configFile, file);
  cfg.social = { ...cfg.social, ...merged };
  log('控制台：社交配置已更新');
  sendJson({ ok: true, config: cfg.social });
}

async function postSocialFlush({ req, sendJson, readBody }) {
  const { socialHelpers: h } = this.ctx;
  if (rejectAgent({ req, sendJson })) return;
  const body = (await readBody()) ?? {};
  await h.flushSummaries(body.key || null);
  sendJson({ ok: true });
}

async function postSocialState({ req, sendJson, readBody }) {
  const { log, socialHelpers: h } = this.ctx;
  if (rejectAgent({ req, sendJson })) return;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  const phase = body.phase;
  if (phase === 'active') {
    h.enterActive(key);
    log(`控制台：手动将 ${key} 设为活跃`);
    sendJson({ ok: true, key, phase: 'active' });
  } else if (phase === 'idle') {
    h.leaveActive(key);
    log(`控制台：手动将 ${key} 设为观望`);
    sendJson({ ok: true, key, phase: 'idle' });
  } else {
    sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
  }
}

const routes = [
  { method: 'GET', path: '/api/social', kind: 'exact', handler: getSocial },
  { method: 'POST', path: '/api/social', kind: 'exact', handler: postSocial },
  { method: 'POST', path: '/api/social/flush', kind: 'exact', handler: postSocialFlush },
  { method: 'POST', path: '/api/social/state', kind: 'exact', handler: postSocialState },
];

export default {
  name: 'social',
  title: '仿真群友模式配置',
  inject: ['cfg', 'log', 'path', 'rootDir', 'social', 'readConfigObject', 'atomicWriteJson', 'socialHelpers'],
  routes,
};