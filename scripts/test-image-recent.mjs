// 生图产物登记 + action:"recent" 的回归守卫。
//
// 起因（2026-10-28 18:25）：异步生图之后工具只回 jobId，她拿不到路径，
// 配说说时只能翻出 10-26 的旧图 —— 她的原话是「图那边又空手回来了 一张都没落地」。
// 这个用例钉四件事：
//   ① bridge 里真有登记器，并且真的按「新的在前、同路径去重、最多 50 条」记账；
//   ② 登记器挂进了 imageHelpers（模块才调得到）；
//   ③ 画完就记一笔（在发图之前，发失败也算画成了）；
//   ④ 模块有 action:"recent"，而且排在额度判断之前（额度用完也能查自己画过什么）；
//   ⑤ MCP 的 qq_generate_image 能把 action 传下来。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
const genSrc = fs.readFileSync(path.join(root, 'src/modules/image/generate.js'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ---------- ① 抠出登记器，放进带假文件系统的沙箱跑 ----------
const start = bridgeSrc.indexOf('// MARKER: image-registry');
const end = bridgeSrc.indexOf('async function generateImageNow({ prompt, size }) {', start);
ok('bridge 里有登记器 MARKER', start > 0);
ok('登记器在 generateImageNow 之前', end > start);

const block = start > 0 && end > start ? bridgeSrc.slice(start, end) : '';

function makeSandbox() {
  const disk = new Map();
  const logs = [];
  const sandbox = {
    path: { join: (...parts) => parts.filter(Boolean).join('/'), basename: (p) => String(p ?? '').split('/').pop() },
    STATE_DIR: '/state',
    fs: {
      readFileSync: (p) => {
        if (!disk.has(p)) throw new Error('ENOENT');
        return disk.get(p);
      },
      writeFileSync: (p, text) => { disk.set(p, String(text)); }
    },
    atomicWriteJson: (p, value) => { disk.set(p, JSON.stringify(value)); },
    log: (m) => logs.push(String(m)),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${block}\n;__record = recordGeneratedImage;__recent = recentGeneratedImages;__keep = GENERATED_IMAGES_KEEP;__file = GENERATED_IMAGES_FILE;`, sandbox);
  return { sandbox, disk, logs };
}

console.log('[登记器 · 真逻辑]');
{
  const { sandbox, disk } = makeSandbox();
  ok('留 50 条', sandbox.__keep === 50);
  ok('登记文件在 state 下', String(sandbox.__file).endsWith('/generated-images.json'));

  sandbox.__record({ path: '/img/a.png', prompt: 'A', key: 'private:1', at: 1000 });
  sandbox.__record({ path: '/img/b.png', prompt: 'B', key: 'private:1', at: 2000 });
  let list = sandbox.__recent(5);
  ok('新的排前面', list[0].path === '/img/b.png' && list[1].path === '/img/a.png');
  ok('带 file 名', list[0].file === 'b.png');
  ok('空 path 不记', sandbox.__record({ path: '' }) === null);

  sandbox.__record({ path: '/img/a.png', prompt: 'A2', key: 'private:2', at: 3000 });
  list = sandbox.__recent(5);
  ok('同路径去重（不重复登记）', list.filter((x) => x.path === '/img/a.png').length === 1, JSON.stringify(list.map((x) => x.path)));
  ok('去重后位置更新到最前', list[0].path === '/img/a.png' && list[0].prompt === 'A2');

  for (let i = 0; i < 60; i += 1) sandbox.__record({ path: `/img/n${i}.png`, prompt: 'x', at: 4000 + i });
  // recent 自己会把条数夹到 20，所以「文件里留 50 条」要从落盘内容看，不看查询结果。
  const onDisk = JSON.parse(disk.get('/state/generated-images.json')).items;
  ok('文件里最多留 50 条', onDisk.length === 50, String(onDisk.length));
  ok('查询最多给 20 条', sandbox.__recent(999).length === 20);
  ok('文件真的写了', disk.has('/state/generated-images.json'));

  // 文件坏掉时不能把整个生图流程带崩
  disk.set('/state/generated-images.json', '{坏掉的 json');
  ok('脏文件回落空数组', Array.isArray(sandbox.__recent(3)) && sandbox.__recent(3).length === 0);
}

// ---------- ②~⑤ 静态接线 ----------
console.log('[接线]');
ok('登记器挂进 imageHelpers', bridgeSrc.includes('recordGeneratedImage: (entry) => recordGeneratedImage(entry),'));
ok('查询器挂进 imageHelpers', bridgeSrc.includes('recentGeneratedImages: (limit) => recentGeneratedImages(limit),'));
ok('画完就记一笔', genSrc.includes('h.recordGeneratedImage({ path: result.path, prompt, size: body.size, key, at: Date.now() })'));

const recentIdx = genSrc.indexOf("if (action === 'recent') {");
const permitIdx = genSrc.indexOf('let permit = h.imageAllowedNow(key);');
ok('模块有 action recent', recentIdx > 0);
ok('recent 排在额度判断之前', recentIdx > 0 && permitIdx > recentIdx, `recent=${recentIdx} permit=${permitIdx}`);
ok('recent 返回 path 与提示', genSrc.includes('path 是长期保留的本地路径'));

ok('回执提示提到 recent', genSrc.includes('action:"recent"'));
ok('未知 action 文案包含 recent', genSrc.includes('（可用 generate / status / recent）'));

ok('MCP 声明取 action', /action: z\.enum\(\['generate', 'recent'\]\)/.test(mcpSrc));
ok('MCP 透传 action', /action: act/.test(mcpSrc));
ok('MCP 说明提到 recent', mcpSrc.includes('action:"recent"'));

// ---------- 删说说要划账 ----------
console.log('[说说账本]');
ok('删说说时划掉本地账', bridgeSrc.includes('[qzone] 已从本地账里划掉 tid='));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
