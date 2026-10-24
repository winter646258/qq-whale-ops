// v2:core —— 她的「状态 / 唤醒配置 / 提示词」+ 控制台管理面 + 消息读取。
//
// 这一族原本散在 if 链里 587 行，是剩下几个大族中最容易被「顺手改坏」的一族：
//   · get_prompt 是角色卡与工具清单的唯一出口，长度限制与开关清单都在里面；
//   · set_wake_config 是关键词被 AI 反复覆盖的事故现场（见 self.js 的 wake-keyword-lock）；
//   · POST /config 保存一次就可能改写工具开关默认值（见 config.js 的 normalizeSocialV2）。
// 拆成三个文件只是为了让每块不超过一屏，模块本身仍是一个（name 都叫 core）。

import { configRoutes } from './config.js';
import { selfRoutes } from './self.js';
import { messageRoutes } from './messages.js';

export default {
  name: 'core',
  title: '会话状态/唤醒配置/控制台管理面/消息读取',
  inject: [
    'cfg', 'log', 'api',
    'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled',
    'coreHelpers',
  ],
  routes: [...selfRoutes, ...configRoutes, ...messageRoutes],
};
