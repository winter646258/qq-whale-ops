// ── AI 形象：GET /api/socialV2/self-image ──────────────────────────────
//
// 她自己那张立绘。同样是双通道：带 agent token 时要过会话/模式/工具开关，
// 控制台只凭令牌。图片从仓库里的 assets/deepseek娘.png 读，不存在就 404。
//
// 单独一个文件是因为它和生图（generate.js）没有任何共享状态：
// 一条读本地文件，其余走远端生图 API。

async function selfImage({ req, url, sendJson }) {
  const ctx = this.ctx;
  const { fs, path, rootDir, mediaHelpers } = ctx;
  const key = String(url.searchParams.get('key') ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (req.headers['x-agent-token'] && !ctx.agentTokenOk(key, req.headers['x-agent-token'])) {
    sendJson({ ok: false, error: 'agent token 无效' }, 403); return;
  }
  if (req.headers['x-agent-token'] && !ctx.v2SessionAllowed(key)) {
    sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return;
  }
  if (req.headers['x-agent-token'] && !ctx.v2ToolEnabled('getSelfImage')) {
    sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return;
  }
  const selfPath = path.join(rootDir, 'assets', 'deepseek娘.png');
  try {
    if (!fs.existsSync(selfPath)) {
      sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404);
      return;
    }
    const buf = fs.readFileSync(selfPath);
    const mimeType = mediaHelpers.mimeFromBuffer(buf) || 'image/png';
    sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
  } catch (error) {
    sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
  }
}

export const selfImageRoutes = [
  { method: 'GET', path: '/api/socialV2/self-image', kind: 'exact', handler: selfImage },
];
