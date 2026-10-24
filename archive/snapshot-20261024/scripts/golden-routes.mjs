import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = '/opt/qq-bridge';
const BASE = 'http://127.0.0.1:3100';

// 三种身份
const consoleTok = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
const convs = st.conversations || {};
const agentTok = convs['group:906710082']?.agentToken || '';

// 从源码抽出全部路由路径（复用 audit 思路），只为列清单，不判对错
// 老 if 链（bridge.js）+ 模块路由表（src/modules/**）一起抽。
// 只看 bridge.js 会漏掉已搬进模块的路由，快照会随阶段推进一路缩水。
// 只读 bridge.js 与 modules/：不能把 src/ 整个递归进去 —— mcp-snowluma-safe.js 里有
// 十几条 `agentApi('/api/socialV2/diary')` 这样的调用字符串，会被抽成根本不存在的路由，
// 快照里凭空多出一批 404「路由」（阶段27 实测多出 14 条）。
const srcFiles = [path.join(ROOT, 'src', 'bridge.js')].concat(walk(path.join(ROOT, 'src', 'modules')));
const src = srcFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const routes = new Set();
for (const m of src.matchAll(/url\.pathname\s*===\s*'([^']+)'/g)) routes.add(m[1]);

// 模块路由表里全是 `path: '/api/...'`（有些还配 kind），老 if 链搬走后只剩这一份，
// 不抽就等于把已搬走的路由从回归里删掉。
for (const m of src.matchAll(/\bpath:\s*'(\/api\/[^']+)'/g)) routes.add(m[1]);
for (const m of src.matchAll(/\broute(?:Match|s)?\??\.path\s*===\s*'(\/api\/[^']+)'/g)) routes.add(m[1]);
for (const m of src.matchAll(/url\.pathname\s*\.startsWith\(\s*'([^']+)'/g)) routes.add(m[1]);

// 模块化装载器新增的诊断端点：它由 registry 的模块路由承接，不在老 if 链里，
// 正则抽不出来。这里手工补上，否则改造后多出的路由不会被任何回归发现。
routes.add('/api/_modules');

const IDENTITIES = {
  anon: {},
  console: { 'x-console-token': consoleTok },
  agent: { 'x-console-token': consoleTok, 'x-agent-token': agentTok, 'x-agent-call': '1' },
};

// 只发 GET，避免任何写操作改变线上状态
async function probe(p, headers) {
  const url = BASE + p + (p.includes('?') ? '' : '?probe=1');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    const body = await r.text();
    let shape = null;
    try {
      const j = JSON.parse(body);
      shape = Array.isArray(j) ? `array[${j.length}]` : Object.keys(j).sort().join(',');
      var okv = j.ok;
    } catch { shape = 'text/' + body.slice(0, 40).replace(/\s+/g, ' '); }
    return { status: r.status, shape, ok: okv ?? null, len: body.length };
  } catch (e) {
    return { status: 0, shape: 'ERROR ' + String(e?.name ?? e), ok: null, len: 0 };
  } finally { clearTimeout(t); }
}

const list = [...routes].sort();
const out = { generatedAt: new Date().toISOString(), base: BASE, routes: {} };
for (const p of list) {
  const row = {};
  for (const [name, h] of Object.entries(IDENTITIES)) row[name] = await probe(p, h);
  out.routes[p] = row;
}
// 默认落 state/，可用 --out 指定。原来的写死 /tmp 在 systemd ProtectSystem 下
// 不是 safe 的落点，也容易被误以为「没生成」。
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx > 0 ? process.argv[outIdx + 1] : '/opt/qq-bridge/state/golden-routes.json';
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`已写 ${outPath}（${Object.keys(out.routes ?? {}).length} 条路由）`);
console.log('路由数', list.length);
for (const p of list) {
  const r = out.routes[p];
  console.log(
    p.padEnd(44),
    'anon', String(r.anon.status).padStart(3),
    'console', String(r.console.status).padStart(3),
    'agent', String(r.agent.status).padStart(3),
    '| 形状', r.console.shape?.slice(0, 50)
  );
}
