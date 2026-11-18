'use strict';
const { app, BrowserWindow, ipcMain, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
/* 用户数据目录固定为纯 ASCII 路径，避免中文目录在部分环境下的权限/锁文件失败 */
app.setName('MiguMusic');
const api = require('./migu-api');
const player = require('./player');

let win = null;
let ICON = null;
let loginWin = null;

const CONFIG_DIR = app.getPath('userData');
const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');
const STORE_FILE = path.join(CONFIG_DIR, 'store.json');

/* 应用图标（开发态在 build/，打包态在 resources/app/build/） */
(function resolveIcon() {
  const cands = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'app', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'build', 'icon.png'),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) { ICON = c; break; } } catch (e) {} }
})();

function loadAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    api.setAuth(a);
    return a;
  } catch (e) { return null; }
}
function saveAuth(a) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
  api.setAuth(a);
}

/* ───────── 本地存储（收藏 / 最近播放 / 设置） ───────── */
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeStore(o) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(o, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0f0f16',
    icon: ICON || undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => win.webContents.send('window:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.MIGU_DEBUG) {
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      console.log('[renderer]', level, message, sourceId ? sourceId.split('/').pop() + ':' + line : '');
    });
    win.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[load-fail]', code, desc, url));
    win.webContents.on('render-process-gone', (e, d) => console.log('[renderer-gone]', JSON.stringify(d)));
  }
  win.on('closed', () => { win = null; });
}

/* ───────── 窗口控制 ───────── */
ipcMain.handle('window:minimize', () => win && win.minimize());
ipcMain.handle('window:toggleMaximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:close', () => win && win.close());
ipcMain.handle('window:isMaximized', () => !!(win && win.isMaximized()));
ipcMain.handle('shell:openExternal', (e, url) => {
  if (/^https?:/.test(String(url || ''))) shell.openExternal(url);
});

/* ───────── 原生播放内核（FFmpeg + WASAPI） ───────── */
/* 用 native/ 下的 Rust/FFmpeg napi 模块解码出声，不再走 Chromium <audio>：
   Chromium 解不了咪咕臻品档位的 3D WAV / 伪装容器（readyState 恒 0、进度条不动）。 */
let playerReady = false;
function initPlayer() {
  if (playerReady) return true;
  playerReady = player.init((ev) => {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send('player:event', ev); } catch (e) { /* ignore */ }
  });
  if (!playerReady) console.log('[player] 原生内核不可用:', player.lastError());
  else { console.log('[player] 原生内核就绪'); try { player.setVolume(0.8); } catch (e) {} }
  return playerReady;
}

ipcMain.handle('player:available', () => ({ ok: initPlayer(), error: player.lastError() }));

/** 装载一首并返回时长（秒）。autoplay=false 时只装载不出声。 */
ipcMain.handle('player:load', async (e, url, autoplay) => {
  if (!initPlayer()) return { ok: false, error: player.lastError() };
  try {
    player.stop().catch(() => {});
    const dur = await player.load(url);
    if (autoplay) await player.play();
    const st = player.getState() || {};
    return { ok: true, duration: dur || Number(st.duration) || 0 };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('player:play', async () => {
  if (!playerReady) return { ok: false };
  try { await player.play(); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('player:pause', async () => {
  if (!playerReady) return { ok: false };
  try { await player.pause(); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('player:stop', async () => {
  if (!playerReady) return { ok: false };
  try { await player.stop(); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('player:seek', async (e, t) => {
  if (!playerReady) return { ok: false };
  try { await player.seek(t); return { ok: true }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('player:volume', (e, v) => {
  if (!playerReady) return { ok: false };
  player.setVolume(v);
  return { ok: true };
});
ipcMain.handle('player:state', () => {
  if (!playerReady) return { playing: false, paused: true, duration: 0, timePos: 0 };
  return player.getState();
});

/* ───────── 接口代理 ───────── */
const wrap = (fn) => async (e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
};

ipcMain.handle('api:home', wrap(() => api.getHome()));
ipcMain.handle('api:hotSearch', wrap(() => api.getHotSearch()));
ipcMain.handle('api:column', wrap((id, pageNo) => api.getColumn(id, pageNo)));
ipcMain.handle('api:topLists', wrap(() => api.getTopLists()));
ipcMain.handle('api:search', wrap((text, type, pageNo, pageSize) => api.search(text, type, pageNo, pageSize)));
ipcMain.handle('api:suggest', wrap((text) => api.getSearchSuggest(text)));
ipcMain.handle('api:playlist', wrap((id) => api.getPlaylist(id)));
ipcMain.handle('api:album', wrap((id) => api.getAlbum(id)));
ipcMain.handle('api:singerTabs', wrap(() => api.getSingerTabs()));
ipcMain.handle('api:singerInfo', wrap((id) => api.getSingerInfo(id)));
ipcMain.handle('api:singerSongs', wrap((id, pageNo) => api.getSingerSongs(id, pageNo)));
ipcMain.handle('api:singerAlbums', wrap((id, pageNo) => api.getSingerAlbums(id, pageNo)));
ipcMain.handle('api:newSongs', wrap(() => api.getNewSongs()));
ipcMain.handle('api:todayRecommend', wrap(() => api.getTodayRecommend()));
ipcMain.handle('api:radio', wrap(() => api.getRadio()));
ipcMain.handle('api:songDetail', wrap((q) => api.getSongDetail(q || {})));
ipcMain.handle('api:listen', wrap((cid, cp, tone) => api.getListenUrl(cid, cp, tone)));
ipcMain.handle('api:canListen', wrap((ids) => api.canListen(ids)));
ipcMain.handle('api:lyric', wrap((url, mrcUrl) => api.getLyric(url, mrcUrl)));
ipcMain.handle('api:raw', wrap((p, params, opts) => api.apiGet(p, params, opts)));
/* 云端「我喜欢的」 */
ipcMain.handle('api:favorites', wrap(() => api.getFavorites()));
ipcMain.handle('api:like', wrap((contentId) => api.likeSong(contentId)));
ipcMain.handle('api:unlike', wrap((contentId) => api.unlikeSong(contentId)));
ipcMain.handle('api:checkLiked', wrap((ids) => api.checkLiked(ids)));

/* ───────── 本地库 ───────── */
ipcMain.handle('store:get', () => readStore());
ipcMain.handle('store:set', (e, patch) => {
  const cur = readStore();
  writeStore(Object.assign(cur, patch || {}));
  return true;
});

/* ───────── 登录 ───────── */

const AUTH_FULL_FILE = path.join(CONFIG_DIR, 'account.json');

/** 已登录账号的完整资料（昵称 / 头像 / 会员等级），落盘避免每次启动都请求 */
function readAccount() { try { return JSON.parse(fs.readFileSync(AUTH_FULL_FILE, 'utf8')); } catch (e) { return null; } }
function writeAccount(o) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(AUTH_FULL_FILE, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {}
}

/**
 * 用 token 完成一次「换 pacmtoken → 补全资料 → 写盘」。
 * 这是全部登录入口的唯一出口，无论 token 从 postMessage / URL / localStorage 哪来。
 */
async function finishLogin(rawToken, extra) {
  const token = String(rawToken || '').trim();
  if (!token) return { ok: false, error: '登录返回的 token 为空' };
  const v = await api.validateToken(token, '2', '220029');
  if (!v.ok || !v.pacmtoken) return { ok: false, error: v.info || '换取登录凭证失败' };
  const d = v.data || {};
  const auth = {
    pacmtoken: v.pacmtoken,
    token,
    uid: d.userId || '',
    msisdn: d.msisdn || '',
    sid: d.usessionId || '',
    passId: d.passId || '',
    authType: d.authType || '',
    deviceId: api.deviceId(),
    savedAt: Date.now(),
  };
  if (extra && extra.msisdn && !auth.msisdn) auth.msisdn = extra.msisdn;
  if (extra && extra.uid && !auth.uid) auth.uid = extra.uid;
  saveAuth(auth);

  let info = null;
  try { info = await api.getUserInfo(auth.pacmtoken, auth.uid); } catch (e) {}
  let pc = null;
  try { pc = await api.getPcUserInfo(auth.pacmtoken, auth.uid); } catch (e) {}
  let vip = null;
  try { vip = await api.getMemberCenter(auth.pacmtoken, auth.uid); } catch (e) {}
  const account = {
    auth,
    profile: info && info.ok ? info : null,
    pc: pc && pc.ok ? pc : null,
    vip: vip && vip.ok ? vip : null,
    updatedAt: Date.now(),
  };
  writeAccount(account);
  return { ok: true, auth, account };
}

/** 把账号资料整体刷一遍（启动时 / 手动刷新） */
async function refreshAccount() {
  const a = loadAuth();
  if (!a || !a.pacmtoken) return { ok: false, loggedIn: false };
  let info = null;
  try { info = await api.getUserInfo(a.pacmtoken, a.uid); } catch (e) {}
  if (!info || !info.ok) {
    const code = info ? String(info.code || '') : '';
    if (code === '290001' || code === '290002' || code === '290003') {
      try { fs.unlinkSync(AUTH_FILE); } catch (e) {}
      try { fs.unlinkSync(AUTH_FULL_FILE); } catch (e) {}
      api.setAuth({});
      return { ok: false, loggedIn: false, expired: true };
    }
  }
  let pc = null;
  try { pc = await api.getPcUserInfo(a.pacmtoken, a.uid); } catch (e) {}
  let vip = null;
  try { vip = await api.getMemberCenter(a.pacmtoken, a.uid); } catch (e) {}
  const cached = readAccount() || {};
  const account = {
    auth: a,
    profile: info && info.ok ? info : cached.profile || null,
    pc: pc && pc.ok ? pc : cached.pc || null,
    vip: vip && vip.ok ? vip : cached.vip || null,
    updatedAt: Date.now(),
  };
  writeAccount(account);
  return { ok: true, loggedIn: true, auth: a, account };
}

ipcMain.handle('auth:status', async () => {
  const a = loadAuth();
  if (!a || !a.pacmtoken) return { loggedIn: false, auth: null, account: null };
  const cached = readAccount();
  if (cached && cached.profile) {
    // 先给缓存（启动即出画面），后台再刷一遍，刷完推给渲染层刷新头像/昵称/会员
    refreshAccount().then((r) => {
      if (r && r.ok && win && !win.isDestroyed()) {
        try { win.webContents.send('auth:updated', { auth: r.auth, account: r.account }); } catch (e) {}
      }
    }).catch(() => {});
    return { loggedIn: true, auth: a, account: cached, cached: true };
  }
  const r = await refreshAccount();
  return { loggedIn: !!r.loggedIn, auth: a, account: r.account || null };
});

ipcMain.handle('auth:refresh', async () => refreshAccount());

ipcMain.handle('auth:logout', () => {
  try { fs.unlinkSync(AUTH_FILE); } catch (e) {}
  try { fs.unlinkSync(AUTH_FULL_FILE); } catch (e) {}
  api.setAuth({});
  return { ok: true };
});

/** 会员中心单独拉（个人中心「会员权益」区块用） */
ipcMain.handle('auth:member', async () => {
  const a = loadAuth();
  if (!a || !a.pacmtoken) return { ok: false, code: '290001', info: '请先登录' };
  const [vip, pc] = await Promise.all([
    api.getMemberCenter(a.pacmtoken, a.uid).catch(() => null),
    api.getPcUserInfo(a.pacmtoken, a.uid).catch(() => null),
  ]);
  if (vip && vip.ok && pc && pc.ok) vip.pc = pc;
  return vip;
});

/** 全量音质档位（前端按曲目 qualities 过滤后渲染） */
ipcMain.handle('auth:tones', () => api.TONE_ORDER.map((t) => ({ value: t, label: api.toneLabel(t) })));

/** 扫码登录：出二维码（图片是 data:image/jpeg;base64），前端直接 <img src> */
ipcMain.handle('auth:qr', async () => {
  const r = await api.qrCreate('220029');
  if (!r.ok) return { ok: false, error: r.error || '二维码获取失败' };
  return { ok: true, sid: r.sid, image: r.image };
});

/** 轮询扫码状态；status=2000 拿到 token 就直接完成登录 */
ipcMain.handle('auth:qrPoll', async (e, sid) => {
  if (!sid) return { ok: false, error: '缺少会话 id' };
  const r = await api.qrQuery(String(sid), '220029');
  if (!r.ok) return { ok: false, error: r.error || '查询失败' };
  if (r.success && r.token) {
    const fin = await finishLogin(r.token, {});
    if (fin.ok) return { ok: true, done: true, account: fin.account, auth: fin.auth };
    return { ok: false, status: r.status, error: fin.error || '换取登录凭证失败' };
  }
  return { ok: true, done: false, status: r.status, message: r.message, scanned: r.scanned, expired: r.expired };
});

/** 登录窗口。
 * 咪咕 Web SDK 的登录流程：passport 页嵌在 iframe 里，登录成功后向 parent 发
 *   { channel:'__AUTH_LOGIN__', preload:{ ok:true, data:{ token } } }
 * 这里直接把 passport 开成顶层窗口加载，消息会落在本窗口；preload 负责转给主进程。
 * 另有两条兜底：读 localStorage 的 mg_auth_* 键、解析回跳 URL 的 token 参数。
 */
/**
 * 注入到 passport 页面主世界的抓 token 钩子。
 *
 * 为什么需要：passport 登录成功后是 page 自己把 result.token 拼进 URL 再跳转，
 * 有些分支（如二次验证、SIM 登录）跳转 URL 会被中间页吞掉，靠导航事件监听并不可靠。
 * 这里直接钩住 XHR / fetch，把任何含 "token" 的响应体里的 token/userId/msisdn 记到
 * window.__miguToken，主进程轮询时读走即可 —— 与页面用什么方式跳转无关。
 */
const LOGIN_HOOK = [
  '(function(){',
  '  if (window.__miguHook) return "already";',
  '  window.__miguHook = 1;',
  '  function grab(text){',
  '    try {',
  '      if (!text || text.length > 400000) return;',
  '      if (text.indexOf(String.fromCharCode(34) + "token" + String.fromCharCode(34)) < 0) return;',
  '      var m = /"token"\s*:\s*"([^"]+)"/.exec(text);',
  '      if (!m) return;',
  '      var u = /"userId"\s*:\s*"?([0-9A-Za-z_-]+)/.exec(text);',
  '      var ms = /"msisdn"\s*:\s*"?([0-9A-Za-z*]+)/.exec(text);',
  '      window.__miguToken = { token: m[1], uid: u ? u[1] : "", msisdn: ms ? ms[1] : "", at: Date.now() };',
  '      try { window.postMessage({ __miguToken: window.__miguToken }, "*"); } catch (e) {}',
  '    } catch (e) {}',
  '  }',
  '  try {',
  '    var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;',
  '    XMLHttpRequest.prototype.open = function(){ return XO.apply(this, arguments); };',
  '    XMLHttpRequest.prototype.send = function(){',
  '      var self = this;',
  '      try { self.addEventListener("load", function(){ grab(String(self.responseText || "")); }); } catch (e) {}',
  '      return XS.apply(this, arguments);',
  '    };',
  '  } catch (e) {}',
  '  try {',
  '    if (window.fetch) {',
  '      var F = window.fetch;',
  '      window.fetch = function(){',
  '        return F.apply(this, arguments).then(function(r){',
  '          try { r.clone().text().then(grab).catch(function(){}); } catch (e) {}',
  '          return r;',
  '        });',
  '      };',
  '    }',
  '  } catch (e) {}',
  '  return "ok";',
  '})()',
].join('');

/* ─── 短信登录（不走网页，纯接口） ───
 * passport 的 dynamicpassword 通道和登录页表单完全等价，绕开内嵌窗口既能少一层
 * 网页依赖，也不受「TV 版扫码」那套限制。
 */
ipcMain.handle('auth:smsSend', async (e, phone) => {
  try {
    const r = await api.sendSmsCode(phone);
    if (process.env.MIGU_SELFTEST) {
      try { console.log('[smsSend]', String(phone || '').replace(/\d{4}$/, '****'), JSON.stringify(r)); } catch (x) {}
    }
    return r;
  } catch (err) {
    return { ok: false, error: '发送失败：' + (err && err.message) };
  }
});

ipcMain.handle('auth:smsLogin', async (e, phone, code) => {
  try {
    const r = await api.smsLogin(phone, code);
    if (!r.ok) return r;
    return await finishLogin(r.token, { msisdn: String(phone || '').replace(/\D/g, '') });
  } catch (err) {
    return { ok: false, error: '登录失败：' + (err && err.message) };
  }
});

ipcMain.handle('auth:login', async () => {
  if (process.env.MIGU_SELFTEST) { try { console.log('[auth:login] enter'); } catch (e) {} }
  if (loginWin) { try { loginWin.focus(); } catch (e) {} return { ok: false, error: '登录窗口已打开' }; }
  const loginSession = session.fromPartition('persist:migu-login');
  const params = new URLSearchParams({
    sourceid: '220029',
    forceAuthn: 'true',
    hideRegister: '1',
    hideForgetPass: '1',
    callbackURL: 'PostToken',
    tokenType: '2',
  });
  const url = 'https://passport.migu.cn/login?' + params.toString();

  loginWin = new BrowserWindow({
    width: 520,
    height: 820,
    parent: win || undefined,
    modal: false,
    title: '咪咕音乐 - 登录',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: loginSession,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'login-preload.js'),
    },
  });
  loginWin.setMenuBarVisibility(false);
  loginWin.loadURL(url);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let poll = null;
    let busy = false;
    // 同一个候选 token 最多试 3 次（换证偶发网络失败可以重试，但不能无限循环）
    const tried = Object.create(null);
    // 自检时把登录链路的关键节点写进同一份日志（打包后的 exe 没有 stdout）
    const LOGIN_LOG = (...a) => {
      if (!process.env.MIGU_SELFTEST) return;
      const line = '[login] ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
      try { fs.appendFileSync(path.join(app.getPath('temp'), 'migu-selftest.log'), line + '\n'); } catch (e) {}
    };
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      ipcMain.removeListener('auth:token-from-page', onToken);
      if (loginWin) { try { loginWin.close(); } catch (e) {} loginWin = null; }
      resolve(r);
    };

    /** 拿到任意候选 token 就走一次换证；成功即收工 */
    const tryToken = async (tok, extra) => {
      const t = String(tok || '').trim();
      if (!t || settled || busy) return false;
      tried[t] = (tried[t] || 0) + 1;
      if (tried[t] > 3) return false;
      busy = true;
      try {
        const r = await finishLogin(t, extra || {});
        if (r && r.ok) { LOGIN_LOG('ok'); done(r); return true; }
        LOGIN_LOG('fail', (r && r.error) || '', 'try#' + tried[t]);
      } catch (e) { LOGIN_LOG('throw', String(e && e.message)); }
      busy = false;
      return false;
    };

    /** URL 里挖 token：passport 回跳可能带 token/utoken/bounce/code */
    const tryUrl = (rawUrl) => {
      if (!rawUrl) return;
      let u;
      try { u = new URL(rawUrl); } catch (e) { return; }
      const q = u.searchParams;
      const cand = q.get('token') || q.get('utoken') || q.get('uToken') || q.get('accessToken') || '';
      if (cand) tryToken(decodeURIComponent(cand), {});
      else {
        const h = u.hash.replace(/^#/, '');
        if (h) {
          const hp = new URLSearchParams(h);
          const c2 = hp.get('token') || hp.get('utoken') || '';
          if (c2) tryToken(decodeURIComponent(c2), {});
        }
      }
    };

    /** SDK 的 __AUTH_LOGIN__ 消息 / 任意 {token} 载荷 */
    const onToken = async (evt, payload) => {
      if (settled) return;
      const p = payload || {};
      if (p.preload && p.preload.ok === false) return;
      const tok = p.token
        || (p.preload && p.preload.data && (p.preload.data.token || p.preload.data.utoken))
        || '';
      const extra = {
        uid: (p.preload && p.preload.data && p.preload.data.userId) || p.uid || '',
        msisdn: (p.preload && p.preload.data && p.preload.data.msisdn) || p.msisdn || '',
      };
      if (tok) await tryToken(tok, extra);
    };
    ipcMain.on('auth:token-from-page', onToken);

    // 1) 主进程侧监听每一次导航（比轮询 location 更不容易漏掉瞬时回跳）
    if (loginWin) {
      const wc = loginWin.webContents;
      wc.on('will-navigate', (e, url) => tryUrl(url));
      wc.on('will-redirect', (e, url) => tryUrl(url));
      wc.on('did-navigate', (e, url) => tryUrl(url));
      wc.on('did-navigate-in-page', (e, url) => tryUrl(url));
      wc.on('did-frame-navigate', (e, url) => tryUrl(url));

      // 页面主世界注入 XHR/fetch 钩子，直接截 passport 登录成功响应里的 token。
      // 这一步不依赖任何跳转事件，是各条登录路径（短信/密码/SIM/二次验证）的共同出口。
      const injectHook = () => {
        if (!loginWin || loginWin.isDestroyed()) return;
        loginWin.webContents.executeJavaScript(LOGIN_HOOK, true)
          .then((r) => LOGIN_LOG('hook', r))
          .catch((e) => LOGIN_LOG('hook-err', String(e && e.message)));
      };
      wc.on('dom-ready', injectHook);
      wc.on('did-finish-load', injectHook);
      wc.on('did-frame-finish-load', () => injectHook());

      // CDP 层兜底：直接读 passport 的响应体与导航 URL。
      // 页面钩子依赖 JS 上下文还活着，而登录成功后往往立刻跳走；CDP 在网络层，
      // 页面跳不跳都能拿到 body，是四条路里最稳的一条。
      try {
        const dbg = wc.debugger;
        dbg.attach('1.3');
        const drain = async (requestId, url) => {
          try {
            const b = await dbg.sendCommand('Network.getResponseBody', { requestId });
            const text = b.base64Encoded
              ? Buffer.from(b.body || '', 'base64').toString('utf8')
              : String(b.body || '');
            const m = /"token"\s*:\s*"([^"]+)"/.exec(text);
            if (m && m[1]) {
              const u = /"userId"\s*:\s*"?([0-9A-Za-z_-]+)/.exec(text);
              const ms = /"msisdn"\s*:\s*"?([0-9A-Za-z*]+)/.exec(text);
              LOGIN_LOG('cdp-token', url.slice(0, 80));
              tryToken(m[1], { uid: u ? u[1] : '', msisdn: ms ? ms[1] : '' });
            }
          } catch (e) { /* body 已被回收 */ }
        };
        dbg.sendCommand('Network.enable').then(() => LOGIN_LOG('cdp-attached')).catch(() => {});
        dbg.on('message', (event, method, params) => {
          if (method === 'Network.responseReceived') {
            const url = String((params.response && params.response.url) || '');
            if (!/passport\.migu\.cn/i.test(url)) return;
            drain(params.requestId, url);
          } else if (method === 'Network.requestWillBeSent') {
            const url = String((params.request && params.request.url) || '');
            if (url.indexOf('token=') >= 0 && /migu\.cn/i.test(url)) tryUrl(url);
          }
        });
      } catch (e) { LOGIN_LOG('cdp-err', String(e && e.message)); }
    }

    // 2) 兜底轮询：所有 frame 的 URL + localStorage/sessionStorage 的 mg_auth_*
    //    以及 cookie（SDK 的 loginByToken 会把 pacmtoken 写进 mg_auth_sid 这个 cookie）
    poll = setInterval(async () => {
      if (settled || !loginWin || loginWin.isDestroyed()) return;
      if (busy) return;
      try {
        const got = await loginWin.webContents.executeJavaScript(
          '(function(){try{' +
          'var g=function(k){try{var v=localStorage.getItem(k);if(v)return v;}catch(e){}try{return sessionStorage.getItem(k)||"";}catch(e){return "";}};' +
          'var ck={};try{document.cookie.split(/;\s*/).forEach(function(x){var i=x.indexOf("=");if(i>0)ck[x.slice(0,i).trim()]=x.slice(i+1);});}catch(e){}' +
          'var urls=[];try{urls.push(location.href);}catch(e){}' +
          'try{for(var i=0;i<window.frames.length;i++){try{urls.push(window.frames[i].location.href);}catch(e){}}}catch(e){}' +
          'return{st:{pacmtoken:g("mg_auth_pacmtoken"),utoken:g("mg_auth_utoken"),uid:g("mg_auth_uid"),msisdn:g("mg_auth_msisdn"),sid:g("mg_auth_sid")},ck:ck,urls:urls};' +
          '}catch(e){return null;}})()', true);
        if (!got) return;

        // 0) 优先读页面主世界钩子截到的 token（最可靠，不依赖跳转）
        try {
          const hooked = await loginWin.webContents.executeJavaScript(
            'window.__miguToken || null', true);
          if (hooked && hooked.token) {
            if (await tryToken(hooked.token, { uid: hooked.uid || '', msisdn: hooked.msisdn || '' })) return;
          }
        } catch (e) { /* 页面还没注入 */ }

        const st = got.st || {};
        const extra = { uid: st.uid || '', msisdn: st.msisdn || '' };
        if (st.pacmtoken && await tryToken(st.pacmtoken, extra)) return;
        if (st.utoken && await tryToken(st.utoken, extra)) return;

        const ck = got.ck || {};
        const ckTok = ck.pacmtoken || ck.mg_auth_sid || ck.mg_auth_utoken || '';
        if (ckTok && await tryToken(ckTok, extra)) return;

        for (const u of (got.urls || [])) tryUrl(u);
      } catch (e) { /* 页面还没加载完 / 跨域 frame */ }
      // 分区 cookie 也扫一遍（有些回跳只落在 cookie 里）。
      // 注意：cookies.get({domain:'.migu.cn'}) 只匹配 domain 完全等于 .migu.cn 的项，
      // music.migu.cn / passport.migu.cn 各自域的 cookie 会被漏掉，所以这里全量取再按后缀过滤。
      try {
        const cs = await loginSession.cookies.get({});
        for (const c of cs) {
          const n = String(c.name || '');
          const d = String(c.domain || '');
          if (!/migu\.cn$/i.test(d)) continue;
          if (!/^(pacmtoken|mg_auth_sid|mg_auth_utoken|mg_auth_pacmtoken)$/i.test(n)) continue;
          if (!c.value) continue;
          if (await tryToken(c.value, {})) return;
        }
      } catch (e) { /* ignore */ }
    }, 1200);

    const onClosed = () => {
      if (settled) return;
      loginWin = null;
      done({ ok: false, error: '登录窗口已关闭' });
    };
    if (loginWin) {
      loginWin.on('closed', onClosed);
      loginWin.webContents.on('did-fail-load', (e, code, desc) => {
        if (code === -3) return; // aborted
        if (!settled) { /* 保留窗口，让用户重试 */ }
      });
    }
    timer = setTimeout(() => done({ ok: false, error: '登录超时（5 分钟）' }), 5 * 60 * 1000);
  });
});

/* ───────── 自检模式（MIGU_SELFTEST=1，仅开发用） ───────── */
async function runSelfTest() {
  const LOG = path.join(app.getPath('temp'), 'migu-selftest.log');
  try { fs.writeFileSync(LOG, 'start ' + new Date().toISOString() + '\n'); } catch (e) {}
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  log('LOG FILE:', LOG);
  const probe = `(async () => {
    const w = document.querySelector('#view');
    const out = {
      title: document.title,
      viewChildren: w ? w.children.length : -1,
      viewText: w ? w.innerText.slice(0, 400) : '',
      sideItems: Array.from(document.querySelectorAll('.side-item')).map(e => e.dataset.view),
      sections: Array.from(document.querySelectorAll('.sec-title')).map(e => e.textContent),
      cards: document.querySelectorAll('.card').length,
      imgs: document.querySelectorAll('#view img').length,
      brokenImgs: Array.from(document.querySelectorAll('#view img')).filter(i => i.complete && i.naturalWidth === 0).length,
      pendingImgs: Array.from(document.querySelectorAll('#view img')).filter(i => !i.complete).length,
      errs: (window.__errs || []).slice(0, 5),
    };
    return JSON.stringify(out);
  })()`;
  try {
    await wait(7000);
    // 自检会真的请求音频源并播放；全程静音，避免把歌外放给用户（之前「一直在唤起播放」的观感来源）
    await win.webContents.executeJavaScript('audio.muted = true; "muted"').catch(() => {});
    // 0) 原生内核在 Electron 里到底通不通（Node 直跑通过不代表这段可用）
    const pdiag = await win.webContents.executeJavaScript(`(async () => {
      const out = { hasM: !!(M && M.player), errs: (window.__errs||[]).slice(0,6) };
      try { out.avail = await M.player.available(); } catch (e) { out.availErr = String(e.message || e); }
      try { out.state = await M.player.state(); } catch (e) { out.stateErr = String(e.message || e); }
      return JSON.stringify(out);
    })()`).catch((e) => 'PROBE_ERR ' + e.message);
    log('[selftest:player]', pdiag);
    const r1 = await win.webContents.executeJavaScript(probe);
    log('[selftest:home]', r1);
    const nav = async (expr) => {
      try { await win.webContents.executeJavaScript(expr); return 'ok'; }
      catch (e) { return 'ERR ' + String(e && e.message || e); }
    };
    log('[selftest:navrank]', await nav("go('rank',{})"));
    await wait(4000);
    log('[selftest:rank]', await win.webContents.executeJavaScript(probe));
    await win.webContents.executeJavaScript("go('column',{id:'83176390'})");
    await wait(4000);
    log('[selftest:column]', await win.webContents.executeJavaScript(probe));
    await win.webContents.executeJavaScript("go('search',{q:'周杰伦',tab:'song'})");
    await wait(4000);
    log('[selftest:search]', await win.webContents.executeJavaScript(probe));
    // 试播一首免费曲
    const play = await win.webContents.executeJavaScript(`(async () => {
      const tbl = document.querySelector('.songs tbody');
      if (!tbl) return 'no table';
      const fs = await migu.search('倔强 五月天','song',1,20);
      const all = fs.data.list;
      const cl = await migu.canListen(all.map(s => s.contentId));
      const free = all.filter(s => !s.vip || (cl[s.contentId] && cl[s.contentId].canListen && !cl[s.contentId].limitLength));
      playQueue(free.length ? free : all, 0);
      await new Promise(r => setTimeout(r, 6000));
      const a = audio;
      return JSON.stringify({ src: (a.src||'').slice(0,80), dur: a.duration, paused: a.paused, t: a.currentTime, title: document.getElementById('plTitle').textContent, lyricLines: document.querySelectorAll('#lpBody p').length });
    })()`);
    log('[selftest:play]', play);
    // VIP 提示条
    const vipProbe = await win.webContents.executeJavaScript(`(async () => {
      // 登录态下绝大多数 VIP 曲其实能播，必须找真拿不到 url 的（数字专辑 440015 / 3D 音质 440018）
      let vip = null;
      for (const q of ['黑夜问白天 林俊杰', '谢谢侬 陈奕迅']) {
        const r = await migu.search(q, 'song', 1, 10);
        for (const s of (r.data.list || [])) {
          if (vip) break;
          const t = await migu.listen(s.contentId, s.copyrightId, 'PQ');
          if (!t.url) vip = s;
        }
        if (vip) break;
      }
      if (!vip) return 'no blocked song found';
      let raw;
      try { raw = await migu.listen(vip.contentId, vip.copyrightId, S.quality); } catch (e) { raw = { THROW: String(e && e.message) }; }
      playQueue([vip], 0);
      const samples = [];
      for (let i = 0; i < 8; i++) {
        await new Promise(x => setTimeout(x, 500));
        samples.push(document.getElementById('vipTip').classList.contains('show') ? 1 : 0);
      }
      const box = document.getElementById('vipTip');
      return JSON.stringify({ song: vip.name, shown: box.classList.contains('show'), samples,
        raw: JSON.stringify(raw).slice(0, 220),
        title: document.getElementById('vtTitle').textContent,
        sub: document.getElementById('vtSub').textContent });
    })()`);
    log('[selftest:vip]', vipProbe);
    {
      const shotVip = await win.webContents.capturePage();
      fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_vip.png'), shotVip.toPNG());
    }
    // 登录态播放 VIP 曲（周杰伦 晴天）+ 音质切换是否真的改变源文件
    const vipPlay = await win.webContents.executeJavaScript(`(async () => {
      const r = await migu.search('晴天 周杰伦','song',1,10);
      const song = (r.data.list||[]).find(s => s.name === '晴天') || r.data.list[0];
      if (!song) return 'no song';
      const out = { song: song.name };
      // 只验证会员档位（体验会员默认 SQ）能真的出声；不再拿 Z3D 反复触发降档重取，
      // 那种循环会让窗口看起来「一直在唤起播放」。
      const t = S.quality;
      playQueue([song], 0);
      const samples = [];
      for (let i = 0; i < 10; i++) {
        await new Promise(x => setTimeout(x, 1200));
        const a = audio;
        samples.push([Math.round(a.currentTime * 10) / 10, a.readyState, a.paused ? 1 : 0]);
        if (a.currentTime > 2 && !a.paused) break;
      }
      const a = audio;
      out[t] = { src: (a.src||'').split('/').pop().slice(0,46), dur: a.duration, t: a.currentTime, paused: a.paused, samples,
        toast: (document.getElementById('toast')||{}).textContent };
      return JSON.stringify(out);
    })()`);
    log('[selftest:vipplay]', vipPlay);
    // 音质下拉：实际渲染出的档位 + 选中的值 + 曲目 qualities
    const toneProbe = await win.webContents.executeJavaScript(`(async () => {
      const sel = document.getElementById('selQuality');
      const cur = S.queue[S.qIndex];
      return JSON.stringify({
        song: cur ? cur.name : '',
        qualities: cur ? (cur.qualities || []) : [],
        options: sel ? Array.from(sel.options).map(o => o.value + ':' + o.textContent) : 'no select',
        selected: sel ? sel.value : '',
      });
    })()`);
    log('[selftest:tones]', toneProbe);
    const shotTone = await win.webContents.capturePage();
    fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_tone.png'), shotTone.toPNG());
    await win.webContents.executeJavaScript("go('singerDetail',{id:'112',name:'周杰伦'})");
    await wait(5000);
    log('[selftest:singer]', await win.webContents.executeJavaScript(probe));
    await win.webContents.executeJavaScript("go('playlist',{id:'225068708'})");
    await wait(6000);
    log('[selftest:playlist]', await win.webContents.executeJavaScript(probe));
    await win.webContents.executeJavaScript("go('album',{id:'600927015009001083'})");
    await wait(5000);
    log('[selftest:album]', await win.webContents.executeJavaScript(probe));
    await win.webContents.executeJavaScript("go('home',{})");
    await wait(2500);
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_home.png'), shot.toPNG());
    await win.webContents.executeJavaScript("go('column',{id:'83176390'})");
    await wait(3500);
    const shot2 = await win.webContents.capturePage();
    fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_column.png'), shot2.toPNG());
    await meStep();
    log('[selftest:done]');
  } catch (e) {
    log('[selftest:err]', String(e && e.stack || e));
  } finally {
    setTimeout(() => app.quit(), 500);
  }
}

/** 个人中心探针（支持 MIGU_SELFTEST=me 单独跑） */
async function meStep() {
  const LOG = path.join(app.getPath('temp'), 'migu-selftest.log');
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await win.webContents.executeJavaScript("go('me',{})").catch(() => {});
  await wait(5000);
  const meProbe = await win.webContents.executeJavaScript(`(async () => {
    const qr = document.querySelector('.me-qr');
    const a = accountView();
    const badges = Array.from(document.querySelectorAll('.me-badge')).map(e => e.textContent);
    return JSON.stringify({
      qrPanel: !!qr,
      nick: a.nick, memName: a.memName, isVip: a.isVip, isTrial: a.isTrial,
      expire: a.expire, levelName: a.levelName, credit: a.credit,
      badges,
      identities: (a.identities || []).map(i => i.name + (i.trial ? '(体验)' : '')),
      rightsOn: Array.from(document.querySelectorAll('.me-right.on .dot')).map(e => e.textContent).slice(0, 12),
      rightsTotal: document.querySelectorAll('.me-right').length,
      quality: a.tonePref || S.quality,
      viewText: document.getElementById('view').innerText.slice(0, 300).split(String.fromCharCode(10)).join(' '),
    });
  })()`);
  log('[selftest:me]', meProbe);
  const shotMe = await win.webContents.capturePage();
  fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_me.png'), shotMe.toPNG());
}

/** 只验证「用手机号登录」按钮能把 passport 登录窗拉起来（MIGU_SELFTEST=login） */
async function runLoginOnly() {
  const LOG = path.join(app.getPath('temp'), 'migu-selftest.log');
  try { fs.writeFileSync(LOG, 'start(login-only) ' + new Date().toISOString() + '\n'); } catch (e) {}
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(6000);
    // 只在渲染层伪装未登录，点真实按钮，验证按钮与主进程 IPC 的接线
    await win.webContents.executeJavaScript(
      'S.auth = null; S.account = null; paintAccount(); go("me", {}, true);'
    ).catch(() => {});
    await wait(2000);
    win.webContents.on('console-message', (e, lv, msg) => { if (lv >= 2) log('[renderer:console]', msg); });
    const clicked = await win.webContents.executeJavaScript(
      '(() => { const b = document.getElementById("meLogin"); if (!b) return "no-btn"; b.click(); return "clicked"; })()'
    ).catch((e) => 'ERR ' + e.message);
    log('[selftest:login:click]', clicked);
    for (let i = 0; i < 9; i++) {
      await wait(1000);
      const ws = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
      log('[selftest:login:poll]', i, 'wins=' + ws.length, ws.map((w) => w.getTitle()).join('|'));
    }
    const wins = BrowserWindow.getAllWindows();
    const lw = wins.find((w) => w !== win && !w.isDestroyed());
    if (!lw) { log('[selftest:login]', 'NO_WINDOW'); }
    else {
      const info = await lw.webContents.executeJavaScript(
        'JSON.stringify({ title: document.title, url: location.href.slice(0, 200), text: document.body.innerText.slice(0, 180).split(String.fromCharCode(10)).join(" ") })'
      ).catch((e) => 'ERR ' + e.message);
      log('[selftest:login]', info);

      // passport 页面自己能不能拿到 RSA 公钥 —— 短信登录必须过这一关。
      // 之前用 node 直连是 302，但在页面里带着同源 cookie 可能完全正常，
      // 这里在页面上下文里实测，别靠猜测。
      try {
        const pk = await lw.webContents.executeJavaScript(
          '(async () => { try {' +
          ' const r = await fetch("https://passport.migu.cn/password/publickey?_=" + Date.now(), { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } });' +
          ' const t = await r.text();' +
          ' return JSON.stringify({ status: r.status, ok: r.ok, ct: r.headers.get("content-type") || "", body: t.slice(0, 140) });' +
          '} catch (e) { return JSON.stringify({ err: String(e && e.message) }); } })()', true);
        log('[selftest:login:pubkey]', pk);
      } catch (e) { log('[selftest:login:pubkey-err]', String(e && e.message)); }

      // 页面表单结构 + 页面自己走 RSA 公钥这条路会拿到什么（只取公钥，不发短信）
      try {
        const dom = await lw.webContents.executeJavaScript(
          'JSON.stringify((function(){ var q=function(s){return document.querySelector(s)};' +
          ' var f=q("#J_ValidOneForm")||q(".J_ValidOneForm");' +
          ' return { hasForm: !!f, rsaUrl: f?String(f.getAttribute("cmcc-rsaAjax")):"",' +
          '  pollUrl: f?String(f.getAttribute("cmcc-pollAjax")):"", msgUrl: f?String(f.getAttribute("cmcc-msgAjax")):"" ,' +
          '  phoneInputs: document.querySelectorAll("input").length,' +
          '  ids: Array.prototype.slice.call(document.querySelectorAll("input,button")).slice(0,14).map(function(e){return e.id||e.name||e.className}).join(",") };' +
          '})())', true);
        log('[selftest:login:form]', dom);
      } catch (e) { log('[selftest:login:form-err]', String(e && e.message)); }

      try {
        const rsa = await lw.webContents.executeJavaScript(
          'new Promise(function(res){' +
          ' try{ var f=document.querySelector(".J_ValidOneForm")||document.querySelector("#J_ValidOneForm");' +
          '  var u=f?f.getAttribute("cmcc-rsaAjax"):"";' +
          '  if(!u){res(JSON.stringify({skip:"no-url"}));return;}' +
          '  jQuery.ajax({url:u, dataType:"json", timeout:8000,' +
          '   success:function(b){res(JSON.stringify({ok:true, status:b&&b.status, keys:b&&b.result?Object.keys(b.result):[], modLen:b&&b.result&&b.result.modulus?String(b.result.modulus).length:0}));},' +
          '   error:function(x,s){res(JSON.stringify({ok:false, http:x.status, state:s}));}});' +
          ' }catch(e){res("ERR "+e.message)} })', true);
        log('[selftest:login:rsa]', rsa);
      } catch (e) { log('[selftest:login:rsa-err]', String(e && e.message)); }

      const shot = await lw.webContents.capturePage();
      fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_login.png'), shot.toPNG());
      // 关掉登录窗，避免下一次启动残留
      try { lw.close(); } catch (e) {}
    }
    log('[selftest:done]');
  } catch (e) {
    log('[selftest:err]', String((e && e.stack) || e));
  } finally {
    setTimeout(() => app.quit(), 800);
  }
}

/**
 * 登录抓 token 通道自检（MIGU_SELFTEST=hooktest）。
 *
 * 不碰真实登录：起一个本地 HTTP 服务当「假 passport」，页面里用 XHR 与 fetch 各发一次
 * 带 token 的响应，验证注入的钩子与 CDP 网络层能不能把 token 抠出来。
 * 这是登录链路里最容易悄悄失效的一环，所以单独留一条能反复跑的回归。
 */
async function runHookTest() {
  const LOG = path.join(app.getPath('temp'), 'migu-selftest.log');
  try { fs.writeFileSync(LOG, 'start(hooktest) ' + new Date().toISOString() + '\n'); } catch (e) {}
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const http = require('http');
  const PAGE = '<!doctype html><meta charset="utf-8"><title>fake</title><body>' +
    '<script>' +
    'window.fire = function(useFetch){' +
    '  if(useFetch){fetch("/api/t?f=1").then(function(r){return r.text();}).then(function(){document.title="fetch-done";});}' +
    '  else{var x=new XMLHttpRequest();x.open("GET","/api/t?x=1");x.onload=function(){document.title="xhr-done";};x.send();}' +
    '};' +
    '</script></body>';
  const srv = http.createServer((req, res) => {
    if (req.url.indexOf('/api/t') === 0) {
      const tag = (req.url.split('=')[1] || 'x').toUpperCase();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 2000, result: {
        token: 'FAKE_' + tag, redirectURL: 'https://passport.migu.cn/x',
        userId: 'FAKE_UID', msisdn: 'FAKE_MSISDN' } }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    }
  });
  let port = 0;
  try {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    port = srv.address().port;
    log('[hooktest:server]', port);
    const hw = new BrowserWindow({ width: 700, height: 500, show: false, webPreferences: {
      contextIsolation: true, nodeIntegration: false } });
    const wc = hw.webContents;
    const pageHits = [];
    const cdpHits = [];
    const inject = () => {
      if (hw.isDestroyed()) return;
      wc.executeJavaScript(LOGIN_HOOK, true).then((r) => log('[hooktest:inject]', r)).catch((e) => log('[hooktest:inject-err]', String(e && e.message)));
    };
    wc.on('dom-ready', inject);
    wc.on('did-finish-load', inject);
    try {
      const dbg = wc.debugger;
      dbg.attach('1.3');
      dbg.sendCommand('Network.enable').catch(() => {});
      dbg.on('message', async (event, method, params) => {
        if (method !== 'Network.responseReceived') return;
        const url = String((params.response && params.response.url) || '');
        if (url.indexOf('/api/t') < 0) return;
        try {
          const b = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          const text = b.base64Encoded ? Buffer.from(b.body || '', 'base64').toString('utf8') : String(b.body || '');
          const m = /"token"\s*:\s*"([^"]+)"/.exec(text);
          if (m) cdpHits.push(m[1]);
        } catch (e) { log('[hooktest:cdp-err]', String(e && e.message)); }
      });
      log('[hooktest:cdp] attached');
    } catch (e) { log('[hooktest:cdp-err]', String(e && e.message)); }

    await hw.loadURL('http://127.0.0.1:' + port + '/');
    await wait(600);
    await wc.executeJavaScript('fire(false)', true).catch((e) => log('[hooktest:xhr-err]', String(e && e.message)));
    await wait(900);
    const h1 = await wc.executeJavaScript('window.__miguToken || null', true).catch(() => null);
    if (h1 && h1.token) pageHits.push(h1.token);
    log('[hooktest:after-xhr]', JSON.stringify(h1));
    await wc.executeJavaScript('fire(true)', true).catch((e) => log('[hooktest:fetch-err]', String(e && e.message)));
    await wait(900);
    const h2 = await wc.executeJavaScript('window.__miguToken || null', true).catch(() => null);
    if (h2 && h2.token) pageHits.push(h2.token);
    log('[hooktest:after-fetch]', JSON.stringify(h2));
    log('[hooktest:result]', JSON.stringify({ pageHits, cdpHits }));
    try { hw.destroy(); } catch (e) {}
  } catch (e) {
    log('[hooktest:err]', String((e && e.stack) || e));
  } finally {
    try { srv.close(); } catch (e) {}
    log('[selftest:done]');
    setTimeout(() => app.quit(), 400);
  }
}

/** 只验证「未登录」个人中心外观（MIGU_SELFTEST=logout）：只在渲染层临时清空，不动磁盘登录态 */
async function runLogoutOnly() {
  const LOG = path.join(app.getPath('temp'), 'migu-selftest.log');
  try { fs.writeFileSync(LOG, 'start(logout-only) ' + new Date().toISOString() + '\n'); } catch (e) {}
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(6000);
    await win.webContents.executeJavaScript(
      'S.auth = null; S.account = null; paintAccount(); go("me", {}, true);'
    ).catch(() => {});
    await wait(2500);
    const probe = await win.webContents.executeJavaScript(`(async () => {
      const q = (s) => document.querySelector(s);
      // 短信表单桥接自检：用非法号码（不会发网络请求）验证 IPC 通
      let bridge = 'no-M';
      try {
        if (window.migu && window.migu.smsSend) {
          const r = await window.migu.smsSend('123');
          bridge = r ? (r.ok + '|' + (r.error || '')) : 'null';
        }
      } catch (e) { bridge = 'ERR ' + (e && e.message); }
      return JSON.stringify({
        hasPhone: !!q('#smsPhone'),
        hasCode: !!q('#smsCode'),
        hasSend: !!q('#smsSend'),
        sendText: q('#smsSend') ? q('#smsSend').textContent : '',
        hasGo: !!q('#smsGo'),
        goText: q('#smsGo') ? q('#smsGo').textContent : '',
        hasWebLogin: !!q('#meLogin'),
        webLoginText: q('#meLogin') ? q('#meLogin').textContent : '',
        hasNote: !!q('.me-note'),
        hasQr: !!q('#qrZone'),
        bridge,
        text: document.getElementById('view').innerText.slice(0, 240).split(String.fromCharCode(10)).join(' '),
      });
    })()`);
    log('[selftest:logout]', probe);
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_logout.png'), shot.toPNG());
    log('[selftest:done]');
  } catch (e) {
    log('[selftest:err]', String((e && e.stack) || e));
  } finally {
    setTimeout(() => app.quit(), 500);
  }
}

/** 只跑「我的收藏」（MIGU_SELFTEST=fav）：验证收藏是否真的跟着账号走 */
async function runFavOnly() {
  const LOG = path.join(app.getPath('temp'), 'migu-selftest.log');
  try { fs.writeFileSync(LOG, 'start(fav-only) ' + new Date().toISOString() + '\n'); } catch (e) {}
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(6000);
    // 未登录态
    await win.webContents.executeJavaScript('S.auth = null; S.account = null; paintAccount(); go("favorite", {}, true);').catch(() => {});
    await wait(2000);
    const out1 = await win.webContents.executeJavaScript(`(async () => {
      const q = (s) => document.querySelector(s);
      return JSON.stringify({
        guest: !!q('.fav-guest'),
        title: q('.fav-guest-t') ? q('.fav-guest-t').textContent : '',
        hasLogin: !!q('#favLogin'),
        rows: document.querySelectorAll('[data-tbl] tbody tr').length,
        sub: q('.view-sub') ? q('.view-sub').textContent : '',
      });
    })()`);
    log('[selftest:fav:logged-out]', out1);
    const s1 = await win.webContents.capturePage();
    fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_fav_out.png'), s1.toPNG());

    // 安装态：直接调 IPC 看接口层真实返回（未登录时应 needLogin）
    const apiProbe = await win.webContents.executeJavaScript(`(async () => {
      const r = await window.migu.favorites();
      return JSON.stringify({ ok: r && r.ok, needLogin: r && r.data && r.data.needLogin, songs: r && r.data && (r.data.songs || []).length, error: r && (r.error || (r.data && r.data.error)) });
    })()`);
    log('[selftest:fav:ipc]', apiProbe);

    // 登录态：直接走真账号的「我喜欢的」
    await win.webContents.executeJavaScript('(async()=>{await refreshAuth(); await refreshFavorites({silent:true}); go("favorite",{},true);})()').catch((e) => log('[selftest:fav:relogin-err]', String(e && e.message)));
    await wait(3500);
    const out2 = await win.webContents.executeJavaScript(`(async () => {
      const q = (s) => document.querySelector(s);
      const rows = Array.from(document.querySelectorAll('[data-tbl] tbody tr')).map((tr) => tr.innerText.split(String.fromCharCode(9)).join('|').slice(0, 60));
      return JSON.stringify({
        loggedIn: !!S.auth,
        sub: q('.view-sub') ? q('.view-sub').textContent : '',
        rows: rows.length,
        first: rows.slice(0, 3),
        favBtnCol: document.querySelectorAll('.row-fav').length,
        favLoaded: S.favLoaded,
        err: S.favError,
      });
    })()`);
    log('[selftest:fav:logged-in]', out2);
    const s2 = await win.webContents.capturePage();
    fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_fav_in.png'), s2.toPNG());

    log('[selftest:done]');
  } catch (e) {
    log('[selftest:err]', String((e && e.stack) || e));
  } finally {
    setTimeout(() => app.quit(), 500);
  }
}

/** 只跑个人中心（MIGU_SELFTEST=me）：改个人中心时不必等完整回归 */
async function runMeOnly() {
  const LOG = path.join(app.getPath('temp'), 'migu-selftest.log');
  try { fs.writeFileSync(LOG, 'start(me-only) ' + new Date().toISOString() + '\n'); } catch (e) {}
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  try {
    await new Promise((r) => setTimeout(r, 6000));
    await meStep();
    log('[selftest:done]');
  } catch (e) {
    log('[selftest:err]', String((e && e.stack) || e));
  } finally {
    setTimeout(() => app.quit(), 500);
  }
}

/**
 * 音质探针（MIGU_SELFTEST=tone）：验证三件事
 * ① 选高档位后真的能出声（不再只停在「无损」）
 * ② 源不会自己反复重取（「一直在唤起播放」的回归闸）
 * ③ WAV 档位自动降档只发生一次
 */
async function runToneOnly() {
  const LOG = path.join(app.getPath('temp'), 'migu-selftest.log');
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try { fs.writeFileSync(LOG, 'start(tone) ' + new Date().toISOString() + '\n'); } catch (e) {}
  try {
    await wait(6500);
    // 自检一律静音：验证音质不代表要把歌外放给用户听（「一直在唤起播放」的观感来源之一）
    await win.webContents.executeJavaScript('audio.muted = true; "muted"').catch(() => {});
    // 0) 原生内核在 Electron 里到底通不通（Node 直跑通过不代表这段可用）
    const pdiag = await win.webContents.executeJavaScript(`(async () => {
      const out = { hasM: !!(M && M.player), errs: (window.__errs||[]).slice(0,6) };
      try { out.avail = await M.player.available(); } catch (e) { out.availErr = String(e.message || e); }
      try { out.state = await M.player.state(); } catch (e) { out.stateErr = String(e.message || e); }
      return JSON.stringify(out);
    })()`).catch((e) => 'PROBE_ERR ' + e.message);
    log('[selftest:player]', pdiag);
    // 用「泡沫」这首有 ZQ24/ZQ/Z3D 全档位的歌
    await win.webContents.executeJavaScript(
      "(async () => { const r = await call(M.search('泡沫 邓紫棋','song',1,5));"
      + " const s = (r.list||[]).find(x => (x.qualities||[]).length >= 5) || r.list[0];"
      + " playQueue([s], 0); return s.name; })()"
    ).then((n) => log('[selftest:tone] picked', n)).catch((e) => log('[selftest:toneErr]', String(e)));
    await wait(4000);
    // 拨到 40 秒再换档，才能验证「换音质不回到 0」
    await win.webContents.executeJavaScript('(async () => { try { audio.currentTime = 40; } catch (e) {} await new Promise(r => setTimeout(r, 1200)); return audio.currentTime; })()').catch(() => {});
    for (const tone of ['ZQ', 'ZQ24', 'SQ']) {
      const probe = await win.webContents.executeJavaScript(`(async () => {
        const sel = document.getElementById('selQuality');
        const tBefore = Number(audio.currentTime.toFixed(1));
        const wasPlaying = !audio.paused;
        const evs = [];
        const t0e = Date.now();
        const onP = () => evs.push('play@' + (Date.now() - t0e));
        const onPa = () => evs.push('pause@' + (Date.now() - t0e));
        audio.addEventListener('play', onP);
        audio.addEventListener('pause', onPa);
        window.__toneEvs = evs;
        sel.value = '${tone}';
        sel.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 2600));
        const srcs = [];
        const t0 = Date.now();
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 900));
          const s = (audio.src || '').split('?')[0].slice(-18);
          if (!srcs.length || srcs[srcs.length - 1].src !== s) srcs.push({ src: s, t: Math.round((Date.now() - t0) / 100) });
        }
        return JSON.stringify({
          want: '${tone}', requested: S.quality, force: S.toneForce[S.queue[S.qIndex].contentId] || '', selVal: sel.value,
          actualTone: (S.lastTone || ''), dur: audio.duration, t: Number(audio.currentTime.toFixed(1)),
          readyState: audio.readyState, paused: audio.paused,
          srcChanges: srcs.length, srcs: srcs.map(x => x.t + 'ms:' + x.src),
          selectValue: (document.getElementById('selQuality') || {}).value || '',
          tBefore, wasPlaying,
          seekKept: Number(audio.currentTime.toFixed(1)) >= tBefore - 1.5,
          evs: evs,
          pauseStampAge: S.pauseStamp ? (Date.now() - S.pauseStamp) : -1,
        });
      })()`);
      log('[selftest:tone:' + tone + ']', probe);
    }
    // 回归闸：用户手动暂停后，看门狗不许把它当成「加载失败」重新唤起播放
    const pauseProbe = await win.webContents.executeJavaScript(`(async () => {
      const before = (audio.src || '').split('?')[0];
      const tBefore = audio.currentTime;
      // 抓「谁把它重新 play 起来」：包装一次 play，记下调用栈
      const calls = [];
      const clicks = [];
      const origPlay = audio.play.bind(audio);
      audio.play = function () { calls.push((new Error()).stack.split(String.fromCharCode(10)).slice(1, 6).join(' | ')); return origPlay(); };
      document.addEventListener('click', (ev) => { clicks.push('CLICK ' + (ev.target && (ev.target.id || ev.target.className || ev.target.tagName)) + ' trusted=' + ev.isTrusted); }, true);
      document.addEventListener('keydown', (ev) => { clicks.push('KEY ' + ev.code + ' trusted=' + ev.isTrusted + ' tgt=' + (ev.target && ev.target.tagName)); }, true);
      const bp = document.getElementById('btnPlay');
      const origBp = bp.onclick;
      bp.onclick = function (ev) { clicks.push('BTNPLAY onclick trusted=' + (ev && ev.isTrusted)); return origBp.apply(this, arguments); };
      const tStart = Date.now();
      const evs = [];
      ['play', 'pause', 'playing', 'waiting', 'loadstart', 'emptied', 'error'].forEach((n) => {
        audio.addEventListener(n, () => evs.push(n + '@' + (Date.now() - tStart)));
      });
      const tok0 = S.loadToken;
      audio.pause();
      const loads = [];
      const t0 = Date.now();
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 900));
        loads.push([Math.round((Date.now() - t0) / 100), audio.paused ? 1 : 0, Number(audio.currentTime.toFixed(1))]);
      }
      return JSON.stringify({
        srcSame: (audio.src || '').split('?')[0] === before,
        tBefore: Number(tBefore.toFixed(1)),
        stillPaused: audio.paused,
        tAfter: Number(audio.currentTime.toFixed(1)),
        samples: loads,
        playCalls: calls,
        events: clicks,
        audioEvs: evs,
        tokChanged: S.loadToken !== tok0,
        route: S.curRoute,
        playing: S.playing,
      });
    })()`);
    log('[selftest:pause]', pauseProbe);
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_tone.png'), shot.toPNG());
    log('[selftest:done]');
  } catch (e) {
    log('[selftest:err]', String((e && e.stack) || e));
  } finally {
    setTimeout(() => app.quit(), 500);
  }
}

/**
 * 出声探针（MIGU_SELFTEST=sound）：只验证「真的有声音」。
 * 与其它自检不同，这一档刻意不静音——之前给全部自检加 audio.muted=true，
 * 虽然验证了流程，却也把「有没有声音」这件事一起遮掉了。
 */
async function runSoundOnly() {
  const LOG = path.join(app.getPath('temp'), 'migu-selftest.log');
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try { fs.writeFileSync(LOG, 'start(sound) ' + new Date().toISOString() + '\n'); } catch (e) {}
  try {
    await wait(6500);
    const r = await win.webContents.executeJavaScript(`(async () => {
      audio.muted = false;
      audio.volume = 0.9;
      // 抓「谁按了暂停」：包装 audio.pause 与 M.player.pause，记调用栈
      const pauseCalls = [];
      const op = audio.pause.bind(audio);
      audio.pause = function () { pauseCalls.push('JS:' + (new Error()).stack.split(String.fromCharCode(10)).slice(1, 4).join(' | ')); return op(); };
      const omp = M.player.pause;
      M.player.pause = function () { pauseCalls.push('IPC:' + (new Error()).stack.split(String.fromCharCode(10)).slice(1, 4).join(' | ')); return omp.apply(M.player, arguments); };
      const evlog = [];
      const t0 = Date.now();
      if (M.player.onEvent) M.player.onEvent((ev) => { if (ev.type === 'state' || ev.type === 'end' || ev.type === 'error') evlog.push((Date.now() - t0) + ':' + ev.type + ':' + JSON.stringify(ev).slice(0, 120)); });
      const after = await call(M.search('倔强 五月天','song',1,5));
      const s = (after.list||[])[0];
      playQueue([s], 0);
      const samples = [];
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 1200));
        samples.push({ t: Number(audio.currentTime.toFixed(1)), paused: audio.paused, rs: audio.readyState });
      }
      let nstate = null;
      try { nstate = await M.player.state(); } catch (e) { nstate = { err: String(e.message||e) }; }
      return JSON.stringify({ song: s && s.name, samples, nstate, pauseCalls, evlog: evlog.slice(0, 12), errs: (window.__errs||[]).slice(0,5) });
    })()`);
    log('[selftest:sound]', r);
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(require('path').join(require('os').tmpdir(), '_shot_sound.png'), shot.toPNG());
    log('[selftest:done]');
  } catch (e) {
    log('[selftest:err]', String((e && e.stack) || e));
  } finally {
    setTimeout(() => app.quit(), 500);
  }
}
/* ───────── 启动 ───────── */
app.setAppUserModelId('cn.migu.music.desktop');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

/* ───────── 轻量自检 MIGU_SELFTEST=lx：只验歌词层，不播放、不登录 ───────── */
async function runLxOnly() {
  const LOG = path.join(app.getPath('temp'), 'migu-lx-selftest.log');
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
    console.log(line);
  };
  try { fs.writeFileSync(LOG, 'lx selftest ' + new Date().toISOString() + '\n'); } catch (e) {}
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2600);
  try {
    const bootProbe = [
      '(function(){',
      '  var lx = window.LatticeLyrics;',
      '  var out = { lx: !!lx, stage: !!document.querySelector(".lx-stage"),',
      '    css: Array.from(document.styleSheets).some(function(s){ return String(s.href||"").indexOf("lattice-lyrics") >= 0; }),',
      '    errs: (window.__errs||[]).slice(0,6) };',
      '  if (lx) {',
      '    lx.setTrack({ name: "夜行列车", singer: "测试歌手", duration: 180 });',
      '    lx.setLyric([',
      '      { t: 0.5, txt: "夜色漫过城市的边缘" },',
      '      { t: 5.2, txt: "我们还在唱那首老歌" },',
      '      { t: 10.0, txt: "风吹散了所有的对白" },',
      '      { t: 14.6, txt: "却吹不散你眼里的光", glyphT: [14.60,14.92,15.24,15.56,15.88,16.20,16.52,16.84,17.16] },',
      '      { t: 19.4, txt: "时间在指尖慢慢流淌" },',
      '      { t: 24.0, txt: "像一条没有尽头的河" }',
      '    ]);',
      '    lx.open(); lx.setTime(15.3);',
      '  }',
      '  return JSON.stringify(out);',
      '})()'
    ].join('\n');
    log('[lx:boot]', await win.webContents.executeJavaScript(bootProbe));
    await wait(700);
    const litProbe = [
      '(function(){',
      '  var a = document.querySelector(".lx-line.active");',
      '  return JSON.stringify({',
      '    open: !!(window.LatticeLyrics && window.LatticeLyrics.isOpen()),',
      '    active: a ? a.textContent.slice(0,10) : null,',
      '    lit: a ? a.querySelectorAll(".lx-g.lit").length : -1,',
      '    all: a ? a.querySelectorAll(".lx-g").length : -1,',
      '    errs: (window.__errs||[]).slice(0,6)',
      '  });',
      '})()'
    ].join('\n');
    log('[lx:lyric]', await win.webContents.executeJavaScript(litProbe));
    log('[lx:done]');
  } catch (e) { log('[lx:err]', String((e && e.stack) || e)); }
  app.exit(0);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  loadAuth();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  const st = process.env.MIGU_SELFTEST;
  if (st === 'me') runMeOnly();
    else if (st === 'fav') runFavOnly();
  else if (st === 'logout') runLogoutOnly();
  else if (st === 'login') runLoginOnly();
  else if (st === 'hooktest') runHookTest();
  else if (st === 'tone') runToneOnly();
  else if (st === 'sound') runSoundOnly();
  else if (st === 'native') runNativeOnly();
  else if (st === 'lx') runLxOnly();
  else if (st) runSelfTest();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
