// 统一面板：首屏健康卡 / 最近错误 / 能力矩阵。
//
// 设计依据：`docs/统一面板方案评审-2026-10-25.md` §4.3。
//
// 三条硬约束（写在最前面，改这个文件前先读一遍）：
//
//  1. **全部只读，且零子进程。** 不跑 `df`、不跑 `systemctl`、不递归扫 `state/`。
//     线上 nproc=2、available 只有 5xx MB，任何一次 `execSync` 都会和 QQ 收发抢 CPU。
//     内存与负载只用 `os.freemem/totalmem/loadavg`（纯内存读）。
//  2. **鉴权用 `rejectConsoleOnly`，不是 `rejectAi`。** 集中闸门（`src/bridge.js:5295-5423`）
//     已经在模块委派之前挡了一道，`src/bridge.js:5454` 的 agent 默认拒绝白名单又挡了第二道；
//     模块内这一道是「闸门表以后被改动」时的兜底，不是冗余 —— `src/modules/core/config.js`
//     头注释逐字讲过同一件事。
//  3. **每个接口都有硬上限。** 响应体超了要截断并标注 `truncated: true`，绝不把 82 MB 的
//     state 一次性吐给浏览器。
//
// 回退：`cfg.socialV2.modules.dashboard === false` → 整个模块不装载（见 `src/modules/index.js`）。
// 它和 `modules.enabled` 是两层开关：后者一刀切 28 个模块全停，前者只关这一个。

// 响应体上限（评审 §3 R4/R5 定的，超了就截断）
const MAX_ACTIVITY_CHARS = 200_000; // readActivityTail 的入参上限，别让它把整份活动流读进来
const MAX_ERRORS = 50; // `?limit=` 的硬顶
const MAX_ERROR_BYTES = 32 * 1024;
const MAX_ERROR_LINE = 400; // 单条错误最多保留这么多字符

// 活动流里"算错误"的信号。活动流是 appendActivity 写的，格式 `HH:MM:SS [source] text`。
// 只认这几种前缀/子串，不要放宽 —— 放宽了首屏每天都在报"错误"。
const ERROR_RE = /❌|失败|异常|出错|error|Error|ERROR|cannot|Cannot|undefined is not/;

// 与 `src/modules/core/shared.js` 同口径：判"这是不是智能体在调用"。
// 空串也算"带了 agent 标识"，所以用 `!== ''` 而不是 truthy 判断。
function isAgentCall(req) {
  if (req.headers['x-agent-call'] !== undefined) return true;
  return String(req.headers['x-agent-token'] ?? '') !== '';
}

// 模块内第二道闸门。返回 true 表示"已拒绝并已回包，调用方直接 return"。
function rejectConsoleOnly({ req, sendJson }) {
  if (!isAgentCall(req)) return false;
  sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
  return true;
}

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampText(text, maxBytes) {
  const s = String(text ?? '');
  if (s.length <= maxBytes) return { text: s, truncated: false };
  return { text: `${s.slice(0, maxBytes)}\n…（已截断，原始 ${s.length} 字符）`, truncated: true };
}

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天${h}小时${m}分`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

// 从活动流尾部按错误特征抽行。
// 活动流是 `createCappedLogger(…, 500)` 的产物，只留最近 500 行 —— 所以 `limit` 上限 50，
// 不假装能做任意时间范围查询（评审 §6）。
function extractErrors(raw, limit) {
  const lines = String(raw ?? '').split('\n');
  const hits = [];
  for (let i = lines.length - 1; i >= 0 && hits.length < limit; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (!ERROR_RE.test(line)) continue;
    hits.push(line.length > MAX_ERROR_LINE ? `${line.slice(0, MAX_ERROR_LINE)}…` : line);
  }
  return hits.reverse(); // 时间正序，方便前端直接铺开
}

const dashboardModule = {
  name: 'dashboard',
  title: '统一面板（只读首屏）',
  // `dshReady` / `currentMode` 是 `let`，必须由宿主交访问器（见 bridge.js 的注入块注释）。
  inject: ['cfg', 'log', 'os', 'fs', 'path', 'stateDir', 'dshReady', 'currentMode', 'readActivityTail', 'readRoleState', 'snowlumaHealthSnapshot', 'appStartedAt', 'getSocialV2State', 'atomicWriteJson'],
  routes: [
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/dashboard/overview',
      handler: async function overview({ req, sendJson }) {
        if (rejectConsoleOnly({ req, sendJson })) return;
        const { os, cfg } = this.ctx;
        let mem = null;
        let load = null;
        let uptimeMs = null;
        try {
          const total = os.totalmem();
          const free = os.freemem();
          mem = {
            totalMb: Math.round(total / 1048576),
            freeMb: Math.round(free / 1048576),
            usedMb: Math.round((total - free) / 1048576),
            usedPct: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : null,
          };
          const [l1, l5, l15] = os.loadavg();
          load = { cpus: os.cpus()?.length ?? null, l1, l5, l15 };
          uptimeMs = Math.max(0, Date.now() - Number(this.ctx.appStartedAt || Date.now()));
        } catch (error) {
          this.ctx.log('[dashboard] overview 读取系统信息失败：', error?.message || error);
        }
        // DSH 真通没通：`dshReady` 是 `checkDsh()` 每 5 s 探测 `api.settings.describe` 的结果，
        // 已经是最新值，别在这里再探一次（再探一次就是每秒两次请求打到 3081）。
        let dshReady = null;
        try {
          dshReady = Boolean(this.ctx.dshReady());
        } catch { /* 访问器拿不到就保持 null，前端显示"未知" */ }
        let mode = null;
        try {
          mode = this.ctx.currentMode() ?? null;
        } catch { /* 同上 */ }

        // 行为开关摘要：只给"开/关"，不给完整对象 —— 完整配置走 /api/socialV2/config。
        const sv2 = cfg?.socialV2 ?? {};
        const flags = {
          socialV2Enabled: sv2.enabled !== false,
          paused: sv2.paused === true,
          modulesEnabled: sv2.modules?.enabled !== false,
          turnBudget: sv2.turnBudget ?? null,
          proactiveEnabled: sv2.proactive?.enabled !== false,
        };

        // 卡住审批的条数（首屏必须显示，卡住 = 她不回复，会让人以为她挂了）
        let pendingApprovals = null;
        try {
          const pending = this.ctx.getSocialV2State?.('__pending__');
          void pending; // 审批不在 socialV2 里，这一项留给前端调 /api/pending
        } catch { /* 忽略 */ }

        const body = {
          ok: true,
          pid: process.pid,
          startedAt: this.ctx.appStartedAt ?? null,
          uptimeMs,
          uptimeText: uptimeMs === null ? null : formatUptime(uptimeMs),
          mem,
          load,
          dshReady,
          mode,
          flags,
          pendingApprovals,
          now: Date.now(),
        };
        const payload = JSON.stringify(body);
        if (payload.length > 4096) {
          sendJson({ ok: true, truncated: true, size: payload.length, mem, load, dshReady, mode, flags }, 200);
          return;
        }
        sendJson(body);
      },
    },
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/dashboard/errors',
      handler: async function errors({ req, url, sendJson }) {
        if (rejectConsoleOnly({ req, sendJson })) return;
        const limit = toInt(url.searchParams.get('limit'), 20, 1, MAX_ERRORS);
        let raw = '';
        try {
          raw = this.ctx.readActivityTail(MAX_ACTIVITY_CHARS) ?? '';
        } catch (error) {
          this.ctx.log('[dashboard] errors 读取活动流失败：', error?.message || error);
          sendJson({ ok: false, error: '读取活动流失败' }, 500);
          return;
        }
        const lines = extractErrors(raw, limit);
        const { text, truncated } = clampText(lines.join('\n'), MAX_ERROR_BYTES);
        sendJson({
          ok: true,
          count: lines.length,
          limit,
          truncated,
          errors: truncated ? text.split('\n') : lines,
        });
      },
    },
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/dashboard/links',
      handler: async function links({ req, sendJson }) {
        if (rejectConsoleOnly({ req, sendJson })) return;
        const tools = this.ctx.cfg?.socialV2?.tools ?? {};
        // 38 个能力 flag（`toolFlags` 数组在注册期过滤，这里只读当前 cfg 的值）。
        const names = Object.keys(tools).sort();
        const enabled = [];
        const disabled = [];
        for (const name of names) {
          (tools[name] === false ? disabled : enabled).push(name);
        }
        // 角色与人格状态（只是指针，正文走 /api/roles/content）
        let role = null;
        try {
          const st = this.ctx.readRoleState?.();
          role = { name: st?.role ?? null, mode: st?.mode ?? null };
        } catch { /* 忽略 */ }
        let snowluma = null;
        try {
          snowluma = this.ctx.snowlumaHealthSnapshot?.() ?? null;
        } catch { /* 忽略 */ }
        sendJson({
          ok: true,
          tools: {
            total: names.length,
            enabled,
            disabled,
            flags: tools,
          },
          role,
          snowluma,
        });
      },
    },
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/dashboard/check',
      handler: async function check({ req, sendJson }) {
        if (rejectConsoleOnly({ req, sendJson })) return;
        // 逐项自检。**每项都有超时，总预算 5 秒**（评审 §5 S2 通过条件）：
        // 面板是排障时看的东西，自检本身绝不能把一个挂掉的下游拖成 30 秒白屏。
        // 每项只读已有状态，唯一"真探测"的是 DSH —— 复用 `dshReady()` 的结论，
        // 不再额外打 3081（checkDsh 已经每 5 s 探一次）。
        const PER_ITEM_MS = 1500;
        const TOTAL_MS = 5000;
        const deadline = Date.now() + TOTAL_MS;

        const withTimeout = (fn, name) => new Promise((resolve) => {
          const budget = Math.max(0, Math.min(PER_ITEM_MS, deadline - Date.now()));
          let settled = false;
          const done = (ok, detail, extra) => {
            if (settled) return;
            settled = true;
            resolve({ name, ok, detail, ...extra });
          };
          const timer = setTimeout(() => done(false, 'timeout'), budget);
          const started = Date.now();
          Promise.resolve()
            .then(() => fn())
            .then((result) => {
              clearTimeout(timer);
              const r = result || {};
              done(r.ok !== false, r.detail ?? '', { ms: Date.now() - started });
            })
            .catch((error) => {
              clearTimeout(timer);
              done(false, String(error?.message || error).slice(0, 200), { ms: Date.now() - started });
            });
        });

        const items = [];

        // 1. 进程自身
        items.push(await withTimeout(() => {
          const up = Math.max(0, Date.now() - Number(this.ctx.appStartedAt || Date.now()));
          return { ok: true, detail: `pid ${process.pid}，已跑 ${formatUptime(up)}` };
        }, 'service'));

        // 2. 内存与负载（纯内存读，永远成功；但有阈值判定）
        items.push(await withTimeout(() => {
          const os = this.ctx.os;
          const total = os.totalmem();
          const free = os.freemem();
          const usedPct = total > 0 ? ((total - free) / total) * 100 : 0;
          const l1 = os.loadavg()[0];
          const cpus = os.cpus()?.length || 1;
          // 阈值：内存 >92% 或负载 > 核数×4 才算异常。
          // 为什么是 ×4 而不是 ×2：这台机器只有 2 核，重启瞬间（模块装载 + DSH 起 +
          // SNOWLUMA 握手）实测 load1 到过 4.55，×2（=4.0）会天天误报。
          // 另外启动 90 秒内一律不判异常 —— 那段时间的负载和内存都不是稳态。
          const up = Math.max(0, Date.now() - Number(this.ctx.appStartedAt || Date.now()));
          const warm = up < 90000;
          const ok = warm || (usedPct < 92 && l1 < cpus * 4);
          return {
            ok,
            detail: `内存 ${Math.round(usedPct)}% · 负载 ${l1.toFixed(2)}/${cpus} 核` + (warm ? '（启动中，未判定）' : ''),
          };
        }, 'resources'));

        // 3. DSH 是不是真通了
        items.push(await withTimeout(() => {
          const ready = this.ctx.dshReady();
          // 启动 90 秒内 DSH 可能还没完成首轮探测（实测要 15 秒才就绪），
          // 这段时间报红是假警报，标成「启动中」不算失败。
          const up = Math.max(0, Date.now() - Number(this.ctx.appStartedAt || Date.now()));
          if (ready !== true && up < 90000) {
            return { ok: true, detail: `启动中，等 DSH 首次探测（已 ${Math.round(up / 1000)} 秒）` };
          }
          return {
            ok: ready === true,
            detail: ready === true ? '设置接口可达' : 'DSH 不可达（她无法处理消息）',
          };
        }, 'dsh'));

        // 4. SnowLuma / OneBot 链路
        items.push(await withTimeout(() => {
          const sl = this.ctx.snowlumaHealthSnapshot?.() || null;
          // 启动 90 秒宽容：WS 握手 + QQ 登录态确认都需要时间，此时 connected=false 属正常。
          const up = Math.max(0, Date.now() - Number(this.ctx.appStartedAt || Date.now()));
          if (up < 90000 && (!sl || typeof sl !== 'object' || sl.connected === false)) {
            return { ok: true, detail: `启动中，等 WS 握手（已 ${Math.round(up / 1000)} 秒）` };
          }
          if (!sl || typeof sl !== 'object') return { ok: false, detail: '未上报健康数据' };
          if (sl.connected === false) return { ok: false, detail: 'WebSocket 未连接（收不到群消息）' };
          if (sl.accountOnline === false) return { ok: false, detail: 'QQ 账号已离线（需重新登录）' };
          const idle = Number(sl.lastPacketAgoMs);
          // 超 10 分钟没包 = 上游活着但事件流断了（今天 09:43 就出过这个）
          if (Number.isFinite(idle) && idle > 600000) {
            return { ok: false, detail: `已 ${Math.round(idle / 60000)} 分钟没收到任何事件` };
          }
          return { ok: true, detail: `已连接 · 最近事件 ${Number.isFinite(idle) ? Math.round(idle / 1000) + ' 秒前' : '未知'}` };
        }, 'snowluma'));

        // 5. 模块装载
        items.push(await withTimeout(() => {
          const cfg = this.ctx.cfg;
          const on = cfg?.socialV2?.modules?.enabled !== false;
          return { ok: on, detail: on ? '模块化已启用' : '模块化已关闭（走老路由）' };
        }, 'modules'));

        // 6. 角色卡
        items.push(await withTimeout(() => {
          const st = this.ctx.readRoleState?.();
          const role = st?.role ?? null;
          return { ok: Boolean(role), detail: role ? `当前角色 ${role}` : '没有激活角色' };
        }, 'role'));

        const failed = items.filter((x) => !x.ok);
        sendJson({
          ok: failed.length === 0,
          checkedAt: Date.now(),
          totalMs: TOTAL_MS - Math.max(0, deadline - Date.now()),
          items,
          failed: failed.map((x) => x.name),
        });
      },
    },
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/dashboard/storage',
      handler: async function storage({ req, sendJson }) {
        if (rejectConsoleOnly({ req, sendJson })) return;
        // 只数 state/ 顶层，**绝不递归**（递归统计会和 QQ 收发抢 CPU）。
        // 实测 2026-10-25：顶层 99 文件 / 约 17 MB；评审文档写的 82MB 是含 state/images 等子目录的全量值。
        const fs = this.ctx.fs;
        const path = this.ctx.path;
        const stateDir = this.ctx.stateDir;
        let fileCount = 0;
        let totalBytes = 0;
        let biggest = null;
        let dirCount = 0;
        let error = null;
        try {
          const names = fs.readdirSync(stateDir);
          for (const name of names) {
            let st = null;
            try {
              st = fs.statSync(path.join(stateDir, name));
            } catch {
              continue; // 竞态删掉的跳过
            }
            if (st.isDirectory()) {
              dirCount += 1;
              continue;
            }
            fileCount += 1;
            totalBytes += st.size;
            if (!biggest || st.size > biggest.size) biggest = { name, size: st.size };
          }
        } catch (err) {
          error = String(err?.message || err).slice(0, 200);
        }
        // config.json 单独报一下（它是要害文件，坏了整个服务起不来）
        let configBytes = null;
        try {
          configBytes = fs.statSync(path.join(path.dirname(stateDir), 'config.json')).size;
        } catch { /* 读不到就算了 */ }
        sendJson({
          ok: !error,
          error,
          note: '只统计 state/ 顶层，不递归',
          stateDir: {
            files: fileCount,
            dirs: dirCount,
            totalBytes,
            totalMb: Math.round((totalBytes / 1048576) * 10) / 10,
            biggest,
          },
          configBytes,
        });
      },
    },
    {
      // S3：运行备注。单一写者（只从控制台点），不需要跨进程锁。
      // 存 state/dashboard-note.json，复用 atomicWriteJson（tmp + rename）。
      method: 'GET',
      kind: 'exact',
      path: '/api/dashboard/note',
      handler: async function getNote({ req, sendJson }) {
        if (rejectConsoleOnly({ req, sendJson })) return;
        const fs = this.ctx.fs;
        const path = this.ctx.path;
        const file = path.join(this.ctx.stateDir, 'dashboard-note.json');
        let note = '';
        let updatedAt = null;
        let updatedBy = null;
        try {
          const raw = fs.readFileSync(file, 'utf8');
          const parsed = JSON.parse(raw);
          note = typeof parsed?.note === 'string' ? parsed.note : '';
          updatedAt = Number.isFinite(parsed?.updatedAt) ? parsed.updatedAt : null;
          updatedBy = typeof parsed?.updatedBy === 'string' ? parsed.updatedBy : null;
        } catch { /* 没有备注文件就是空备注，不是错误 */ }
        sendJson({ ok: true, note, updatedAt, updatedBy });
      },
    },
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/dashboard/note',
      handler: async function setNote({ req, sendJson, readBody }) {
        if (rejectConsoleOnly({ req, sendJson })) return;
        const MAX_NOTE = 2000;
        let body = {};
        try {
          body = (await readBody()) ?? {};
        } catch {
          sendJson({ ok: false, error: '请求体不是合法 JSON' }, 400);
          return;
        }
        const raw = body?.note;
        if (raw !== undefined && raw !== null && typeof raw !== 'string') {
          sendJson({ ok: false, error: 'note 必须是字符串' }, 400);
          return;
        }
        const note = String(raw ?? '').trim();
        if (note.length > MAX_NOTE) {
          sendJson({ ok: false, error: `备注最多 ${MAX_NOTE} 字（现在 ${note.length} 字）` }, 400);
          return;
        }
        const payload = {
          note,
          updatedAt: Date.now(),
          updatedBy: 'console',
        };
        try {
          this.ctx.atomicWriteJson(this.ctx.path.join(this.ctx.stateDir, 'dashboard-note.json'), payload);
        } catch (error) {
          sendJson({ ok: false, error: `写入失败：${String(error?.message || error).slice(0, 200)}` }, 500);
          return;
        }
        this.ctx.log(`[dashboard] 运行备注已更新（${note.length} 字）`);
        sendJson({ ok: true, ...payload });
      },
    },
  ],
};

export default dashboardModule;
