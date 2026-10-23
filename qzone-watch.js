#!/usr/bin/env node
/**
 * QQ 空间动态助手（读 + 通知 + 点赞 + 评论）
 *
 * 能力：
 *   - 读：定时拉取好友空间动态（get_qzone_feeds，只读）
 *   - 通知：发现新动态时私聊告知管理员
 *   - 点赞：like_qzone（低风险）
 *   - 评论：comment_qzone（高风险，强制限流）
 *
 * 安全设计（重要）：
 *   - 评论默认**关闭**，需显式开启 `qzone.comment.enabled = true`
 *   - 强制限流：每轮最多 1 条评论、每天最多 N 条、同一条说说永不重复评论
 *   - 评论前随机延迟 30~120 秒，避免机械节奏
 *   - 只用白名单好友（allow.private）为对象；自己的动态默认跳过互动
 *   - 评论内容由 AI 生成但强制短句 + 敏感词过滤 + 长度上限
 *   - 所有动作写日志，可追溯
 *
 * 用法：
 *   node qzone-watch.js              守护运行
 *   node qzone-watch.js --once       单次执行（遵守所有限流）
 *   node qzone-watch.js --list       只列出动态
 *   node qzone-watch.js --baseline   重建基线（把现有动态标记为已读）
 *   node qzone-watch.js --dry-run    单次执行但不真的点赞/评论
 *   node qzone-watch.js --limit      显示今日配额使用情况
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 脚本位于仓库根目录时 ROOT=__dirname；放到 src/ 时回退一级。
const ROOT = fs.existsSync(path.join(__dirname, 'config.json'))
  ? __dirname
  : path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'qzone-watch.json');
const ROLE_FILE = path.join(ROOT, 'roles', '小鲸鱼.md');
const LOG_FILE = '/var/log/qzone-watch.log';
const AD_APPID = 6600;

const DEFAULTS = {
  enabled: true,
  intervalMs: 10 * 60 * 1000,
  notify: true,
  allowOwn: false,          // 自己的动态是否也互动（默认否，避免自娱自乐）
  // 互动白名单：只有这些 QQ 发的动态才会被点赞/评论。
  // 留空 = 谁都不互动（fail-closed）。这是独立于桥接的 allow.private 的第二道闸门，
  // 因为"能聊天"不等于"该去他空间留言"。
  interactWith: [],
  like: {
    enabled: true,
    maxPerDay: 10,
  },
  comment: {
    enabled: false,          // ⚠️ 默认关闭
    maxPerDay: 3,
    maxPerRun: 1,
    delayMinMs: 30000,
    delayMaxMs: 120000,
    maxChars: 30,
    model: 'deepseek-chat',
  },
};

/**
 * 强制限流参数（多层）。
 *
 * QZone 走 HTTP 接口（不是注入真客户端），腾讯对自动化行为的风控比群聊严格得多，
 * 所以这里做的是**多层硬闸门**而不是单一每日上限：
 *
 *   1. 每次动作之间的最小间隔（跨轮次生效，防止连续几轮都命中）
 *   2. 每小时上限（防止某一小时集中爆发）
 *   3. 冷启动：启动后 N 分钟内完全不动作
 *   4. 活跃时段：只允许在指定小时区间动作（模拟真人作息）
 *   5. 随机跳过：即使全部条件满足，仍按概率放弃一部分动作
 *   6. 失败熔断：连续失败达阈值后，暂停一段时间不再尝试
 *
 * 任何一条不满足 ⇒ 本次不动作。宁可少做，不可触发风控。
 */
const LIMITS = {
  // 动作间隔（毫秒）
  minIntervalMs: 20 * 60 * 1000,      // 同一类动作至少间隔 20 分钟
  // 每小时上限
  maxPerHour: 3,
  // 冷启动保护：进程启动后多久内不做任何写操作
  warmupMs: 5 * 60 * 1000,            // 5 分钟
  // 活跃时段（本地时间小时，含首不含尾；跨夜写法如 [8, 24]）
  activeHours: [8, 24],               // 只在 08:00–24:00 动作
  // 随机跳过概率（0~1）
  skipProbability: 0.3,               // 30% 概率主动放弃，避免节奏过于规律
  // 失败熔断
  failureThreshold: 3,                // 连续失败 3 次
  cooldownMs: 60 * 60 * 1000,         // 熔断后冷却 1 小时
};

const argv = process.argv.slice(2);
const MODE = argv[0] || '';
const DRY = argv.includes('--dry-run') || MODE === '--dry-run';
const PROCESS_START = Date.now();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function loadJson(file, fallback) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch { return fallback; }
}

function loadConfig() { return loadJson(path.join(ROOT, 'config.json'), {}); }

function qzConfig() {
  const c = loadConfig();
  const q = c.qzone ?? {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    ...DEFAULTS,
    ...q,
    intervalMs: num(q.intervalMs, DEFAULTS.intervalMs),
    // 互动白名单统一转字符串，兼容配置里写数字或字符串
    interactWith: Array.isArray(q.interactWith) ? q.interactWith.map(String) : DEFAULTS.interactWith,
    like: { ...DEFAULTS.like, ...(q.like ?? {}), maxPerDay: num(q.like?.maxPerDay, DEFAULTS.like.maxPerDay) },
    comment: { ...DEFAULTS.comment, ...(q.comment ?? {}), maxPerDay: num(q.comment?.maxPerDay, DEFAULTS.comment.maxPerDay), maxPerRun: num(q.comment?.maxPerRun, DEFAULTS.comment.maxPerRun) },
  };
}

const EMPTY_STATE = {
  seen: {}, liked: {}, commented: {},
  day: '', likesToday: 0, commentsToday: 0,
  lastRunAt: 0,
  // 强制限流相关
  lastLikeAt: 0, lastCommentAt: 0,        // 上次动作时间（跨轮次生效）
  hourBuckets: {},                        // { "2026-10-19T14": 3 } 每小时计数
  failures: 0,                            // 连续失败次数
  cooldownUntil: 0,                       // 熔断冷却截止时间
  skippedByLimit: 0,                      // 被限流拦下的次数（统计用）
};
function loadState() { return { ...EMPTY_STATE, ...loadJson(STATE_FILE, {}) }; }

function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

function rollDay(s) {
  const today = new Date().toISOString().slice(0, 10);
  if (s.day !== today) { s.day = today; s.likesToday = 0; s.commentsToday = 0; }
  return s;
}

// ── 强制限流核心 ────────────────────────────────────────
function hourKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/**
 * 检查是否允许执行某个动作。返回 { ok, reason }。
 * reason 用于日志，方便排查"为什么没动"。
 */
function allowAction(kind, st, extra = {}) {
  const now = Date.now();
  const nowHour = new Date().getHours();
  // 测试开关：--test-gates 时跳过「冷启动保护」，以便在单次运行里验证后面几道闸门。
  // 这个开关**只影响冷启动一道**，其它限流一律照旧生效。
  const skipWarmup = extra.skipWarmup === true;

  // ① 熔断冷却
  if (st.cooldownUntil && now < st.cooldownUntil) {
    const left = Math.ceil((st.cooldownUntil - now) / 60000);
    return { ok: false, reason: `熔断冷却中，剩余 ${left} 分钟` };
  }

  // ② 冷启动保护
  if (!skipWarmup && now - PROCESS_START < LIMITS.warmupMs) {
    const left = Math.ceil((LIMITS.warmupMs - (now - PROCESS_START)) / 60000);
    return { ok: false, reason: `冷启动保护，还需 ${left} 分钟` };
  }

  // ③ 活跃时段
  const [hStart, hEnd] = LIMITS.activeHours;
  const inHours = hStart <= hEnd
    ? (nowHour >= hStart && nowHour < hEnd)
    : (nowHour >= hStart || nowHour < hEnd);   // 跨夜
  if (!inHours) {
    return { ok: false, reason: `非活跃时段（当前 ${nowHour} 时，允许 ${hStart}-${hEnd}）` };
  }

  // ④ 动作间隔
  const lastAt = kind === 'like' ? (st.lastLikeAt || 0) : (st.lastCommentAt || 0);
  if (lastAt && now - lastAt < LIMITS.minIntervalMs) {
    const left = Math.ceil((LIMITS.minIntervalMs - (now - lastAt)) / 60000);
    return { ok: false, reason: `${kind} 间隔不足，还需 ${left} 分钟` };
  }

  // ⑤ 每小时上限
  const hk = hourKey();
  const usedThisHour = Number(st.hourBuckets?.[hk] || 0);
  if (usedThisHour >= LIMITS.maxPerHour) {
    return { ok: false, reason: `本小时已达上限（${usedThisHour}/${LIMITS.maxPerHour}）` };
  }

  // ⑥ 随机跳过
  if (Math.random() < LIMITS.skipProbability) {
    return { ok: false, reason: `随机跳过（${Math.round(LIMITS.skipProbability * 100)}% 概率）` };
  }

  return { ok: true, reason: 'ok' };
}

/** 记录一次动作成功，推进限流水位 */
function markAction(kind, st) {
  const now = Date.now();
  const hk = hourKey();
  st.hourBuckets = st.hourBuckets || {};
  st.hourBuckets[hk] = Number(st.hourBuckets[hk] || 0) + 1;
  if (kind === 'like') st.lastLikeAt = now; else st.lastCommentAt = now;
  st.failures = 0;

  // 清理超过 7 天的小时桶
  const cutoff = Date.now() - 7 * 86400 * 1000;
  for (const k of Object.keys(st.hourBuckets)) {
    const parts = k.split('T');
    const t = new Date(parts[0] + 'T' + (parts[1] || '00') + ':00:00').getTime();
    if (Number.isFinite(t) && t < cutoff) delete st.hourBuckets[k];
  }
}

/** 记录一次动作失败，累计到阈值则熔断 */
function markFailure(kind, st) {
  st.failures = Number(st.failures || 0) + 1;
  if (st.failures >= LIMITS.failureThreshold) {
    st.cooldownUntil = Date.now() + LIMITS.cooldownMs;
    log(`⚠️ 连续失败 ${st.failures} 次，触发熔断：冷却 ${LIMITS.cooldownMs / 60000} 分钟`);
    st.failures = 0;
  }
}


async function onebot(action, params = {}) {
  const c = loadConfig();
  const httpUrl = String(c.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = c.snowluma?.accessToken || '';
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'ok') {
    throw new Error(`${action} 失败: ${body.wording || body.retcode || res.status}`);
  }
  return body.data;
}

function extractText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isRealFeed(f) {
  if (!f || typeof f !== 'object') return false;
  if (Number(f.appid) === AD_APPID) return false;
  if (!f.uin || Number(f.uin) === 0) return false;
  if (String(f.key || '').startsWith('advertisement')) return false;
  if (extractText(f.html).length < 8) return false;
  return true;
}

async function fetchFeeds(count = 20) {
  const data = await onebot('get_qzone_feeds', { page_num: 1, count });
  return (data && Array.isArray(data.feeds)) ? data.feeds : [];
}

function fmtTime(sec) {
  if (!sec) return '?';
  const d = new Date(Number(sec) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function notifyOwner(text) {
  const c = loadConfig();
  const owner = c.ownerQQ;
  if (!owner) { log('⚠️ 未配置 ownerQQ，跳过通知'); return false; }
  try {
    await onebot('send_private_msg', { user_id: Number(owner), message: [{ type: 'text', data: { text } }] });
    log(`✔ 已通知管理员 ${owner}`);
    return true;
  } catch (e) { log(`✖ 通知失败: ${e.message}`); return false; }
}

// ── 评论生成 ────────────────────────────────────────────
function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const t = fs.readFileSync('/root/.dsh/.env', 'utf8');
    const m = t.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  return '';
}

function readRoleCard(max = 1200) {
  try {
    const t = fs.readFileSync(ROLE_FILE, 'utf8');
    return t.slice(0, max);
  } catch { return ''; }
}

const FALLBACK_COMMENTS = ['好耶', '冲冲冲', '羡慕了', '有点东西', '顶一个', '看着不错', '来晚了'];

function cleanComment(raw, maxChars) {
  let s = String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 去掉模型偶尔加的自我说明前缀
  s = s.replace(/^(评论|回复|留言)[:：]\s*/, '');
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return s;
}

async function genComment(post, cfg) {
  const key = readApiKey();
  const text = post.text.slice(0, 300);
  if (key) {
    try {
      const role = readRoleCard();
      const sys = `${role}\n\n— — —\n现在你要在 QQ 空间给别人的说说写一条评论。要求：\n1. 只输出评论正文，不要引号、不要解释、不要「评论：」前缀；\n2. 极短，${cfg.maxChars} 字以内，像真人随手一评；\n3. 符合上面的人设语气，可以嘴硬、可以玩梗，但不要阴阳怪气攻击人；\n4. 不要提到自己是 AI。`;
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: `说说内容：${text}\n\n作者：${post.nick}` },
          ],
          max_tokens: 60,
          temperature: 1.1,
        }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await res.json().catch(() => ({}));
      const content = j?.choices?.[0]?.message?.content;
      if (content) {
        const c = cleanComment(content, cfg.maxChars);
        if (c) return { text: c, source: 'ai' };
      }
      log(`  ⚠️ AI 评论为空或失败: ${j?.error?.message || 'unknown'}`);
    } catch (e) {
      log(`  ⚠️ AI 评论请求异常: ${e.message}`);
    }
  }
  const pick = FALLBACK_COMMENTS[Math.floor(Math.random() * FALLBACK_COMMENTS.length)];
  return { text: pick, source: 'fallback' };
}

const SENSITIVE_RE = /(密码|验证码|身份证|银行卡|手机号|token|api[_ ]?key|sk-[a-z0-9]{16,})/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// ── 主流程 ──────────────────────────────────────────────
async function runOnce({ notify = true, dry = false, skipWarmup = false } = {}) {
  const cfg = qzConfig();
  const c = loadConfig();
  const ownUin = String(c.ownerQQ ?? '');
  const st = rollDay(loadState());
  const nowSec = Math.floor(Date.now() / 1000);

  let feeds;
  try { feeds = await fetchFeeds(20); }
  catch (e) { log(`✖ 拉取动态失败: ${e.message}`); return { ok: false, error: e.message }; }

  const real = feeds.filter(isRealFeed);
  log(`拉取 ${feeds.length} 条，有效 ${real.length} 条`);

  const fresh = real.filter((f) => !st.seen[String(f.key)]);
  const result = { ok: true, total: feeds.length, real: real.length, new: fresh.length, liked: 0, commented: 0, skipped: [] };

  // 1) 通知
  if (fresh.length && notify) {
    const lines = fresh.slice(0, 5).map((f, i) => `${i + 1}. ${f.nickname}（${fmtTime(f.time)}）\n   ${extractText(f.html).slice(0, 160)}`);
    await notifyOwner(`【空间动态】有 ${fresh.length} 条新动态：\n\n${lines.join('\n\n')}`);
  } else if (!fresh.length) {
    log('没有新动态');
  }

  // 2) 互动（只处理本轮的新动态，避免翻旧账）
  for (const f of fresh) {
    const key = String(f.key);
    const uin = String(f.uin);
    const isOwn = uin === ownUin;
    const label = `${f.nickname}(${uin}) ${fmtTime(f.time)}`;

    if (isOwn && !cfg.allowOwn) {
      result.skipped.push(`${key} own`);
      continue;
    }

    // 互动白名单：只有名单内的 QQ 才会被点赞/评论。
    // 这是独立于「通知」的一道闸门——动态仍然会通知你，但只有白名单的人才会被互动。
    // 白名单为空时谁都不互动（fail-closed），避免"刚装上就把所有好友刷一遍"。
    const allowInteract = new Set(cfg.interactWith || []);
    if (allowInteract.size === 0 || !allowInteract.has(uin)) {
      log(`  ⏭ 跳过互动 ${label}：不在互动白名单（${(cfg.interactWith || []).join(',') || '空'}）`);
      result.skipped.push(`${key} not-in-interact-list`);
      continue;
    }

    // 点赞
    if (cfg.like.enabled && !st.liked[key] && st.likesToday < cfg.like.maxPerDay) {
      const gate = allowAction('like', st, { skipWarmup });
      if (!gate.ok) {
        log(`  ⏸ 点赞被限流拦下（${label}）：${gate.reason}`);
        st.skippedByLimit = Number(st.skippedByLimit || 0) + 1;
        result.skipped.push(`like:${gate.reason}`);
      } else if (dry) {
        log(`  [dry] 会点赞: ${label}`);
      } else {
        try {
          await onebot('like_qzone', { tid: key, target_uin: Number(uin), abstime: Number(f.time) || 0 });
          st.liked[key] = nowSec;
          st.likesToday += 1;
          markAction('like', st);
          result.liked += 1;
          log(`  ✔ 已点赞: ${label}（今日 ${st.likesToday}/${cfg.like.maxPerDay}，本小时 ${st.hourBuckets[hourKey()]}/${LIMITS.maxPerHour}）`);
          await sleep(randInt(3000, 8000));
        } catch (e) {
          log(`  ✖ 点赞失败 ${label}: ${e.message}`);
          markFailure('like', st);
        }
      }
    }

    // 评论
    if (cfg.comment.enabled && !st.commented[key] && st.commentsToday < cfg.comment.maxPerDay && result.commented < cfg.comment.maxPerRun) {
      const gate = allowAction('comment', st, { skipWarmup });
      if (!gate.ok) {
        log(`  ⏸ 评论被限流拦下（${label}）：${gate.reason}`);
        st.skippedByLimit = Number(st.skippedByLimit || 0) + 1;
        result.skipped.push(`comment:${gate.reason}`);
        continue;
      }

      const post = { text: extractText(f.html), nick: String(f.nickname || '') };
      const { text: body, source } = await genComment(post, cfg.comment);
      if (!body) { log(`  ⚠️ 评论内容为空，跳过 ${label}`); continue; }
      if (SENSITIVE_RE.test(body)) { log(`  ⚠️ 评论命中敏感词，跳过: ${body}`); continue; }

      if (dry) { log(`  [dry] 会评论 ${label}: 「${body}」(${source})`); result.commented += 1; }
      else {
        const delay = randInt(cfg.comment.delayMinMs, cfg.comment.delayMaxMs);
        log(`  等待 ${Math.round(delay / 1000)}s 后评论 ${label}：「${body}」(${source})`);
        await sleep(delay);
        try {
          await onebot('comment_qzone', { tid: key, content: body, target_uin: Number(uin) });
          st.commented[key] = nowSec;
          st.commentsToday += 1;
          markAction('comment', st);
          result.commented += 1;
          log(`  ✔ 已评论: ${label}（今日 ${st.commentsToday}/${cfg.comment.maxPerDay}，本小时 ${st.hourBuckets[hourKey()]}/${LIMITS.maxPerHour}）`);
          await sleep(randInt(5000, 15000));
        } catch (e) {
          log(`  ✖ 评论失败 ${label}: ${e.message}`);
          markFailure('comment', st);
        }
      }
    }
  }

  // 3) 记录已见 + 清理
  // dry-run 不写任何状态：否则"试跑一次"就把动态全标记为已见，
  // 下一次真实运行就找不到新动态了（这个坑实测踩过）。
  if (!dry) {
    for (const f of real) st.seen[String(f.key)] = nowSec;
    const cutoff = nowSec - 90 * 86400;
    for (const bucket of ['seen', 'liked', 'commented']) {
      for (const [k, v] of Object.entries(st[bucket] || {})) {
        if (Number(v) && Number(v) < cutoff) delete st[bucket][k];
      }
    }
    st.lastRunAt = Date.now();
    saveState(st);
  }
  result.dry = dry;
  result.seenTotal = Object.keys(st.seen).length;
  result.likesToday = st.likesToday;
  result.commentsToday = st.commentsToday;
  return result;
}

// ── 入口 ────────────────────────────────────────────────
if (MODE === '--help' || MODE === '-h') {
  console.log(`QQ 空间动态助手

用法:
  node qzone-watch.js             守护运行
  node qzone-watch.js --once      单次执行
  node qzone-watch.js --dry-run   单次执行但不真的互动（也不写状态）
  node qzone-watch.js --list      只列出动态
  node qzone-watch.js --baseline  重建基线
  node qzone-watch.js --limit     查看配额与限流状态
  node qzone-watch.js --limits    查看强制限流参数
  node qzone-watch.js --interact  查看互动白名单

强制限流（代码内置，配置无法放宽）:
  ① 同动作最小间隔 20 分钟
  ② 每小时最多 3 次
  ③ 冷启动保护 5 分钟
  ④ 只在 08:00-24:00 动作
  ⑤ 30% 随机跳过
  ⑥ 连续失败 3 次 → 熔断 1 小时

配置（config.json 的 "qzone" 段）:
  enabled           总开关
  intervalMs        检查间隔（默认 600000 = 10 分钟）
  notify            新动态是否私聊通知（默认 true）
  allowOwn          是否也互动自己的动态（默认 false）
  like.enabled      点赞开关（默认 true）
  like.maxPerDay    每日点赞上限（默认 10）
  comment.enabled   评论开关（默认 false，需显式开启）
  comment.maxPerDay 每日评论上限（默认 3）
  comment.maxPerRun 每轮最多评论数（默认 1）
  comment.maxChars  评论长度上限（默认 30）`);
  process.exit(0);
}

if (MODE === '--list') {
  const real = (await fetchFeeds(20)).filter(isRealFeed);
  console.log(`有效动态 ${real.length} 条\n`);
  real.forEach((f, i) => {
    console.log(`[${i + 1}] ${f.nickname}(${f.uin}) ${fmtTime(f.time)}  key=${f.key}`);
    console.log(`    ${extractText(f.html).slice(0, 180)}\n`);
  });
  process.exit(0);
}

if (MODE === '--baseline') {
  const real = (await fetchFeeds(20)).filter(isRealFeed);
  const st = rollDay(loadState());
  let added = 0;
  for (const f of real) { const k = String(f.key); if (!st.seen[k]) { st.seen[k] = Math.floor(Date.now() / 1000); added++; } }
  st.lastRunAt = Date.now();
  saveState(st);
  log(`基线重建：拉取 ${real.length} 条，新增 ${added} 条，总计 ${Object.keys(st.seen).length} 条`);
  console.log(JSON.stringify({ feeds: real.length, added, total: Object.keys(st.seen).length }));
  process.exit(0);
}

if (MODE === '--limit') {
  const st = rollDay(loadState());
  const cfg = qzConfig();
  const now = Date.now();
  const hk = hourKey();
  const cooldownLeft = st.cooldownUntil && now < st.cooldownUntil
    ? Math.ceil((st.cooldownUntil - now) / 60000) + ' 分钟'
    : '无';
  console.log(JSON.stringify({
    日期: st.day,
    点赞: {
      开关: cfg.like.enabled,
      今日已用: st.likesToday, 今日上限: cfg.like.maxPerDay,
      本小时已用: Number(st.hourBuckets?.[hk] || 0), 本小时上限: LIMITS.maxPerHour,
      距上次: st.lastLikeAt ? Math.round((now - st.lastLikeAt) / 60000) + ' 分钟前' : '从未',
      最小间隔: LIMITS.minIntervalMs / 60000 + ' 分钟',
    },
    评论: {
      开关: cfg.comment.enabled,
      今日已用: st.commentsToday, 今日上限: cfg.comment.maxPerDay,
      每轮上限: cfg.comment.maxPerRun,
      距上次: st.lastCommentAt ? Math.round((now - st.lastCommentAt) / 60000) + ' 分钟前' : '从未',
    },
    熔断: {
      连续失败: st.failures, 阈值: LIMITS.failureThreshold,
      冷却剩余: cooldownLeft,
    },
    其他: {
      活跃时段: LIMITS.activeHours[0] + ':00-' + LIMITS.activeHours[1] + ':00',
      冷启动保护: LIMITS.warmupMs / 60000 + ' 分钟',
      随机跳过概率: LIMITS.skipProbability,
      被限流拦下次数: st.skippedByLimit || 0,
    },
    累计: {
      已记录动态: Object.keys(st.seen).length,
      已点赞: Object.keys(st.liked).length,
      已评论: Object.keys(st.commented).length,
    },
  }, null, 2));
  process.exit(0);
}

if (MODE === '--interact') {
  const cfg = qzConfig();
  const st = loadState();
  console.log('互动白名单（只有这些 QQ 的动态会被点赞/评论）:');
  if (!cfg.interactWith || cfg.interactWith.length === 0) {
    console.log('  （空）—— 当前不会互动任何人的动态');
  } else {
    for (const q of cfg.interactWith) {
      console.log(`  - ${q}   今日已赞 ${st.likesToday} / 已评 ${st.commentsToday}`);
    }
  }
  console.log();
  console.log('点赞开关:', cfg.like.enabled, `(${cfg.like.maxPerDay}/日)`);
  console.log('评论开关:', cfg.comment.enabled, `(${cfg.comment.maxPerDay}/日)`);
  process.exit(0);
}

if (MODE === '--limits') {
  const cfg = qzConfig();
  console.log(`强制限流参数（代码内置，不可通过配置放宽）

① 动作间隔     同一类动作至少间隔 ${LIMITS.minIntervalMs / 60000} 分钟
② 每小时上限   每小时最多 ${LIMITS.maxPerHour} 次
③ 冷启动保护   进程启动后 ${LIMITS.warmupMs / 60000} 分钟内不动作
④ 活跃时段     只在 ${LIMITS.activeHours[0]}:00 - ${LIMITS.activeHours[1]}:00 动作
⑤ 随机跳过     即使全部满足，仍 ${Math.round(LIMITS.skipProbability * 100)}% 概率放弃
⑥ 失败熔断     连续失败 ${LIMITS.failureThreshold} 次 → 冷却 ${LIMITS.cooldownMs / 60000} 分钟

叠加 config.json 的每日上限：
  点赞 ${cfg.like.maxPerDay}/日，评论 ${cfg.comment.maxPerDay}/日（每轮最多 ${cfg.comment.maxPerRun} 条）

任一条不满足 ⇒ 本次不动作。宁可少做，不可触发风控。`);
  process.exit(0);
}

if (MODE === '--once' || MODE === '--dry-run') {
  const st0 = loadState();
  const r = await runOnce({ notify: st0.lastRunAt > 0, dry: DRY, skipWarmup: argv.includes('--test-gates') });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

// 守护模式
const CFG0 = qzConfig();
log(`空间动态助手启动：间隔 ${CFG0.intervalMs / 60000} 分钟｜点赞=${CFG0.like.enabled ? '开' : '关'}(${CFG0.like.maxPerDay}/日)｜评论=${CFG0.comment.enabled ? '开' : '关'}(${CFG0.comment.maxPerDay}/日)`);

{
  const st = loadState();
  if (!st.lastRunAt) {
    log('首次运行：建立基线，不通知、不互动');
    try {
      const real = (await fetchFeeds(20)).filter(isRealFeed);
      const nowSec = Math.floor(Date.now() / 1000);
      for (const f of real) st.seen[String(f.key)] = nowSec;
      st.lastRunAt = Date.now();
      saveState(st);
      log(`基线已建立：${real.length} 条`);
    } catch (e) { log(`基线建立失败: ${e.message}`); }
  }
}

while (true) {
  try { await runOnce({ notify: CFG0.notify, dry: false }); }
  catch (e) { log(`检查异常: ${e.message}`); }
  await sleep(qzConfig().intervalMs);
}
