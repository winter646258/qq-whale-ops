// 跨域检索：一次查完人格卡 / 黑话库 / 记忆条目 / 活动流。
//
// 为什么值得做：现有 122 条路由里没有任何跨域检索。主人排障时最常见的动作是
// 「我记得她说过这句话，在哪个角色卡 / 黑话里」——现在只能一个个页面翻。
//
// 为什么不做全文索引：`state/` 82 MB、nproc 2（评审 §3 F9）。建索引的常驻开销
// 抵不上收益，子串扫内存里已有的数组就够了。
//
// 三条硬约束：
//  1. **不返回私聊正文。** `private:数字` 会话的消息一律不参与检索，命中也不回正文。
//     这条在 `collectConversationHits` 里有显式断言，改代码时不要放宽。
//  2. 结果上限 40 条 / 64 KB，超了截断并标 `truncated`。
//  3. 只读、零子进程、零文件遍历（只读内存里已有的数组 + 一次活动流尾部）。
//
// 回退：`cfg.socialV2.modules.search === false` → 整个模块不装载。

const MAX_QUERY_LEN = 64;
const MIN_QUERY_LEN = 2;
const MAX_RESULTS = 40;
const MAX_BYTES = 64 * 1024;
const MAX_ACTIVITY_CHARS = 200_000;
const CONTEXT_CHARS = 40; // 命中片段前后各留多少字符

const SCOPES = ['all', 'role', 'slang', 'memory', 'activity'];

function isAgentCall(req) {
  if (req.headers['x-agent-call'] !== undefined) return true;
  return String(req.headers['x-agent-token'] ?? '') !== '';
}

function rejectConsoleOnly({ req, sendJson }) {
  if (!isAgentCall(req)) return false;
  sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
  return true;
}

// 取命中位置周围的一段，前后加省略号。`q` 已小写，`text` 原样返回（保留大小写给主人看）。
function snippet(text, q) {
  const lower = text.toLowerCase();
  const at = lower.indexOf(q);
  if (at < 0) return null;
  const start = Math.max(0, at - CONTEXT_CHARS);
  const end = Math.min(text.length, at + q.length + CONTEXT_CHARS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// 私聊会话键一律拒绝。这是评审 §5 S2 通过条件里那条「search 不泄露私聊正文」。
function isPrivateKey(key) {
  return String(key ?? '').startsWith('private:');
}

function searchModule() {
  return {
    name: 'search',
    title: '跨域检索',
    inject: ['cfg', 'log', 'fs', 'path', 'stateDir', 'readRoleState', 'roleSummaries', 'slangHelpers', 'getSocialV2State', 'readActivityTail', 'conversationKeys'],
    routes: [
      {
        method: 'GET',
        kind: 'exact',
        path: '/api/search',
        handler: async function search({ req, url, sendJson }) {
          if (rejectConsoleOnly({ req, sendJson })) return;

          const rawQ = String(url.searchParams.get('q') ?? '').trim();
          if (rawQ.length < MIN_QUERY_LEN || rawQ.length > MAX_QUERY_LEN) {
            sendJson({ ok: false, error: `q 长度必须是 ${MIN_QUERY_LEN}..${MAX_QUERY_LEN} 个字符` }, 400);
            return;
          }
          const scope = String(url.searchParams.get('scope') ?? 'all');
          if (!SCOPES.includes(scope)) {
            sendJson({ ok: false, error: `scope 只能是 ${SCOPES.join(' / ')}` }, 400);
            return;
          }
          const q = rawQ.toLowerCase();
          const wantAll = scope === 'all';
          const hits = [];
          const errors = [];
          const started = Date.now();

          const push = (scopeName, label, text, extra) => {
            if (hits.length >= MAX_RESULTS) return;
            const s = snippet(String(text ?? ''), q);
            if (!s) return;
            hits.push({ scope: scopeName, label, snippet: s, ...extra });
          };

          // ── 角色卡正文：直接读 roles/ 下的 md 文件（只读一次，不遍历目录以外的东西）
          if (wantAll || scope === 'role') {
            try {
              const fs = this.ctx.fs;
              const path = this.ctx.path;
              const rolesDir = path.join(this.ctx.stateDir, '..', 'roles');
              const list = this.ctx.roleSummaries?.() ?? [];
              for (const item of list) {
                if (hits.length >= MAX_RESULTS) break;
                const name = item?.name ?? item?.id;
                if (!name) continue;
                try {
                  const body = fs.readFileSync(path.join(rolesDir, `${name}.md`), 'utf8');
                  // 按行扫，命中行逐条报，比整篇只有一个命中位置有用得多
                  for (const line of body.split('\n')) {
                    if (hits.length >= MAX_RESULTS) break;
                    if (!line.toLowerCase().includes(q)) continue;
                    push('role', `角色卡 ${name}`, line.trim());
                  }
                } catch { /* 单个角色卡读不到就跳过 */ }
              }
            } catch (error) {
              errors.push(`role: ${error?.message || error}`);
            }
          }

          // ── 黑话库：`slangHelpers.entries()` 每次现取（该数组会被整体重新赋值）
          if (wantAll || scope === 'slang') {
            try {
              const entries = this.ctx.slangHelpers?.entries?.() ?? [];
              for (const e of entries) {
                if (hits.length >= MAX_RESULTS) break;
                const term = String(e?.term ?? e?.word ?? '');
                const meaning = String(e?.meaning ?? e?.desc ?? '');
                const evidence = Array.isArray(e?.evidence) ? e.evidence.join(' ') : '';
                const blob = [term, meaning, evidence].filter(Boolean).join(' ｜ ');
                if (!blob.toLowerCase().includes(q)) continue;
                push('slang', `黑话 ${term || '(无词条)'}`, blob, { status: e?.status ?? null });
              }
            } catch (error) {
              errors.push(`slang: ${error?.message || error}`);
            }
          }

          // ── 记忆条目：只扫非私聊会话；私聊键直接跳过（不读、不命中、不回正文）
          if (wantAll || scope === 'memory') {
            try {
              // 会话键的唯一来源：宿主交来的 `conversationKeys()`（内部是 socialV2.conversations 的键）。
              // 不要从 cfg.socialV2.conversations 推 —— 那是配置里的声明，运行时可能有额外会话。
              const keys = this.ctx.conversationKeys?.() ?? [];
              for (const key of keys) {
                if (hits.length >= MAX_RESULTS) break;
                if (isPrivateKey(key)) continue; // ← 红线：私聊不参与检索
                let st = null;
                try {
                  st = this.ctx.getSocialV2State?.(key);
                } catch {
                  continue;
                }
                if (!st) continue;
                const buckets = [
                  ['当前话题', st.activeTopics],
                  ['待办想法', st.pendingThoughts],
                ];
                for (const [label, arr] of buckets) {
                  if (hits.length >= MAX_RESULTS) break;
                  if (!Array.isArray(arr)) continue;
                  for (const item of arr) {
                    if (hits.length >= MAX_RESULTS) break;
                    const blob = [item?.text ?? item?.content ?? '', item?.pendingQuestion ?? '', item?.motivation ?? '']
                      .filter(Boolean)
                      .join(' ｜ ');
                    if (!blob.toLowerCase().includes(q)) continue;
                    push('memory', `${label} ${key}`, blob);
                  }
                }
                const impressions = st.memberImpressions;
                if (impressions && typeof impressions === 'object') {
                  for (const [who, im] of Object.entries(impressions)) {
                    if (hits.length >= MAX_RESULTS) break;
                    const blob = [who, ...(Array.isArray(im?.traits) ? im.traits : [])].join(' ｜ ');
                    if (!blob.toLowerCase().includes(q)) continue;
                    push('memory', `印象 ${key} / ${who}`, blob);
                  }
                }
              }
            } catch (error) {
              errors.push(`memory: ${error?.message || error}`);
            }
          }

          // ── 活动流：只读尾部一段（活动流本身只有 500 行）
          if (wantAll || scope === 'activity') {
            try {
              const raw = this.ctx.readActivityTail?.(MAX_ACTIVITY_CHARS) ?? '';
              for (const line of raw.split('\n')) {
                if (hits.length >= MAX_RESULTS) break;
                if (!line || !line.toLowerCase().includes(q)) continue;
                // 活动流里私聊会话只报「有这条」，不把正文吐出来
                if (/private:\d+/.test(line) && !/group:\d+/.test(line)) {
                  hits.push({ scope: 'activity', label: '活动流（私聊，正文隐去）', snippet: '[私聊内容不展示]' });
                  continue;
                }
                push('activity', '活动流', line);
              }
            } catch (error) {
              errors.push(`activity: ${error?.message || error}`);
            }
          }

          const payload = JSON.stringify({ ok: true, q: rawQ, scope, count: hits.length, hits });
          if (payload.length > MAX_BYTES) {
            sendJson({
              ok: true,
              q: rawQ,
              scope,
              count: hits.length,
              truncated: true,
              note: `结果超过 ${MAX_BYTES} 字节，已截断到前 ${Math.min(hits.length, 10)} 条`,
              hits: hits.slice(0, 10),
              errors,
              tookMs: Date.now() - started,
            });
            return;
          }
          sendJson({ ok: true, q: rawQ, scope, count: hits.length, truncated: false, hits, errors, tookMs: Date.now() - started });
        },
      },
    ],
  };
}

export default searchModule;
