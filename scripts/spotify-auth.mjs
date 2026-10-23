#!/usr/bin/env node
/**
 * Spotify 一次性授权工具
 *
 * 用法：
 *   node scripts/spotify-auth.mjs              打印授权链接，起本地回调
 *   node scripts/spotify-auth.mjs --print-only 只打印链接（在别的机器开浏览器时用）
 *   node scripts/spotify-auth.mjs --code=xxxx  手动贴 code
 *
 * 它做四件事：
 *   1. 读 config.json 的 spotify.clientId / clientSecret / redirectUri
 *   2. 拼授权链接（scope 见 DEFAULT_SCOPES）
 *   3. 起一个只监听 127.0.0.1 的临时口，等 Spotify 把 code 送回来
 *   4. 用 code 换 token，refresh_token 加密落盘到 state/spotify-secrets.json
 *
 * 密钥在 state/spotify.key（600）。删掉它 = 密文作废 = 需重新授权，这是刻意的。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SpotifyClient, SecretBox } from '../src/spotify-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, 'state');

function readCfg() {
  const p = path.join(ROOT, 'config.json');
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function buildClient(cfg) {
  const sc = cfg.spotify ?? {};
  if (!sc.clientId || !sc.clientSecret) {
    console.error('X config.json 里 spotify.clientId / spotify.clientSecret 还是空的。');
    console.error('  去 https://developer.spotify.com/dashboard 建个 App，把两个值填进 config.json。');
    process.exit(1);
  }
  return new SpotifyClient({
    clientId: sc.clientId,
    clientSecret: sc.clientSecret,
    redirectUri: sc.redirectUri || 'http://127.0.0.1:8888/callback',
    secrets: new SecretBox({ dir: STATE }),
    log: (m) => console.log(m)
  });
}

async function manualCode(client, code) {
  const r = await client.exchangeCode(code);
  console.log('OK 授权完成');
  console.log('  scope:', r.scope || '(空)');
  console.log('  refresh token 已加密写入 state/spotify-secrets.json');
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = readCfg();
  const client = buildClient(cfg);
  const state = crypto.randomBytes(8).toString('hex');
  const url = client.authorizeUrl(state);

  const manual = args.find((a) => a.startsWith('--code='));
  if (manual) { await manualCode(client, manual.slice('--code='.length)); return; }

  console.log('');
  console.log('==== 请在浏览器里打开这个链接并点「同意」====');
  console.log('');
  console.log(url);
  console.log('');
  console.log('============================================');
  console.log('');

  if (args.includes('--print-only')) {
    console.log('(--print-only) 不启动回调口。授权后浏览器会跳到一个打不开的地址，');
    console.log('把地址栏里 code= 后面那串复制过来：');
    console.log('  node scripts/spotify-auth.mjs --code=那串');
    return;
  }

  const redirect = new URL(client.redirectUri);
  const port = Number(redirect.port) || 8888;
  const wantPath = redirect.pathname || '/callback';

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1:' + port);
    if (u.pathname !== wantPath) { res.writeHead(404); res.end('not found'); return; }
    const err = u.searchParams.get('error');
    if (err) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('授权被拒绝：' + err);
      console.error('X 授权被拒绝：', err);
      server.close(() => process.exit(1));
      return;
    }
    const gotState = u.searchParams.get('state');
    if (gotState !== state) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('state 不匹配，可能是别人发起的链接，已拒绝。');
      console.error('X state 不匹配，已拒绝（防 CSRF）');
      server.close(() => process.exit(1));
      return;
    }
    const code = u.searchParams.get('code');
    try {
      const r = await client.exchangeCode(code);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h2>授权完成，可以关掉这个页面了</h2><p>鲸鱼娘现在能看你在听什么了。</p>');
      console.log('OK 授权完成');
      console.log('  scope:', r.scope || '(空)');
      console.log('  refresh token 已加密写入 state/spotify-secrets.json');
      server.close(() => process.exit(0));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(e?.message ?? e));
      console.error('X', e?.message ?? e);
      server.close(() => process.exit(1));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log('回调口已开：http://127.0.0.1:' + port + wantPath + '（只监听 127.0.0.1）');
    console.log('等你在浏览器里点同意……（20 分钟超时）');
    console.log('');
  });

  setTimeout(() => {
    console.log('X 180 秒没等到回调，退出了。可以重跑，或用 --print-only / --code=。');
    server.close(() => process.exit(1));
  }, 1_200_000);
}

main().catch((e) => { console.error('X', e?.message ?? e); process.exit(1); });
