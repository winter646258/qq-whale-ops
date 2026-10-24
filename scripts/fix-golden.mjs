// 一次性脚本：让 golden-routes.mjs 也扫描 src/modules/**。
//
// 为什么必须改：模块化改造每做完一个阶段，都把老 if 链整段搬进模块，
// 而 golden-routes 只从 bridge.js 里正则抽 `url.pathname === '...'`。
// 搬一条少一条 —— 现在已经缩到 17 条，回归尺子基本失效。
// 模块路由表里写的是 `path: '/api/...'`，所以要一并抽，并且要把 modules 目录也读进来。

import fs from 'node:fs';

const p = process.argv[2];
if (!p) { console.error('usage: node fix-golden.mjs <scripts/golden-routes.mjs>'); process.exit(2); }
let t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// 1) 只读 bridge.js → 读 bridge.js + src/modules/** 全部 .js
const oldSrc = "const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');";
const newSrc = [
  '// 老 if 链（bridge.js）+ 模块路由表（src/modules/**）一起抽。',
  '// 只看 bridge.js 会漏掉已搬进模块的路由，快照会随阶段推进一路缩水。',
  'const src = [path.join(ROOT, \'src\', \'bridge.js\')]',
  '  .concat(walk(path.join(ROOT, \'src\', \'modules\')))',
  '  .map((f) => fs.readFileSync(f, \'utf8\'))',
  '  .join(\'\\n\');',
].join('\n');
if (!t.includes(oldSrc)) throw new Error('找不到 bridge.js 读取行');
t = t.replace(oldSrc, newSrc);

// 2) 在 routes 声明前加 walk()
const anchor = 'const routes = new Set();';
const walkFn = [
  'function walk(dir) {',
  '  const out = [];',
  '  let entries = [];',
  '  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }',
  '  for (const e of entries) {',
  '    const full = path.join(dir, e.name);',
  '    if (e.isDirectory()) out.push(...walk(full));',
  '    else if (e.name.endsWith(\'.js\')) out.push(full);',
  '  }',
  '  return out;',
  '}',
  'const routes = new Set();',
].join('\n');
if (!t.includes(anchor)) throw new Error('找不到 routes 声明');
t = t.replace(anchor, walkFn);

// 3) 追加两组抽取：route.path === '...' 与 path: '/api/...'
const oldAdd = "for (const m of src.matchAll(/url\\.pathname\\s*===\\s*'([^']+)'/g)) routes.add(m[1]);";
const newAdd = [
  oldAdd,
  '',
  '// 模块路由表里全是 `path: \'/api/...\'`（有些还配 kind），老 if 链搬走后只剩这一份，',
  '// 不抽就等于把已搬走的路由从回归里删掉。',
  "for (const m of src.matchAll(/\\bpath:\\s*'(\\/api\\/[^']+)'/g)) routes.add(m[1]);",
  "for (const m of src.matchAll(/\\broute(?:Match|s)?\\??\\.path\\s*===\\s*'(\\/api\\/[^']+)'/g)) routes.add(m[1]);",
].join('\n');
if (!t.includes(oldAdd)) throw new Error('找不到 url.pathname 抽取行');
t = t.replace(oldAdd, newAdd);

fs.writeFileSync(p, t);
console.log('golden-routes.mjs 已更新');
