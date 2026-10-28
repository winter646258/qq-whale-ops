#!/usr/bin/env node
/**
 * 守门：bridge 启动时不能带着假的 'chat' 模式对外服务。
 *
 * 背景（2026-10-28 的现场）：`let currentMode = 'chat'` 是硬编码初值，真正的模式要等
 * DSH 回话后 refreshMode() 才读到，而 HTTP 服务在那之前已经 listen。于是「provider 切换
 * 触发重启」的几十秒里，她的任何 QQ 工具调用都会被打成
 * 「该接口仅 reserved2 模式可用」——她当时理解为「收藏这个口子我这边是关着的」。
 *
 * 这个用例就是钉住三件事，防止以后有人把垫底逻辑「顺手清理掉」：
 *   1) 启动时用 state/mode.json 预置模式，且必须在 `let lastMode` 之前；
 *   2) 预留值必须过 normalizeModeInput（别把 'reserved2 ' 这种脏值直接塞进去）；
 *   3) 模式切换要留日志、403 文案要带当前模式（否则下次又只能靠猜）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, '..', 'src', 'bridge.js');
const src = readFileSync(bridgePath, 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
};

const idxInit = src.indexOf("let currentMode = 'chat';");
const idxSeed = src.indexOf('MARKER: mode-boot-hint');
const idxLast = src.indexOf('let lastMode = currentMode;');
const secA = idxSeed >= 0 ? src.slice(idxSeed, idxLast > idxSeed ? idxLast : idxSeed + 1200) : '';

console.log('[1] 启动垫底');
ok('currentMode 的初值仍是 chat（不动原语义）', idxInit > 0);
ok('有 mode-boot-hint 垫底块', idxSeed > 0);
ok('垫底块在 let lastMode 之前', idxSeed > 0 && idxLast > idxSeed);
ok('读的是 state/mode.json', /readJsonSafe\(path\.join\(STATE_DIR, 'mode\.json'\)/.test(secA));
ok('过了 normalizeModeInput', secA.includes('normalizeModeInput('));
ok('预置后打了日志', /启动时按 state\/mode\.json 预置模式/.test(secA));
ok('垫底赋值发生在 currentMode 初始化之后', idxInit > 0 && idxSeed > idxInit);

console.log('[2] 模式变化留痕');
ok('refreshMode 里有 mode-change-log', src.includes('MARKER: mode-change-log'));
ok('切换时打印旧->新', /桥接模式切换：\$\{currentMode\} -> \$\{fromDsh\}/.test(src));

console.log('[3] 403 能自证');
ok('总闸文案带当前模式', /该接口仅 reserved2 模式可用（当前模式：\$\{currentMode\}）/.test(src));
ok('总闸仍是 reserved2 判定（没被放宽）', /url\.pathname\.startsWith\('\/api\/socialV2\/'\) && currentMode !== 'reserved2'/.test(src));

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
