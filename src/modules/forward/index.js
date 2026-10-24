// 合并转发查看：GET /api/socialV2/forward-message、POST /api/socialV2/forward-media
//
// 从 src/bridge.js 老 if 链整段搬来（阶段29）。这一族是整个模块化里
// 依赖最稠密的一批（闭包 60 / 状态 30 的族统计主要是被别的路由带偏的，
// 这两条自身只用 8 个句柄），也是**安全边界最敏感**的一条：
//
// 1. `forward-message` 只允许读「本会话确实收到过的 forward id」。
//    判据是三处并集：recentMessages 里的 forwardIds、unread 里的 forwardIds、
//    以及 seenForwardIds 里历史登记过的。这条边界是防 AI 任意探测/跨会话读取的，
//    搬家时一个字都不能省。
// 2. 它要求必须带 agent token（不是「带了才校验」）—— 与其它 v2 工具面的
//    「带才校验」不同，这里没 token 直接 403「必须携带 agent token」。
// 3. `forward-media` 反而是「带了才校验」的口径，且要在 currentMode 检查之前；
//    顺序错会让控制台自己也被拦，或者让 AI 通道绕过模式限制。
// 4. 嵌套转发预览最多 5 层 3 条 120 字，是为了一次调用能先看到结构而不炸上下文。
import { rejectAi } from '../core/shared.js';
import { formatForwardResponse } from '../../forward.js';

export default {
  name: 'forward',
  title: '合并转发查看',
  inject: ['cfg', 'log', 'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled', 'forwardHelpers'],
  routes: [
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/socialV2/forward-message',
      async handler({ req, url, sendJson }) {
        const h = this.ctx.forwardHelpers;
        const key = String(url.searchParams.get('key') ?? '').trim();
        const id = String(url.searchParams.get('id') ?? '').trim();
        const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
        const keyMatch = /^(group|private):(\d+)$/.exec(key);
        if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
        if (h.currentMode() !== 'reserved2') {
          sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
          return;
        }
        if (!agentToken) {
          sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
          return;
        }
        if (!this.ctx.agentTokenOk(key, agentToken)) {
          sendJson({ ok: false, error: 'agent token 无效' }, 403);
          return;
        }
        const kind = keyMatch[1];
        const num = Number(keyMatch[2]);
        if (!Number.isFinite(num) || num <= 0 || !h.modeAllowed(key, kind, num, this.ctx.cfg, h.currentMode())) {
          sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
          return;
        }
        if (!this.ctx.v2ToolEnabled('getForwardMsg')) {
          sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
          return;
        }
        // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
        const st = h.getSocialV2State(key);
        const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
        const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
        const seenInMemory = h.seenForwardIds().get(key)?.has(id) === true;
        if (!seenInRecent && !seenInUnread && !seenInMemory) {
          sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
          return;
        }
        try {
          const data = await h.bot().raw('get_forward_msg', { id });
          const formatted = formatForwardResponse(data);
          const remember = (fid) => {
            if (!fid) return;
            let set = h.seenForwardIds().get(key);
            if (!set) {
              set = new Set();
              h.seenForwardIds().set(key, set);
            }
            set.add(fid);
            if (set.size > 1000) {
              for (const old of set) {
                set.delete(old);
                if (set.size <= 1000) break;
              }
            }
          };
          // 把本层出现的嵌套 forward id 登记为「本会话已见过」，AI 后续可直接再次读取。
          for (const m of formatted.messages || []) {
            for (const fid of m.nestedForwardIds || []) remember(fid);
          }
          // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
          const nestedPreviews = [];
          const nestedIds = [];
          const seenNested = new Set();
          for (const m of formatted.messages || []) {
            for (const fid of m.nestedForwardIds || []) {
              if (!seenNested.has(fid) && nestedIds.length < 5) {
                seenNested.add(fid);
                nestedIds.push(fid);
              }
            }
          }
          for (const fid of nestedIds) {
            try {
              const ndata = await h.bot().raw('get_forward_msg', { id: fid });
              const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
              for (const nm of nfmt.messages || []) {
                for (const nfid of nm.nestedForwardIds || []) remember(nfid);
              }
              nestedPreviews.push({ id: fid, ...nfmt });
            } catch (error) {
              this.ctx.log(`嵌套转发预览失败 ${key} ${fid}: ${error?.message ?? error}`);
              nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
            }
          }
          sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
        } catch (error) {
          this.ctx.log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
        }
      },
    },
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/socialV2/forward-media',
      async handler({ req, sendJson, readBody }) {
        const h = this.ctx.forwardHelpers;
        const body = (await readBody()) ?? {};
        const key = String(body.key ?? '').trim();
        const media = Array.isArray(body.media) ? body.media : [];
        if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
        // 注意这里用 rejectAi（带 token 才校验），与上面 forward-message 的
        // 「必须带 token」口径不同，是历史行为，别顺手统一。
        if (rejectAi({ ctx: this.ctx, req, sendJson, key, tool: 'getForwardMsg', what: 'qq_get_forward_msg' })) return;
        if (h.currentMode() !== 'reserved2') {
          sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403);
          return;
        }
        if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
        try {
          const images = await h.fetchMediaData(media);
          sendJson({ ok: true, key, media, images });
        } catch (error) {
          this.ctx.log(`转发媒体读取失败 ${key}: ${error?.message ?? error}`);
          sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
        }
      },
    },
  ],
};
