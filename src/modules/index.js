// 功能模块清单。
//
// 这个文件是**唯一的接入点**：`bridge.js` 只认 `defineModules(ctx)` 的返回值，
// 想加功能就往下面的数组里加一条，不用再改 `bridge.js` 的 if 链。
//
// 模块的写法（照 role-console 抄）：
//
//   1. 一个目录 `src/modules/<名字>/index.js`，`export default { ... }`；
//   2. `inject` 声明依赖，缺了在装载期就炸，不会等到半夜；
//   3. `routes` 声明式地给出 method/kind/path/handler，**不靠**文件里的先后顺序；
//   4. handler 拿到的第一个参数是 `{ req, res, url, sendJson, readBody }`
//      （sendJson / readBody 是请求回调的局部变量，只能这么拿，不能放进 ctx）；
//   5. **禁止 import bridge.js** —— 那会触发第二次 main()，循环 import。需要主文件里的
//      函数，由 bridge.js 通过 `Object.assign(moduleCtx, {...})` 显式交出去，
//      然后在 `inject` 里声明名字。
//
// 回退：`cfg.socialV2.modules.enabled === false` → 一个都不装载，老 if 链接管。

import roleConsole from './role-console/index.js';
import security from './security/index.js';
import approval from './approval/index.js';
import preset from './preset/index.js';
import tokens from './tokens/index.js';
import ops from './ops/index.js';
import stickerConsole from './sticker-console/index.js';
import sticker from './sticker/index.js';
import voice from './voice/index.js';

/**
 * @param {object} ctx 由 `bridge.js` 组装的上下文（cfg / log / stateDir / api / 若干纯函数）
 * @returns {Array<object>} 模块定义数组
 */
export function defineModules(_ctx) {
  return [
    roleConsole,
    security,
    approval,
    preset,
    tokens,
    ops,
    stickerConsole,
    sticker,
    voice,
  ];
}

