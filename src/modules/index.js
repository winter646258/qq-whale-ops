// 功能模块清单（阶段 1：空的）。
//
// 这个文件是**唯一的接入点**：`bridge.js` 只认 `defineModules(ctx)` 的返回值，
// 想加功能就往下面的数组里加一条，不用再改 `bridge.js` 的 if 链。
//
// 阶段 1 故意留空：
//   先把装载器、诊断端点、回退开关跑通并观察两三天，确认「空装载」对 24/7 主进程
//   零影响，再往里面逐个搬功能。一次搬一个，搬一个验一个——这比一次性重构安全得多。
//
// 一个模块长这样（阶段 3 的试点会照这个写）：
//
//   export const chatModules = (ctx) => {
//     const ask = (a, b) => { throw new Error(`${a} 未实现：${b}`); };
//     return [{
//       name: 'qzone',                 // 模块名，重复即装载失败
//       title: 'QQ 说说/空间动态',
//       inject: ['log', 'cfg'],        // 声明依赖，缺了在装载期就炸，不会等到半夜
//       routes: [{
//         kind: 'exact',
//         method: 'POST',
//         path: '/api/socialV2/qzone',
//         handler: async ({ req, sendJson, readBody }) => { /* … */ },
//       }],
//       async setup(ctx) { /* 建客户端、起定时器 */ },
//       async teardown(ctx) { /* 停定时器 */ },
//     }];
//   };

/**
 * @param {object} ctx 由 `bridge.js` 组装的上下文（见 `modules/context.md`）
 * @returns {Array<object>} 模块定义数组
 */
export function defineModules(_ctx) {
  return [];
}
