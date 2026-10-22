// 线上真跑好感度注入（不启动桥接，只抽函数验证）
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync('/opt/qq-bridge/src/bridge.js', 'utf8');

function extractFn(source, name) {
  const re = new RegExp('\\n( *)function ' + name + '\\(');
  const m = re.exec(source);
  if (!m) throw new Error('找不到 ' + name);
  let i = source.indexOf('(', m.index);
  let d = 0;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(') d += 1;
    else if (c === ')') { d -= 1; if (!d) { i += 1; break; } }
  }
  let j = source.indexOf('{', i);
  let inStr = null;
  let prev = '';
  for (; j < source.length; j += 1) {
    const c = source[j];
    if (inStr) {
      if (c === inStr && prev !== '\\') inStr = null;
      prev = c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; prev = c; continue; }
    if (c === '/' && source[j + 1] === '/') {
      const nl = source.indexOf('\n', j);
      j = nl < 0 ? source.length : nl;
      prev = '';
      continue;
    }
    if (c === '{') d += 1;
    else if (c === '}') { d -= 1; if (!d) return source.slice(m.index + 1, j + 1); }
    prev = c;
  }
  throw new Error('花括号不配平 ' + name);
}

const storeSrc = fs.readFileSync('/opt/qq-bridge/src/affinity-store.js', 'utf8')
  .replace(/^export /gm, '')
  .replace(/^import [^\n]*\n/gm, '');

const shim = [
  "const fs = require('fs');",
  "const path = require('path');",
  storeSrc,
  "const STATE_DIR = '/opt/qq-bridge/state';",
  'const LOG = [];',
  'function log(m) { LOG.push(String(m)); }',
  "const cfg = JSON.parse(fs.readFileSync('/opt/qq-bridge/config.json', 'utf8'));",
  "const AFFINITY_FILE = path.join(STATE_DIR, 'affinity.json');",
  'let affinityCache = null;',
  ...['getAffinityState', 'saveAffinitySafe', 'affinityEntryFor', 'recordAffinityForKey', 'buildAffinityLineFor']
    .map((n) => extractFn(src, n)),
  'module.exports = { buildAffinityLineFor, recordAffinityForKey, LOG };'
].join('\n');

fs.writeFileSync('/tmp/afx.cjs', shim);
const H = require('/tmp/afx.cjs');

for (const key of ['private:1124721191', 'group:906710082', 'private:3414115838', 'group:910502749']) {
  const out = H.buildAffinityLineFor(key);
  console.log(`${key.padEnd(22)} → ${out ? JSON.stringify(out) : '(无注入)'}`);
}
console.log('log:', H.LOG);
