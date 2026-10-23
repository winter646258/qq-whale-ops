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
const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const routes = new Set();
for (const m of src.matchAll(/url\.pathname\s*===\s*'([^']+)'/g)) routes.add(m[1]);
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
fs.writeFileSync('/tmp/golden-routes.json', JSON.stringify(out, null, 1));
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
