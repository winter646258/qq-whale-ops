// ── 生图与 AI 形象（/api/socialV2/image、/api/socialV2/image-approval、
//    /api/socialV2/self-image）────────────────────────────────────────
//
// 阶段16。三条路由原先挂在 main() 的 if 链里（原 L6559 self-image、L6658 image、
// L6756 image-approval）。三个 handler 分成两个文件，因为共享状态很少：
//   generate.js —— 生图 + 审批（共享 image-throttle / 审批状态机）
//   self.js     —— 读本地立绘
//
// inject 里为什么要这么多：imageAllowedNow / generateImageNow 在 main() 的
// L10013 / L10055，比其它注入点晚得多，所以一律交闭包；常量与状态机函数大多
// 在注入点之前声明，可以直交；imageLastStartAt 是 Map（内容可变，引用不变），
// 所以给访问器函数而不是裸交，避免以后有人把它改成重新赋值。
import { imageRoutes } from './generate.js';
import { selfImageRoutes } from './self.js';

const name = 'image';
const title = '生图与 AI 形象';

const inject = [
  'cfg', 'log', 'fs', 'path', 'rootDir',
  'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled',
  'mediaHelpers', 'imageHelpers',
];

const routes = [
  ...imageRoutes,
  ...selfImageRoutes,
];

export default { name, title, inject, routes };
