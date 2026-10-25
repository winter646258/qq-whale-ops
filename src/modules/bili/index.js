// B 站浏览：POST /api/socialV2/bili
//
// 从 src/bridge.js 老 if 链整段搬来（阶段28）。这一族是所有可搬族里最轻的
// （闭包 3 / 状态 5），因为它把真正的网络活都交给 BiliClient，
// 而 BiliClient 只依赖 phoneBridge（扩展转发）。
//
// 三个要点，改代码前先读：
// 1. **参数校验必须排在「桥在不在线」之前**。扩展没开的时候，模型也能看出是
//    自己把 action / keyword 写错了，而不是一律收到「离线」。老代码这里特意
//    留了注释，别在重构时把它们合并成一个提前 return。
// 2. `describePhoneOffline()` 的文案里写着「服务器出口 IP 被 B 站拉黑」，
//    这是**错的**（实测是缺 buvid3 与 WBI 签名风控，不是 IP 封禁），
//    但在扩展真正上线前不改文案 —— 改了会让模型以为能直连。
// 3. `biliClient()` 是懒建 + 复用，走访问器拿；不要在这个模块里自己 new 一个，
//    那样每次请求都会新建一份 PhoneBridge 订阅。
import { rejectAi } from '../core/shared.js';

export default {
  name: 'bili',
  title: 'B 站浏览',
  inject: ['cfg', 'log', 'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled', 'biliHelpers'],
  routes: [
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/socialV2/bili',
      async handler({ req, sendJson, readBody }) {
        const h = this.ctx.biliHelpers;
        try {
          const body = (await readBody()) ?? {};
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }

          // 智能体通道才校验 token/模式/工具开关；控制台身份不受这些约束。
          if (rejectAi({ ctx: this.ctx, req, sendJson, key, tool: 'bili', what: 'bili' })) return;

          if (this.ctx.cfg.socialV2?.bili?.enabled === false) {
            sendJson({ ok: false, error: 'B 站浏览已在配置里关闭（socialV2.bili.enabled=false）' }, 403);
            return;
          }

          const action = String(body.action ?? '').trim();
          if (!['recommend', 'video', 'comments', 'search'].includes(action)) {
            sendJson({ ok: false, error: 'action 必须是 recommend / video / comments / search' }, 400);
            return;
          }

          // 参数校验排在「桥在不在线」之前（见文件头第 1 条）。
          if (action === 'search' && !String(body.keyword ?? '').trim()) {
            sendJson({ ok: false, error: '搜索要带 keyword' }, 400);
            return;
          }
          if ((action === 'video' || action === 'comments') && !String(body.bvid ?? '').trim() && !body.aid) {
            sendJson({ ok: false, error: action + ' 要带 bvid（评论也可以直接给 aid）' }, 400);
            return;
          }

          // 桥不在线就说清楚原因，别让模型以为 B 站挂了、然后反复重试。
          if (!h.phoneOnline()) {
            sendJson({ ok: false, error: h.describePhoneOffline(), offline: true }, 503);
            return;
          }

          const limit = Math.min(30, Math.max(1, Number(body.limit) || 10));
          const client = h.biliClient();
          let data;
          let text;
          if (action === 'recommend') {
            data = await client.recommend(limit);
            text = h.describeBiliResult('recommend', data);
          } else if (action === 'video') {
            data = await client.videoDetail(body.bvid);
            text = h.describeBiliResult('video', data);
          } else if (action === 'comments') {
            // 只给了 bvid 时要先换出 aid：/x/v2/reply 只认 aid（数字），
            // 传 undefined 会被 B 站当非法参数。
            let aid = Number(body.aid) || 0;
            if (!aid) {
              if (!String(body.bvid ?? '').trim()) {
                sendJson({ ok: false, error: '评论要看哪个视频？给 bvid 或 aid' }, 400);
                return;
              }
              const detail = await client.videoDetail(body.bvid);
              aid = Number(detail?.aid) || 0;
              if (!aid) {
                sendJson({ ok: false, error: '拿不到这个视频的 aid，换个 BV 号试试' }, 502);
                return;
              }
            }
            data = await client.comments(aid, { ps: limit });
            text = h.describeBiliResult('comments', data);
          } else {
            const kw = String(body.keyword ?? '').trim();
            data = await client.search(kw, { page: 1, ps: limit });
            text = h.describeBiliResult('search', { list: data, keyword: kw });
          }

          sendJson({ ok: true, action, text, data });
        } catch (error) {
          sendJson({ ok: false, error: 'B 站查询失败：' + (error?.message ?? error) }, 500);
        }
      },
    },
  ],
};
