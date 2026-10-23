/** 弹出面板：填写服务器地址与令牌，看运行状态。 */

const $ = (id) => document.getElementById(id);

function fmtAgo(ts) {
  if (!ts) return '从未';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  return `${Math.floor(s / 3600)} 小时前`;
}

function render(st) {
  const online = st.running && st.lastPollAt && Date.now() - st.lastPollAt < 90000;
  $('status').innerHTML = [
    `状态：<span class="${online ? 'ok' : 'bad'}">${online ? '运行中' : (st.running ? '等待服务器' : '已停止')}</span>`,
    `<span class="k">最后轮询：</span>${fmtAgo(st.lastPollAt)}`,
    `<span class="k">完成任务：</span>${st.doneCount ?? 0}　<span class="k">失败：</span>${st.failCount ?? 0}`,
    st.lastError ? `<span class="k">最近错误：</span><span class="bad">${escapeHtml(st.lastError)}</span>` : ''
  ].filter(Boolean).join('<br>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  chrome.runtime.sendMessage({ type: 'get-state' }, (st) => {
    if (st) render(st);
  });
}

async function init() {
  const got = await chrome.storage.local.get(['endpoint', 'token']);
  if (got.endpoint) $('endpoint').value = got.endpoint;
  if (got.token) $('token').value = got.token;
  refresh();
  setInterval(refresh, 1000);
}

$('save').addEventListener('click', async () => {
  const endpoint = $('endpoint').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  if (!endpoint || !token) {
    $('status').innerHTML = '<span class="bad">地址和令牌都要填</span>';
    return;
  }
  await chrome.storage.local.set({ endpoint, token, enabled: true });
  chrome.runtime.sendMessage({ type: 'restart' }, () => refresh());
});

$('stop').addEventListener('click', async () => {
  await chrome.storage.local.set({ enabled: false });
  $('status').innerHTML = '<span class="bad">已停止</span>';
});

init();
