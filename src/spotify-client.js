/**
 * Spotify 客户端 —— 听歌演示用（只读）
 *
 * 为什么单独成文件：bridge.js 已 14000+ 行，再塞 400 行 OAuth 会难找。
 * 这个模块不 import 桥接任何东西，可单独 `node -e` 测。
 *
 * 三类凭据别混：
 *   app token      client_credentials（搜索够用，不涉及主人账号）
 *   user token     需要授权（看正在播放 / 私人歌单 / 收藏）
 *   refresh token  user token 的续命手段，**加密落盘**
 *
 * 安全边界（刻意的）：
 *   - 日志只打印 token 前 6 位指纹
 *   - 不提供任何写操作（无 play/pause/add/remove），只读
 *   - 错误翻人话，避免模型看到 403 瞎猜
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';

/** 默认权限：看现在听什么、翻自己歌单和收藏，不能改任何东西。 */
export const DEFAULT_SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read'
];

/** 日志里只露这么多字符。 */
export function mask(v) {
  const s = String(v ?? '');
  if (!s) return '(空)';
  return s.length <= 8 ? '***' : `${s.slice(0, 6)}…(${s.length})`;
}

/** Spotify 错误 -> 能直接行动的提示。 */
function humanError(status, body) {
  const code = body?.error?.status ?? status;
  const msg = String(body?.error?.message ?? '');
  if (code === 401) return '授权失效了（401）：需要重新走一次授权。';
  if (code === 403) return `没有权限（403）：${msg || '接口要求额外权限，或应用没在 Dashboard 勾 Web API'}。`;
  if (code === 404) return `找不到（404）：${msg || 'ID 不对，或歌单不是公开的'}。`;
  if (code === 429) return '限流了（429）：等一下再试，别连续重试。';
  return `Spotify 报错 ${code}：${msg || '未知错误'}`;
}

/**
 * 加密落盘：机器密钥 state/spotify.key(600) -> scrypt -> KEK -> AES-256-GCM。
 * 刻意不做「能恢复」——能恢复就等于能泄露。
 */
export class SecretBox {
  constructor({ dir }) {
    this.dir = dir;
    this.keyPath = path.join(dir, 'spotify.key');
    this.dataPath = path.join(dir, 'spotify-secrets.json');
  }

  _kek() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw = '';
    try { raw = fs.readFileSync(this.keyPath, 'utf8').trim(); } catch {}
    if (!/^[0-9a-f]{64}$/.test(raw)) {
      raw = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(this.keyPath, raw + '\n', { mode: 0o600 });
      try { fs.chmodSync(this.keyPath, 0o600); } catch {}
    }
    return crypto.scryptSync(raw, 'whale-spotify-v1', 32);
  }

  save(obj) {
    const kek = this._kek();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
    const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.dataPath, JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: enc.toString('base64')
    }, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(this.dataPath, 0o600); } catch {}
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.dataPath, 'utf8'); } catch { return null; }
    try {
      const p = JSON.parse(raw);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this._kek(), Buffer.from(p.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(p.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(p.data, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch {
      return null;  // 密钥换过/文件被改 -> 当作没授权，别抛崩
    }
  }

  clear() { try { fs.unlinkSync(this.dataPath); } catch {} }
}

export class SpotifyClient {
  constructor(opts = {}) {
    this.clientId = String(opts.clientId ?? '');
    this.clientSecret = String(opts.clientSecret ?? '');
    this.redirectUri = String(opts.redirectUri ?? 'http://127.0.0.1:8888/callback');
    this.secrets = opts.secrets;
    this.log = opts.log ?? (() => {});
    this.appToken = null;
    this.appTokenExpireAt = 0;
    this.userToken = null;
    this.userTokenExpireAt = 0;
    this._loaded = false;
    this._cached = null;
  }

  get configured() { return Boolean(this.clientId && this.clientSecret); }

  _basic() {
    return 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64');
  }

  _cache() {
    if (!this._loaded) { this._loaded = true; this._cached = this.secrets?.load() ?? {}; }
    return this._cached ?? {};
  }

  _persist(patch) {
    const next = { ...this._cache(), ...patch };
    this.secrets?.save(next);
    this._cached = next;
    return next;
  }

  async _appAccessToken() {
    if (this.appToken && Date.now() < this.appTokenExpireAt - 60_000) return this.appToken;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: this._basic() },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(15_000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`拿不到应用 token：${humanError(res.status, body)}（检查 Client ID / Secret 是否抄错）`);
    }
    this.appToken = body.access_token;
    this.appTokenExpireAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    this.log(`[spotify] 应用 token 已刷新（${mask(this.appToken)}）`);
    return this.appToken;
  }

  async _userAccessToken() {
    if (this.userToken && Date.now() < this.userTokenExpireAt - 60_000) return this.userToken;
    const refresh = String(this._cache().refreshToken ?? '');
    if (!refresh) {
      const err = new Error('还没有授权过：需要主人在浏览器点一次「同意」，才能看正在播放 / 私人歌单 / 收藏。搜索不需要授权。');
      err.needsAuth = true;
      throw err;
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: this._basic() },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
      signal: AbortSignal.timeout(15_000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const err = new Error(`刷新用户 token 失败：${humanError(res.status, body)}（可能被撤销授权，要重新授权）`);
      err.needsAuth = true;
      throw err;
    }
    this.userToken = body.access_token;
    this.userTokenExpireAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    if (body.refresh_token) this._persist({ refreshToken: body.refresh_token });
    this.log(`[spotify] 用户 token 已刷新（${mask(this.userToken)}）`);
    return this.userToken;
  }

  authorizeUrl(state) {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('scope', DEFAULT_SCOPES.join(' '));
    if (state) u.searchParams.set('state', state);
    return u.toString();
  }

  async exchangeCode(code) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: this._basic() },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: this.redirectUri
      }),
      signal: AbortSignal.timeout(20_000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`授权码换 token 失败：${humanError(res.status, body)}（code 只能用一次、5 分钟内有效，redirect_uri 必须和 Dashboard 一字不差）`);
    }
    this.userToken = body.access_token;
    this.userTokenExpireAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    if (body.refresh_token) this._persist({ refreshToken: body.refresh_token, scope: body.scope ?? '' });
    this.log(`[spotify] 授权完成，refresh token 已加密落盘（${mask(body.refresh_token ?? '')}）`);
    return { scope: body.scope ?? '', hasRefresh: Boolean(body.refresh_token) };
  }

  grantedScope() { return String(this._cache().scope ?? ''); }
  hasRefreshToken() { return Boolean(String(this._cache().refreshToken ?? '')); }

  async get(pathname, { params, user = false } = {}) {
    if (!this.configured) throw new Error('Spotify 还没配置：config.json 的 spotify.clientId / clientSecret 是空的。');
    const token = user ? await this._userAccessToken() : await this._appAccessToken();
    const u = new URL(pathname.startsWith('http') ? pathname : API + pathname);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
    const res = await fetch(u.toString(), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(humanError(res.status, body));
      if (res.status === 401 && user) err.needsAuth = true;
      throw err;
    }
    return body;
  }

  async search(keyword, { type = 'track', limit = 10 } = {}) {
    const q = String(keyword ?? '').trim();
    if (!q) throw new Error('搜什么？给个关键词（歌名、歌手、专辑都行）');
    const allowed = ['track', 'artist', 'album', 'playlist'];
    const t = allowed.includes(String(type)) ? String(type) : 'track';
    const body = await this.get('/search', {
      // MARKER: search-no-from-token
      // 不能用 market=from_token：client_credentials 应用令牌不代表任何用户，
      // 带这个参数会被 Spotify 判为 Insufficient client scope（403）。
      params: { q, type: t, limit: Math.min(20, Math.max(1, Number(limit) || 10)) }
    });
    return { type: t, items: body?.[`${t}s`]?.items ?? [], total: body?.[`${t}s`]?.total ?? 0 };
  }

  async nowPlaying() {
    const body = await this.get('/me/player/currently-playing', { user: true });
    if (!body || !body.item) return { playing: false, item: null };
    const it = body.item;
    return {
      playing: Boolean(body.is_playing),
      progressMs: body.progress_ms ?? 0,
      device: body.device?.name ?? '',
      item: {
        name: it.name ?? '',
        artists: (it.artists ?? []).map((a) => a.name).join(' / '),
        album: it.album?.name ?? '',
        url: it.external_urls?.spotify ?? '',
        durationMs: it.duration_ms ?? 0
      }
    };
  }

  async myPlaylists(limit = 20) {
    const body = await this.get('/me/playlists', {
      params: { limit: Math.min(50, Math.max(1, Number(limit) || 20)) },
      user: true
    });
    return (body?.items ?? []).map((p) => ({
      id: p.id, name: p.name ?? '', tracks: p.tracks?.total ?? 0,
      owner: p.owner?.display_name ?? '', url: p.external_urls?.spotify ?? ''
    }));
  }

  async playlistItems(playlistId, limit = 20) {
    const id = String(playlistId ?? '').trim();
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new Error('歌单 ID 不对（用 playlists 拿到的 id）');
    const body = await this.get(`/playlists/${id}/tracks`, {
      params: { limit: Math.min(50, Math.max(1, Number(limit) || 20)), market: 'from_token' },
      user: true
    });
    return (body?.items ?? []).map((x) => {
      const t = x?.track;
      if (!t) return null;
      return { name: t.name ?? '', artists: (t.artists ?? []).map((a) => a.name).join(' / '),
        album: t.album?.name ?? '', url: t.external_urls?.spotify ?? '' };
    }).filter(Boolean);
  }

  async mySavedTracks(limit = 20) {
    const body = await this.get('/me/tracks', {
      params: { limit: Math.min(50, Math.max(1, Number(limit) || 20)) },
      user: true
    });
    return (body?.items ?? []).map((x) => {
      const t = x?.track;
      if (!t) return null;
      return { name: t.name ?? '', artists: (t.artists ?? []).map((a) => a.name).join(' / '),
        album: t.album?.name ?? '', url: t.external_urls?.spotify ?? '' };
    }).filter(Boolean);
  }
}
