// B 站浏览：POST /api/socialV2/bili
//
// 从 src/bridge.js 老 if 链整段搬来（阶段28）。这一族是所有可搬族里最轻的
// （闭包 3 / 状态 5），因为它把真正的网络活都交给 BiliClient，
// 而 BiliClient 只依赖 phoneBridge（扩展转发）。
//
// 三个要点，改代码前先读：
// 1. **参数校验必须排在「出口通不通」之前**。出口不通的时候，模型也能看出是
//    自己把 action / keyword 写错了，而不是一律收到「离线」。老代码这里特意
//    留了注释，别在重构时把它们合并成一个提前 return。
// 2. 出口判断已经从 `phoneOnline()` 换成 `biliOnline()`。2026-10-29 实测：
//    服务器**直连 B 站是通的**（补一个 buvid3 cookie 即可，见 src/bili-direct.js），
//    老文案里「服务器出口 IP 被拉黑」只对走浏览器桥成立。所以桥离线不再等于刷不了站。
// 3. `biliClient()` 是懒建 + 复用，走访问器拿；不要在这个模块里自己 new 一个，
//    那样每次请求都会新建一份 PhoneBridge 订阅。
//
// 2026-10-29 新增 action=`watch`：真的把视频下下来抽帧看画面（十几秒），
// 图片以 base64 塞在 data.images 里，由 MCP 侧转成 image block。
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
          if (!['recommend', 'video', 'comments', 'search', 'watch'].includes(action)) {
            sendJson({ ok: false, error: 'action 必须是 recommend / video / comments / search / watch' }, 400);
            return;
          }

          // 参数校验排在「出口通不通」之前（见文件头第 1 条）。
          if (action === 'search' && !String(body.keyword ?? '').trim()) {
            sendJson({ ok: false, error: '搜索要带 keyword' }, 400);
            return;
          }
          if ((action === 'video' || action === 'comments') && !String(body.bvid ?? '').trim() && !body.aid) {
            sendJson({ ok: false, error: action + ' 要带 bvid（评论也可以直接给 aid）' }, 400);
            return;
          }
          if (action === 'watch' && !/^BV[0-9A-Za-z]{10}$/.test(String(body.bvid ?? '').trim())) {
            sendJson({ ok: false, error: 'watch 要看哪个视频？给合法的 bvid（BV 开头 12 位）' }, 400);
            return;
          }

          // 出口不通就说清楚原因，别让模型以为 B 站挂了、然后反复重试。
          // 注意这里问的是 biliOnline() 而不是 phoneOnline()：直连现在才是主路，
          // 浏览器桥离线不再等于「刷不了站」（2026-10-29 改）。
          if (!h.biliOnline()) {
            sendJson({ ok: false, error: h.describePhoneOffline(), offline: true }, 503);
            return;
          }

          // watch 单独走：它要下载 + 抽帧，耗时十几秒，别跟只读查询混在一起。
          if (action === 'watch') {
            const r = await h.watchVideo({
              bvid: String(body.bvid ?? '').trim(),
              maxSeconds: Number(body.maxSeconds) || undefined,
              maxFrames: Number(body.maxFrames) || undefined,
              framesPerTile: Number(body.framesPerTile) || undefined
            });
            if (!r.ok) {
              sendJson({ ok: false, action, error: r.error, data: r.video ?? null }, 502);
              return;
            }
            // 主模型（deepseek）不接图：把拼图 base64 塞回模型会直接报
            // 「模型不支持看图」，整轮失败。所以必须在这里就交给视觉模型代看，
            // 只把文字交出去（transcribeMediaImages 返回项不带 data）。
            const tiles = r.tiles ?? [];
            let visionText = '';
            if (tiles.length && typeof h.transcribeImages === 'function') {
              try {
                const seen = await h.transcribeImages(
                  tiles.map((t) => ({ data: t.buffer.toString('base64'), mimeType: t.mimeType }))
                );
                visionText = seen
                  .map((x) => String(x?.text ?? '').trim())
                  .filter(Boolean)
                  .join('\n');
              } catch (error) {
                visionText = `（画面没能代看：${error?.message ?? error}）`;
              }
            }
            sendJson({
              ok: true,
              action,
              text: [r.summaryText, visionText].filter(Boolean).join('\n\n'),
              data: {
                video: r.video,
                stream: r.stream,
                bytes: r.bytes,
                mode: r.mode,
                frameCount: r.frameCount,
                elapsedMs: r.elapsedMs,
                visionText,
                // 空数组：上层看到没有 data 就不拼 image block
                images: []
              }
            });
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
