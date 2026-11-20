'use strict';
/* 咪咕音乐 桌面版 —— 渲染层 */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const M = window.migu;

/* ─────────────── 全局状态 ─────────────── */
const S = {
  queue: [],          // [{contentId,copyrightId,songId,name,singer,album,img,duration,vip,...}]
  qIndex: -1,
  playing: false,
  loop: 'list',       // list | one | shuffle
  quality: 'PQ',
  volume: 0.8,
  muted: false,
  lyric: [],          // [{t, txt}]
  lyricIdx: -1,
  favorite: [],       // 云端「我喜欢的」歌单缓存（登录后才有）
  favIds: {},         // contentId -> true，快速判断红心状态
  favLoading: false,
  favError: '',
  favLoaded: false,   // 是否已成功拉过一次云端收藏
  recent: [],
  auth: null,        // 主进程给的登录凭证 {pacmtoken,uid,msisdn,sid,...}
  account: null,     // 完整账号资料 {auth,profile,vip}
  curRoute: '',
  history: [],
  hIndex: -1,
  bannerTimer: null,
  blocked: null,      // 当前不可播的 {song, info}
  blockedRun: 0,      // 连续不可播计数（防打转）
  skipBlocked: true,  // 不可播时自动跳下一首
  skipTimer: null,
  keepTip: false,     // 自动跳过时提示条不随新曲成功而消失
  vtUrl: '',          // 提示条「去开通/去购买」跳转地址
  toneForce: {},      // contentId -> 因设备解不了而降到的音质
  canMap: {},         // contentId -> {canListen, limitLength}
  pauseStamp: 0,      // 用户最后一次按暂停的时刻（防止降档重取把播放拉起来）
  seekTo: 0,          // 换源后要恢复的播放进度（换音质不该从头开始）
  loadToken: 0,
};

/* ─────────────── 工具 ─────────────── */
const fmt = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(n);
};

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function loadingHTML() {
  return '<div class="loading"><div class="spin"></div><span>加载中…</span></div>';
}
function emptyHTML(msg) {
  return '<div class="empty"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg><span>' + esc(msg || '这里什么都没有') + '</span></div>';
}
function imgTag(src, alt) {
  if (!src) return '<div style="width:100%;height:100%;background:linear-gradient(135deg,#242433,#1a1a26)"></div>';
  return '<img loading="lazy" src="' + esc(src) + '" alt="' + esc(alt || '') + '">';
}
/* CSP 下不能用内联 onerror，统一在捕获阶段兜底 */
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG') { t.style.opacity = '0'; }
}, true);

/* ─────────────── 导航 ─────────────── */
const ROUTES = {};
function go(route, params, replace) {
  const key = route;
  if (!ROUTES[key]) { console.warn('no route', key); return; }
  if (!replace) {
    S.history = S.history.slice(0, S.hIndex + 1);
    S.history.push({ route: key, params: params || {} });
    S.hIndex = S.history.length - 1;
  }
  S.curRoute = key;
  if (key !== 'me') stopQr();   // 离开个人中心就停掉验证码倒计时
  render(ROUTES[key], params || {});
  $$('.side-item').forEach((a) => a.classList.toggle('active', a.dataset.view === key));
  if (!$('.side-item[data-view="me"]')) { /* me 不在侧栏，靠账号条 */ }
}
function back() {
  if (S.hIndex <= 0) return;
  S.hIndex--;
  const h = S.history[S.hIndex];
  S.curRoute = h.route;
  if (h.route !== 'me') stopQr();
  render(ROUTES[h.route], h.params);
  $$('.side-item').forEach((a) => a.classList.toggle('active', a.dataset.view === h.route));
}
function fwd() {
  if (S.hIndex >= S.history.length - 1) return;
  S.hIndex++;
  const h = S.history[S.hIndex];
  S.curRoute = h.route;
  if (h.route !== 'me') stopQr();
  render(ROUTES[h.route], h.params);
  $$('.side-item').forEach((a) => a.classList.toggle('active', a.dataset.view === h.route));
}
async function render(fn, params) {
  const view = $('#view');
  view.scrollTop = 0;
  view.classList.remove('is-home');
  document.body.classList.remove('home-mode');
  closeAllPanels();
  try {
    await fn(view, params);
  } catch (e) {
    console.error(e);
    view.innerHTML = emptyHTML('加载失败：' + (e && e.message ? e.message : e));
  }
}

/** 统一取接口结果 */
async function call(promise) {
  const r = await promise;
  if (!r) throw new Error('无响应');
  if (r.ok === false) throw new Error(r.error || '请求失败');
  return r.data;
}

/* ── 沉浸歌词桥接（lattice-lyrics.js） ── */
const LX = () => window.LatticeLyrics;
function syncLatticeLyric() {
  const lx = LX();
  if (!lx) return;
  lx.setLyric(S.lyric.map((l) => ({ t: l.t, txt: l.txt, glyphT: l.glyphT || null })));
  if (S.lyric.length) lx.setTime(audio.currentTime || 0);
}

/* ── 逐字歌词解析：增强 LRC（<mm:ss.xx>字） / QRC / MRC（<ms,dur>） ──
   输出 S.lyric[i].glyphT = 每个 token 的起唱绝对秒；拿不到逐字源时
   lattice-lyrics.js 会按字宽+语速权重自行分配，最后才退回均分。 */
const TOKEN_RE_LX = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]|[^\s\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+|\s+/g;
function splitTokensLX(text) {
  const out = []; let m;
  TOKEN_RE_LX.lastIndex = 0;
  while ((m = TOKEN_RE_LX.exec(text))) out.push(m[0]);
  return out.length ? out : [text];
}
function secOf(mm, ss, frac) {
  return Number(mm) * 60 + Number(ss) +
    (frac ? Number(frac) / (frac.length === 3 ? 1000 : frac.length === 2 ? 100 : 10) : 0);
}
const WORD_TAG_RE_LX = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>|<(\d+),(\d+)>/g;
function wordTimesOf(rest) {
  const out = []; let m;
  WORD_TAG_RE_LX.lastIndex = 0;
  while ((m = WORD_TAG_RE_LX.exec(rest))) {
    out.push(m[1] !== undefined ? secOf(m[1], m[2], m[3]) : Number(m[4]) / 1000);
  }
  return out;
}
function stripWordTags(rest) {
  return String(rest).replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, '')
    .replace(/<\d+,\d+>/g, '').trim();
}
function alignWordTimes(txt, times, rowT) {
  const toks = splitTokensLX(txt);
  const n = toks.length, out = new Array(n);
  let k = 0, prev = Number(rowT) || 0;
  for (let i = 0; i < n; i++) {
    if (/^\s+$/.test(toks[i])) { out[i] = prev; continue; }
    let t = k < times.length ? Number(times[k++]) : prev + 0.28;
    if (!(t > prev)) t = prev + 0.02;
    out[i] = t; prev = t;
  }
  return out;
}
/* MRC/QRC 单独一行行地给出逐字时间，按行首时间就近挂到 LRC 行 */
function parseWordLyric(mrc) {
  const src = String(mrc || '');
  if (!src) return [];
  const xml = /LyricContent\s*=\s*"([^"]*)"/i.exec(src);
  const body = xml ? xml[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : src;
  const rows = [];
  for (const raw of body.split(/\r?\n|<br\s*\/?>/i)) {
    const line = String(raw).trim();
    if (!line) continue;
    let rowT = null;
    const m1 = /^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(line);
    const m2 = /^\[(\d+),(\d+)\]/.exec(line);
    if (m1) rowT = secOf(m1[1], m1[2], m1[3]);
    else if (m2) rowT = Number(m2[1]) / 1000;
    const times = wordTimesOf(line);
    if (rowT === null && times.length) rowT = times[0];
    if (rowT === null || !times.length) continue;
    rows.push({ t: rowT, times: times });
  }
  return rows.sort((x, y) => x.t - y.t);
}

/* ─────────────── 歌曲表渲染 ─────────────── */
/**
 * @param songs 歌曲数组
 * @param opts  {startIndex, onPlay}
 */
function songTableHTML(songs, opts) {
  opts = opts || {};
  const favCol = !!opts.fav;
  const rows = songs.map((s, i) => {
    const vip = s.vip ? '<span class="tag-vip">VIP</span>' : '';
    return (
      '<tr data-i="' + i + '">' +
      '<td class="c-idx">' + String(i + 1).padStart(2, '0') + '</td>' +
      '<td><div class="c-name">' + imgTag(s.img, s.name) +
        '<div style="min-width:0"><div class="n-t">' + esc(s.name) + vip + '</div>' +
        '<div class="n-s">' + esc(s.album || '') + '</div></div></div></td>' +
      '<td class="c-artist">' + esc(s.singer || '') + '</td>' +
      '<td class="c-album">' + esc(s.album || '') + '</td>' +
      '<td class="c-dur">' + (s.duration ? fmt(s.duration) : '--:--') + '</td>' +
      (favCol ? '<td class="c-op"><button class="row-fav" data-fav="' + i + '" title="从「我喜欢的」移除">' +
        '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.7-9.3-9A5.2 5.2 0 0 1 12 6.6 5.2 5.2 0 0 1 21.3 12C19.5 16.3 12 21 12 21z"/></svg>' +
        '</button></td>' : '') +
      '</tr>'
    );
  }).join('');
  return (
    '<table class="songs' + (favCol ? ' has-fav' : '') + '" data-tbl>' +
    '<thead><tr><th class="c-idx">#</th><th>歌曲</th><th>歌手</th><th>专辑</th><th class="c-dur">时长</th>' +
    (favCol ? '<th class="c-op"></th>' : '') + '</tr></thead>' +
    '<tbody>' + rows + '</tbody></table>'
  );
}

/** 绑定表格点击：整表作为队列播放 */
function bindSongTable(container, songs, startIdx) {
  const tbl = container.querySelector('[data-tbl]');
  if (!tbl) return;
  tbl.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    playQueue(songs, Number(tr.dataset.i));
  });
  tbl.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    markRow(tbl, Number(tr.dataset.i));
  });
  if (startIdx !== undefined && startIdx >= 0) markRow(tbl, startIdx);
}
function markRow(tbl, idx) {
  $$('tr.playing', tbl).forEach((t) => t.classList.remove('playing'));
  const tr = tbl.querySelector('tr[data-i="' + idx + '"]');
  if (tr) tr.classList.add('playing');
}

/* ─────────────── 播放器 ─────────────── */
/**
 * 播放内核：native/echo-ffmpeg-player.node（Rust + FFmpeg + WASAPI）。
 *
 * 之前这里是 HTML5 <audio>，等于把解码交给 Chromium —— 它只认 RIFF/fLaC/MP3/Ogg/MP4，
 * 咪咕臻品档位下发的东西（几十 MB 的 3D WAV、伪装扩展名的容器）一律 readyState=0，
 * 表现就是进度条不动、反复重取。FFmpeg 认得这些，所以整条链路搬到主进程。
 *
 * 这里保留 audio 这个名字和一个同形 shim，让渲染层其余代码（进度条、歌词同步、
 * 音量、播放按钮）不用大改；events 由主进程推回来，再照原样派发。
 */
const P = {
  duration: 0,
  time: 0,
  playing: false,
  ready: false,
  src: '',
  volume: 0.8,
  loadP: Promise.resolve({ ok: true }),
};
const audioEvents = {};
function emitAudio(name, arg) {
  (audioEvents[name] || []).forEach((f) => { try { f(arg); } catch (e) { /* ignore */ } });
}
const audio = {
  get src() { return P.src; },
  set src(u) {
    P.src = String(u || '');
    P.time = 0;
    P.duration = 0;
    P.ready = false;
    P.loadP = M.player.load(P.src, false).then((r) => {
      if (r && r.ok) {
        P.ready = true;
        if (r.duration) P.duration = r.duration;
      }
      return r || { ok: false };
    }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  },
  get duration() { return P.duration; },
  get currentTime() { return P.time; },
  set currentTime(t) {
    P.time = Math.max(0, Number(t) || 0);
    const want = P.time;
    // 原生 seek 必须在装载完成后调用，否则会被丢掉
    P.loadP.then(() => M.player.seek(want)).catch(() => {});
  },
  get paused() { return !P.playing; },
  get readyState() { return P.ready ? (P.duration > 0 ? 4 : 2) : 0; },
  get volume() { return P.volume; },
  set volume(v) { P.volume = Number(v) || 0; M.player.volume(P.volume); },
  get muted() { return false; },
  set muted(m) { M.player.volume(m ? 0 : P.volume); },
  removeAttribute() { /* 原生内核没有 DOM 属性 */ },
  load() { /* src setter 里已经装载 */ },
  play() {
    return P.loadP.then((r) => {
      if (!r || !r.ok) throw new Error((r && r.error) || '装载失败');
      return M.player.play();
    }).then((r) => {
      if (r && r.ok === false) throw new Error(r.error || '播放失败');
      P.playing = true;
      return r;
    });
  },
  pause() {
    P.playing = false;
    return M.player.pause().catch(() => {});
  },
  addEventListener(name, cb) { (audioEvents[name] = audioEvents[name] || []).push(cb); },
};

/** 主进程推回来的播放事件 → 派发成 <audio> 同名事件，渲染层其余代码无感 */
M.player.onEvent((ev) => {
  if (!ev) return;
  if (ev.type === 'time') {
    P.time = Number(ev.t) || 0;
    emitAudio('timeupdate');
    return;
  }
  if (ev.type === 'duration') {
    if (ev.d > 0) P.duration = ev.d;
    return;
  }
  if (ev.type === 'state') {
    if (ev.duration > 0) P.duration = ev.duration;
    if (typeof ev.timePos === 'number' && ev.timePos > 0) P.time = ev.timePos;
    const was = P.playing;
    P.playing = !!ev.playing;
    if (P.playing && !was) { emitAudio('play'); emitAudio('playing'); }
    else if (!P.playing && was) emitAudio('pause');
    return;
  }
  if (ev.type === 'loaded') { P.ready = true; return; }
  if (ev.type === 'end') { P.playing = false; emitAudio('ended'); return; }
  if (ev.type === 'error') { emitAudio('error', ev); return; }
});

function saveRecent(song) {
  S.recent = [song].concat(S.recent.filter((x) => x.contentId !== song.contentId)).slice(0, 60);
  M.storeSet({ recent: S.recent });
}

function playQueue(songs, index) {
  if (!songs || !songs.length) return;
  S.blockedRun = 0;
  S.queue = songs.slice();
  S.qIndex = Math.max(0, Math.min(index || 0, songs.length - 1));
  loadCurrent(true);
  renderQueue();
  precheckQueue();
}

/** 后台探测整队列的可播性，把不可播的行标灰 */
async function precheckQueue() {
  const songs = S.queue;
  const ids = songs.map((s) => s.contentId).filter(Boolean);
  if (!ids.length) return;
  try {
    const map = await call(M.canListen(ids));
    Object.assign(S.canMap, map || {});
    const view = $('#view');
    $$('tr[data-i]', view).forEach((tr) => {
      const s = songs[Number(tr.dataset.i)];
      if (!s) return;
      const c = S.canMap[s.contentId];
      /* canListen 的 limitLength 在登录前后会整体翻转（未登录 true、登录后 false），
         拿它当判据会给出与实际可播性完全相反的结论。这里只认 canListen===false，
         其余一律先从宽，等真播放失败时由 loadCurrent 给行补上 unplay。 */
      const bad = c && c.canListen === false;
      tr.classList.toggle('unplay', !!bad);
      tr.title = bad ? (c.msg || '该歌曲需要会员或无版权') : '';
    });
  } catch (e) { /* ignore */ }
}

async function loadCurrent(autoplay) {
  const s = S.queue[S.qIndex];
  if (!s) return;
  $('#plTitle').textContent = s.name || '—';
  $('#plArtist').textContent = s.singer || '—';
  const cover = $('#plCoverImg');
  if (s.img) { cover.src = s.img; cover.classList.add('show'); } else { cover.classList.remove('show'); }
  $('#tDur').textContent = s.duration ? fmt(s.duration) : '00:00';
  $('#tCur').textContent = '00:00';
  renderQualityOptions(currentQualities());
  setSeek(0);
  S.lyric = []; S.lyricIdx = -1;
  if (LX()) { LX().setTrack(s); LX().setLyric([]); }
  $('#lpBody').innerHTML = '<p class="lp-name">' + esc(s.name) + '</p><p class="lp-artist">' + esc(s.singer) + '</p><p>歌词加载中…</p>';
  renderQueue();
  updateLikeBtn();
  saveRecent(s);

  clearToneWatch();
  const myToken = (S.loadToken = (S.loadToken || 0) + 1);
  const wantTone = S.toneForce[s.contentId] || S.quality;
  try {
    const r = await call(M.listen(s.contentId, s.copyrightId, wantTone));
    if (myToken !== S.loadToken) return; // 已经切到别的歌/别的音质，丢弃这次结果
    if (r.fellBack && !S.toneForce[s.contentId]) toast('已按「' + r.actualToneLabel + '」播放（' + toneLabel(r.requestedTone) + ' 不可用）');
    if (!r.url) {
      // VIP / 版权受限
      S.playing = false;
      updatePlayIcon();
      // 停掉上一首的音频，避免播放器还挂着旧曲进度
      try { audio.pause(); audio.removeAttribute('src'); audio.load(); M.player.stop(); } catch (e) { /* ignore */ }
      setSeek(0);
      $('#tCur').textContent = '00:00';
      S.blocked = { song: s, info: r };
      showVipTip(s, r);
      if (r.lrcUrl || r.mrcUrl) loadLyric(r.lrcUrl || '', r.mrcUrl || s.mrcUrl || '');
      // 自动跳过：整个队列都不可播时停下，避免打转
      S.blockedRun = (S.blockedRun || 0) + 1;
      if (S.skipBlocked && S.queue.length > 1 && S.blockedRun < S.queue.length) {
        clearTimeout(S.skipTimer);
        S.skipTimer = setTimeout(() => {
          if (!S.blocked || S.blocked.song !== s) return;
          // 自动跳过时把提示条留在屏幕上并向用户交代一句，否则用户只会看到「刚点的那首一闪而过」
          S.keepTip = true;
          const sub = $('#vtSub');
          if (sub && !/已自动跳过/.test(sub.textContent)) sub.textContent += ' · 已自动跳过';
          skipBlocked();
        }, 1400);
      }
      return;
    }
    // 以前这里按 .wav 后缀猜容器、提前降档 —— 换成 FFmpeg 内核后不需要了：
    // 3D WAV 和伪装扩展名的容器 FFmpeg 都能解，猜错反而会让用户听不到高音质。
    S.blocked = null;
    S.blockedRun = 0;
    // 因上一首不可播而自动跳过时，提示条继续留着解释原因
    if (S.keepTip) S.keepTip = false;
    else hideVipTip();
    audio.src = r.url;
    audio.volume = S.muted ? 0 : S.volume;
    // 换源后回到原进度（换音质不该让人从头听起）
    // 注意：这里不清 S.seekTo。降档链可能连续换两三次源（WAV → ZQ → SQ），
    // 一旦在第一次就清掉，后面几次就全从 0 开始，用户听到的就是「一直从头重放」。
    // 真正落到位（playing）时才清。
    if (S.seekTo) {
      const want = S.seekTo;
      P.loadP.then(() => { try { audio.currentTime = want; } catch (e) {} }).catch(() => {});
    }
    // 用户刚按过暂停：这次是换音质/降档引起的重取，不许把播放强行拉起来
    if (autoplay && S.pauseStamp && Date.now() - S.pauseStamp < 2500) autoplay = false;
    if (autoplay) {
      try { await audio.play(); S.playing = true; } catch (e) { S.playing = false; }
      updatePlayIcon();
    }
    S.lastTone = r.actualTone || '';
    armToneWatch(s, r);
    loadLyric(r.lrcUrl || s.lrcUrl || '', r.mrcUrl || s.mrcUrl || '');
  } catch (e) {
    toast('播放失败：' + (e && e.message ? e.message : e));
  }
}

/**
 * 高端音质的源文件未必能被 Chromium 解码：Z3D 给的是几十 MB 的 3D WAV（AV3A 同理），
 * 实测 audio.readyState 恒为 0、进度条不动。这里的看门狗在 7 秒内没真正出声就退一档重取，
 * 并给用户一句明确交代，别让人对着不动的进度条发呆。
 */
const TONE_FALLBACK = { AV3A: 'ZQ', ZQ32: 'ZQ', ZQ24: 'ZQ', Z3D: 'ZQ', ZQ: 'SQ', SQ: 'HQ', HQ: 'PQ' };
let toneWatch = null;
let toneCtx = null;
function clearToneWatch() { clearTimeout(toneWatch); toneWatch = null; toneCtx = null; }
function tryToneDown(why) {
  const ctx = toneCtx;
  if (!ctx) return;
  clearToneWatch();
  const next = TONE_FALLBACK[ctx.tone];
  if (!next) return;
  S.toneForce[ctx.song.contentId] = next;
  // 自动降档同样要「换源不换位置」：否则一降档就从头放，听感上就是「一直在重新开始」
  const t = audio.currentTime;
  if (t > 1) S.seekTo = t;
  toast('「' + toneLabel(ctx.tone) + '」' + (why || '无法播放') + '，已自动降到「' + toneLabel(next) + '」');
  loadCurrent(true);
}
function armToneWatch(song, info) {
  clearToneWatch();
  const tone = info && info.actualTone;
  if (!tone || !TONE_FALLBACK[tone]) return;
  toneCtx = { song, tone };
  // 原生内核装载是 Promise：装载失败立刻降档，比干等 7 秒准得多。
  // 仍然保留超时兜底 —— 网络卡死时 loadFile 可能长时间不返回。
  P.loadP.then((r) => {
    if (!r || !r.ok) {
      if (S.queue[S.qIndex] === song && toneCtx && toneCtx.song === song) tryToneDown('解码失败');
    }
  }).catch(() => {});
  toneWatch = setTimeout(() => {
    if (S.queue[S.qIndex] !== song) return;
    // 判据只能是「源根本没加载出来」。千万不能用 paused 判断——
    // 用户手动暂停时 paused 也是 true，那样一暂停就会被当成加载失败、
    // 自动降档重取并 autoplay，表现就是「一直在唤起播放」。
    if (audio.readyState > 0) return;
    tryToneDown('加载超时');
  }, 12000);
}

audio.addEventListener('playing', () => { clearToneWatch(); S.seekTo = 0; });

async function loadLyric(url, mrcUrl) {
  try {
    const r = await call(M.lyric(url || '', mrcUrl || ''));
    parseLyric((r && r.lrc) || '', (r && r.mrc) || '');
  } catch (e) { parseLyric('', ''); }
}

function parseLyric(text, mrc) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  const re = /^\[(\d{1,2}):(\d{2})(?:[.:](\d{2,3}))?\]/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const t = secOf(m[1], m[2], m[3]);
    const rest = line.replace(re, '');
    const wt = wordTimesOf(rest);
    const txt = stripWordTags(rest);
    if (txt) out.push({ t: t, txt: txt, glyphT: wt.length ? alignWordTimes(txt, wt, t) : null });
  }
  out.sort((a, b) => a.t - b.t);

  /* 独立逐字源（mrcUrl）：按行时间就近覆盖，容差 1.2s */
  const words = parseWordLyric(mrc);
  for (const w of words) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < out.length; i++) {
      const d = Math.abs(out[i].t - w.t);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd < 1.2) out[best].glyphT = alignWordTimes(out[best].txt, w.times, out[best].t);
  }

  S.lyric = out;
  S.lyricIdx = -1;
  const body = $('#lpBody');
  if (!out.length) {
    body.innerHTML = '<p>暂无歌词</p>';
    syncLatticeLyric();
    return;
  }
  body.innerHTML = out.map((l, i) => '<p data-l="' + i + '">' + esc(l.txt) + '</p>').join('');
  syncLatticeLyric();
}

function syncLyric(t) {
  if (!S.lyric.length) return;
  const lx = LX();
  if (lx) lx.setTime(t);
  let idx = -1;
  for (let i = 0; i < S.lyric.length; i++) {
    if (S.lyric[i].t <= t + 0.15) idx = i; else break;
  }
  if (idx === S.lyricIdx) return;
  S.lyricIdx = idx;
  const body = $('#lpBody');
  $$('p.cur', body).forEach((p) => p.classList.remove('cur'));
  const p = body.querySelector('p[data-l="' + idx + '"]');
  if (p) {
    p.classList.add('cur');
    if ($('#lyricPanel').classList.contains('open')) {
      const top = p.offsetTop - body.clientHeight / 2 + p.clientHeight / 2;
      body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }
}

/* ── 无法播放提示条 ── */
/**
 * 咪咕 listen 接口的拒绝码（实测）：
 *  440013 会员曲，非会员只能试听     → 去开通会员
 *  440015 数字专辑，需购买后播放     → 去购买
 *  440022 / 440003 账号无该音质权限  → 降一档再试
 *  440018 该音质暂不支持             → 换一档再试
 * 其它一律按「暂时无法播放」兜底。
 */
const VT_REASON = {
  '440013': { title: (n) => '《' + n + '》需要白金会员', act: '去开通会员', url: 'https://music.migu.cn/v5/pages/vip/index' },
  '440015': { title: (n) => '《' + n + '》需要购买数字专辑', act: '去购买', url: 'https://music.migu.cn/v5/pages/vip/index' },
  '440022': { title: () => '当前账号无此音质权限', act: '开通会员', url: 'https://music.migu.cn/v5/pages/vip/index' },
  '440003': { title: () => '当前账号无此音质权限', act: '开通会员', url: 'https://music.migu.cn/v5/pages/vip/index' },
  '440018': { title: () => '该音质暂不支持播放', act: '换音质试试', url: '' },
};
let vtTimer = null;
function showVipTip(song, info) {
  const box = $('#vipTip');
  if (!box) return;
  const code = String((info && info.cannotCode) || '');
  const rule = VT_REASON[code];
  const name = (song && song.name) || '该歌曲';
  $('#vtTitle').textContent = rule ? rule.title(name) : '《' + name + '》暂时无法播放';
  let sub = (info && (info.dialog || info.cannotMsg)) || '版权方限制，可稍后重试或换一首';
  if (info && info.auditionsLength) sub += ' · 可试听 ' + info.auditionsLength + ' 秒';
  $('#vtSub').textContent = sub;
  const open = $('#vtOpen');
  if (open) {
    open.textContent = rule ? rule.act : '去开通';
    open.style.display = rule && !rule.url ? 'none' : '';
    S.vtUrl = (rule && rule.url) || 'https://music.migu.cn/v5/pages/vip/index';
  }
  box.classList.add('show');
  clearTimeout(vtTimer);
  vtTimer = setTimeout(hideVipTip, 12000);
}
function hideVipTip() {
  const box = $('#vipTip');
  if (box) box.classList.remove('show');
  S.blocked = null;
}
function updatePlayIcon() {
  $('#playIcon').innerHTML = S.playing
    ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
}
function setSeek(pct) {
  const p = Math.max(0, Math.min(1, pct || 0));
  $('#seekFill').style.width = (p * 100) + '%';
  $('#seekDot').style.left = (p * 100) + '%';
}

function nextIndex(dir) {
  const n = S.queue.length;
  if (!n) return -1;
  if (S.loop === 'shuffle') {
    if (n === 1) return 0;
    let r = S.qIndex;
    while (r === S.qIndex) r = Math.floor(Math.random() * n);
    return r;
  }
  let i = S.qIndex + dir;
  if (i < 0) i = n - 1;
  if (i >= n) i = 0;
  return i;
}
function playNext(auto) {
  const n = S.queue.length;
  if (!n) return;
  if (S.loop === 'one' && auto) { audio.currentTime = 0; audio.play(); return; }
  if (auto && S.loop === 'list' && S.qIndex === n - 1) {
    // 列表循环：回到第一首
    S.qIndex = 0;
  } else {
    S.qIndex = nextIndex(1);
  }
  loadCurrent(true);
}
/** 无视循环模式地跳到下一首（用于跳过无版权曲） */
function skipBlocked() {
  const n = S.queue.length;
  if (n < 2) return;
  hideVipTip();
  S.qIndex = (S.qIndex + 1) % n;
  loadCurrent(true);
}

function playPrev() {
  if (!S.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  S.qIndex = nextIndex(-1);
  loadCurrent(true);
}

/* 收藏 —— 跟着咪咕账号走（云端「喜欢的音乐」歌单），不再落本地 */
function isFav(song) {
  return !!(song && song.contentId && S.favIds[song.contentId]);
}
function setFavIds(songs) {
  const map = {};
  (songs || []).forEach((s) => { if (s && s.contentId) map[s.contentId] = true; });
  S.favIds = map;
}
/** 拉云端「我喜欢的」歌单 */
async function refreshFavorites(opts) {
  opts = opts || {};
  if (!S.auth) {
    S.favorite = [];
    S.favIds = {};
    S.favError = '';
    S.favLoaded = false;
    updateLikeBtn();
    return { ok: false, needLogin: true };
  }
  if (opts.silent !== true && S.curRoute === 'favorite') S.favLoading = true;
  // 注意：这里不能用 call()，它会把 {ok,data} 拆成 data 再丢掉 ok/error 分支
  let res = null;
  try { res = await M.favorites(); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  S.favLoading = false;
  const d = (res && res.ok) ? res.data : null;
  if (!d) {
    S.favError = (res && res.error) || '加载失败';
    S.favLoaded = false;
    updateLikeBtn();
    if (S.curRoute === 'favorite') go('favorite', {}, true);
    return { ok: false, error: S.favError };
  }
  if (d.ok === false) {
    S.favError = d.error || (d.needLogin ? '请先登录' : '同步失败');
    S.favorite = [];
    S.favIds = {};
    S.favLoaded = false;
    updateLikeBtn();
    if (S.curRoute === 'favorite') go('favorite', {}, true);
    return { ok: false, needLogin: !!d.needLogin, error: S.favError };
  }
  S.favError = '';
  S.favLoaded = true;
  S.favorite = d.songs || [];
  setFavIds(S.favorite);
  updateLikeBtn();
  if (S.curRoute === 'favorite' && opts.silent !== true) go('favorite', {}, true);
  return { ok: true, songs: S.favorite };
}

async function toggleFav(song) {
  if (!song || !song.contentId) return;
  if (!S.auth) {
    toast('请先登录咪咕账号，收藏会同步到账号里');
    go('me');
    return;
  }
  const on = isFav(song);
  const btn = $('#plLike');
  if (btn) btn.classList.add('busy');
  let res = null;
  try { res = on ? await M.unlike(song.contentId) : await M.like(song.contentId); }
  catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  if (btn) btn.classList.remove('busy');
  const d = (res && res.ok) ? res.data : res;
  if (!d || d.ok === false) {
    const msg = (d && d.error) || (res && res.error) || '操作失败';
    toast(msg);
    return;
  }
  // 本地缓存同步（服务端已生效，这里只更新红心与列表）
  if (on) {
    delete S.favIds[song.contentId];
    S.favorite = S.favorite.filter((x) => x.contentId !== song.contentId);
    toast('已从「我喜欢的」移除');
  } else {
    S.favIds[song.contentId] = true;
    S.favorite = [song].concat(S.favorite.filter((x) => x.contentId !== song.contentId));
    toast('已添加至「我喜欢的」');
  }
  updateLikeBtn();
  if (S.curRoute === 'favorite') go('favorite', {}, true);
  if (S.curRoute === 'me') go('me', {}, true);
}

function updateLikeBtn() {
  const s = S.queue[S.qIndex];
  $('#plLike').classList.toggle('on', !!s && isFav(s));
}

/* 队列面板 */
function renderQueue() {
  $('#queueCount').textContent = String(S.queue.length);
  const body = $('#qpBody');
  if (!S.queue.length) { body.innerHTML = emptyHTML('队列为空'); return; }
  body.innerHTML = S.queue.map((s, i) =>
    '<div class="qp-item' + (i === S.qIndex ? ' playing' : '') + '" data-qi="' + i + '">' +
    '<div class="qp-idx">' + (i === S.qIndex ? '▶' : (i + 1)) + '</div>' +
    '<div class="qp-n">' + esc(s.name) + '</div>' +
    '<div class="qp-s">' + esc(s.singer || '') + '</div></div>'
  ).join('');
  $$('.qp-item', body).forEach((el) => {
    el.onclick = () => { S.qIndex = Number(el.dataset.qi); loadCurrent(true); };
  });
}
/* ─────────────── 路由：发现（Folia 风 · 无广告） ─────────────── */
ROUTES.home = async (view, p) => {
  view.classList.add('is-home');
  document.body.classList.add('home-mode');
  view.innerHTML = loadingHTML();
  const blocks = await call(M.home()).catch(() => []);
  const hotR = await call(M.hotSearch()).catch(() => ({ words: [], nav: [] }));
  const pick = (v) => blocks.find((b) => b.view === v) || null;
  const idOf = (it) => (String((it && it.action) || '').match(/[?&]id=(\d+)/) || [])[1] || String((it && it.resId) || '');
  const songOf = (it) => {
    const le = (it && it.logEvent) || {};
    return {
      contentId: String(le.contentId || (it && it.resId) || ''),
      copyrightId: (it && it.copyrightId) || '',
      songId: String(le.songId || ''),
      name: le.contentName || (it && it.txt) || '',
      singer: (it && it.txt2) || '',
      album: (it && it.txt3) || '',
      img: (it && it.img) || '',
      vip: !!(it && it.vip),
    };
  };

  const bPl = pick('ZJ-SongList-Scroll');
  const bIcons = pick('ZJ-Transformers');
  const bNew = pick('ZJ-Song-Scroll');
  const bAlbum = pick('ZJ-Album-Scroll');
  const bRec = pick('ZJ-Rec-Song-Compound');
  const bRank = pick('ZJ-Rank-Compound');

  const pls = ((bPl && bPl.items) || [])
    .map((it) => ({ id: idOf(it), name: it.txt || '', img: it.img || '' }))
    .filter((x) => x.id);
  const news = ((bNew && bNew.items) || []).map(songOf).filter((s) => s.contentId);
  const albums = ((bAlbum && bAlbum.items) || [])
    .map((it) => ({ id: idOf(it), name: it.txt || '', img: it.img || '' }))
    .filter((x) => x.id);
  const recSub = ((bRec && bRec.items) || []).find((s) => s.view === 'ZJ-Song-Scroll');
  const recSongs = ((recSub && recSub.contents) || []).map(songOf).filter((s) => s.contentId);
  const ranks = [];
  for (const sub of ((bRank && bRank.items) || [])) {
    if (sub.view !== 'ZJ-Song-Scroll') continue;
    const cid = String(sub.columnId || '');
    if (!cid || ranks.some((r) => r.id === cid)) continue;
    ranks.push({ id: cid, title: sub.title || '榜单', songs: ((sub.contents || [])).map(songOf).filter((s) => s.contentId) });
  }
  const hotWords = (((hotR && hotR.words) || [])).map((x) => String(x.word || '')).filter(Boolean).slice(0, 10);

  view.__newSongs = news;
  view.__ranks = ranks;

  const quick = [
    { name: '排行榜', to: 'rank' },
    { name: '新歌速递', to: 'newSongs' },
    { name: '歌手', to: 'singer' },
    { name: '我的收藏', to: 'favorite' },
  ];
  const qIcon = {};
  for (const it of ((bIcons && bIcons.items) || [])) {
    const a = String(it.action || '');
    if (a === 'mgmusic://rank') qIcon['排行榜'] = it.img || '';
    if (a === 'mgmusic://music/singer/singer-lists') qIcon['歌手'] = it.img || '';
  }

  const out = [];
  out.push('<div class="home-wrap">');
  out.push('<nav class="home-rail">');
  out.push('<a class="rail-item is-on" data-r="home">发现</a>');
  out.push('<a class="rail-item" data-r="rank">榜单</a>');
  out.push('<a class="rail-item" data-r="newSongs">新歌</a>');
  out.push('<a class="rail-item" data-r="singer">歌手</a>');
  out.push('<a class="rail-item" data-r="favorite">收藏</a>');
  out.push('<a class="rail-item" data-r="recent">最近</a>');
  out.push('<span class="rail-spacer"></span>');
  out.push('<a class="rail-item rail-acc" data-r="me">我的</a>');
  out.push('</nav>');
  out.push('<div class="home-main">');

  out.push('<header class="home-head">');
  out.push('<div class="head-kicker">MIGU MUSIC</div>');
  out.push('<h1 class="head-title">发现音乐</h1>');
  if (hotWords.length) {
    out.push('<div class="head-hot"><span class="hot-label">热搜</span>');
    for (const w of hotWords) out.push('<a class="hot-w" data-hot="' + esc(w) + '">' + esc(w) + '</a>');
    out.push('</div>');
  }
  out.push('</header>');

  const hero = pls[0] || null;
  if (hero || quick.length) {
    out.push('<section class="home-split">');
    if (hero) {
      out.push('<a class="hero" data-pl="' + esc(hero.id) + '">');
      out.push('<div class="hero-img">' + imgTag(hero.img, hero.name) + '</div>');
      out.push('<div class="hero-fade"></div>');
      out.push('<div class="hero-body">');
      out.push('<div class="hero-k">今日推荐</div>');
      out.push('<div class="hero-t">' + esc(hero.name) + '</div>');
      out.push('<div class="hero-go">进入歌单<span>→</span></div>');
      out.push('</div>');
      out.push('</a>');
    }
    out.push('<div class="quick">');
    quick.forEach((q, qi) => {
      out.push('<a class="quick-i" data-q="' + esc(q.to) + '">');
      out.push('<span class="qi-idx">' + String(qi + 1).padStart(2, '0') + '</span>');
      out.push('<span class="qi-n">' + esc(q.name) + '</span>');
      out.push('<span class="qi-arrow">↗</span>');
      out.push('</a>');
    });
    out.push('</div>');
    out.push('</section>');
  }

  if (pls.length > 1) {
    out.push('<section class="home-sec">');
    out.push('<div class="hs-head"><span class="hs-name">推荐歌单</span><span class="hs-line"></span></div>');
    out.push('<div class="home-wall">');
    for (const it of pls.slice(1)) {
      out.push('<a class="hp" data-pl="' + esc(it.id) + '">');
      out.push('<div class="hp-img">' + imgTag(it.img, it.name) + '<span class="hp-play">▶</span></div>');
      out.push('<div class="hp-name">' + esc(it.name) + '</div>');
      out.push('</a>');
    }
    out.push('</div>');
    out.push('</section>');
  }

  if (news.length) {
    out.push('<section class="home-sec">');
    out.push('<div class="hs-head"><span class="hs-name">新歌速递</span><span class="hs-line"></span>' +
      '<a class="hs-more" data-tonew="1">全部 →</a></div>');
    out.push('<div class="hlist">');
    news.slice(0, 10).forEach((s, i) => {
      out.push('<div class="hrow" data-song="' + i + '">');
      out.push('<span class="hr-no">' + String(i + 1).padStart(2, '0') + '</span>');
      out.push('<span class="hr-img">' + imgTag(s.img, s.name) + '</span>');
      out.push('<span class="hr-meta"><span class="hr-name">' + esc(s.name) + '</span>' +
        '<span class="hr-by">' + esc(s.singer || '—') + '</span></span>');
      out.push('<span class="hr-play">▶</span>');
      out.push('</div>');
    });
    out.push('</div>');
    out.push('</section>');
  }

  if (ranks.length) {
    out.push('<section class="home-sec">');
    out.push('<div class="hs-head"><span class="hs-name">排行榜</span><span class="hs-line"></span>' +
      '<a class="hs-more" data-torank="1">全部 →</a></div>');
    out.push('<div class="home-ranks">');
    for (const r of ranks.slice(0, 3)) {
      out.push('<div class="hrk" data-rank="' + esc(r.id) + '">');
      out.push('<div class="hrk-side"><span class="hrk-name">' + esc(r.title) + '</span></div>');
      out.push('<ol class="hrk-list">');
      r.songs.slice(0, 3).forEach((s) => {
        out.push('<li><b>' + esc(s.name) + '</b><em>' + esc(s.singer || '') + '</em></li>');
      });
      out.push('</ol>');
      out.push('</div>');
    }
    out.push('</div>');
    out.push('</section>');
  }

  if (albums.length) {
    out.push('<section class="home-sec">');
    out.push('<div class="hs-head"><span class="hs-name">新碟上架</span><span class="hs-line"></span></div>');
    out.push('<div class="home-wall">');
    for (const it of albums) {
      out.push('<a class="hp" data-alb="' + esc(it.id) + '">');
      out.push('<div class="hp-img">' + imgTag(it.img, it.name) + '<span class="hp-play">▶</span></div>');
      out.push('<div class="hp-name">' + esc(it.name) + '</div>');
      out.push('</a>');
    }
    out.push('</div>');
    out.push('</section>');
  }

  if (recSongs.length) {
    out.push('<section class="home-sec">');
    out.push('<div class="hs-head"><span class="hs-name">猜中你的心</span><span class="hs-line"></span></div>');
    out.push('<div class="home-wall">');
    recSongs.forEach((s, i) => {
      out.push('<a class="hp" data-rec="' + i + '">');
      out.push('<div class="hp-img">' + imgTag(s.img, s.name) + '<span class="hp-play">▶</span></div>');
      out.push('<div class="hp-name">' + esc(s.name) + '</div>');
      out.push('<div class="hp-sub">' + esc(s.singer || '') + '</div>');
      out.push('</a>');
    });
    out.push('</div>');
    out.push('</section>');
  }

  if (!pls.length && !news.length && !ranks.length) {
    out.push(emptyHTML('首页内容暂时取不到'));
  }

  out.push('<div class="home-foot">MIGU MUSIC · 第三方客户端 · 无广告</div>');
  out.push('</div>');
  out.push('</div>');
  view.innerHTML = out.join('');

  $$('[data-r]', view).forEach((el) => { el.onclick = () => go(el.dataset.r, {}); });
  $$('[data-hot]', view).forEach((el) => { el.onclick = () => go('search', { q: el.dataset.hot }); });
  $$('[data-pl]', view).forEach((el) => { el.onclick = () => go('playlist', { id: el.dataset.pl }); });
  $$('[data-alb]', view).forEach((el) => { el.onclick = () => go('album', { id: el.dataset.alb }); });
  $$('[data-q]', view).forEach((el) => { el.onclick = () => go(el.dataset.q, {}); });
  $$('.hrow[data-song]', view).forEach((el) => {
    const play = () => playQueue(news, Number(el.dataset.song));
    el.onclick = play;
    el.ondblclick = play;
  });
  $$('[data-rec]', view).forEach((el) => {
    el.onclick = () => playQueue(recSongs, Number(el.dataset.rec));
  });
  $$('[data-rank]', view).forEach((el) => {
    el.onclick = () => {
      const r = ranks.find((x) => x.id === el.dataset.rank);
      go('column', { id: el.dataset.rank, title: r ? r.title : '' });
    };
  });
  const moreNew = $('[data-tonew]', view);
  if (moreNew) moreNew.onclick = (e) => { e.stopPropagation(); go('newSongs', {}); };
  const moreRank = $('[data-torank]', view);
  if (moreRank) moreRank.onclick = (e) => { e.stopPropagation(); go('rank', {}); };
};

/* ─────────────── 路由：排行榜 ─────────────── */
ROUTES.rank = async (view) => {
  view.innerHTML = loadingHTML();
  const list = await call(M.topLists());
  if (!list.length) { view.innerHTML = emptyHTML('榜单暂不可用'); return; }
  view.innerHTML =
    '<div class="view-head"><div><div class="view-title">排行榜</div>' +
    '<div class="view-sub">共 ' + list.length + ' 个榜单</div></div></div>' +
    '<div class="grid c4">' + list.map((r) =>
      '<div class="card" data-rank="' + esc(r.id) + '">' +
      '<div class="card-img">' + imgTag(r.songs[0] && r.songs[0].img, r.title) +
      '<div class="card-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div></div>' +
      '<div class="card-name">' + esc(r.title) + '</div>' +
      '<div class="card-sub">' + r.songs.length + ' 首 · ' + esc((r.songs[0] && r.songs[0].singer) || '') + '</div></div>'
    ).join('') + '</div>';
  $$('[data-rank]', view).forEach((el) => {
    el.onclick = () => {
      const r = list.find((x) => x.id === el.dataset.rank);
      go('column', { id: el.dataset.rank, title: r ? r.title : '' });
    };
  });
};

/* ─────────────── 路由：榜单详情 ─────────────── */
ROUTES.column = async (view, p) => {
  view.innerHTML = loadingHTML();
  const col = await call(M.column(p.id));
  const songs = col.songs || [];
  view.innerHTML =
    '<div class="detail-head">' +
    '<div class="detail-cover">' + imgTag(col.img || (songs[0] && songs[0].img), col.title) + '</div>' +
    '<div class="detail-meta">' +
    '<div class="detail-kind">排行榜</div>' +
    '<div class="detail-title">' + esc(col.title || p.title || '榜单') + '</div>' +
    '<div class="detail-sub"><span>' + songs.length + ' 首</span>' +
    (col.updateTime ? '<span>更新：' + esc(col.updateTime) + '</span>' : '') + '</div>' +
    (col.description ? '<div class="detail-desc">' + esc(col.description) + '</div>' : '') +
    '<div class="detail-act"><button class="btn primary" id="playAll">' +
    '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放全部</button></div>' +
    '</div></div>' +
    songTableHTML(songs);
  bindSongTable(view, songs);
  $('#playAll').onclick = () => playQueue(songs, 0);
};

/* ─────────────── 路由：新歌速递 ─────────────── */
ROUTES.newSongs = async (view) => {
  view.innerHTML = loadingHTML();
  const col = await call(M.newSongs());
  const songs = (col.songs || []).slice();
  view.innerHTML =
    '<div class="view-head"><div><div class="view-title">新歌速递</div>' +
    '<div class="view-sub">' + songs.length + ' 首 · 持续更新</div></div>' +
    '<div style="margin-left:auto"><button class="btn primary" id="playAll">' +
    '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放全部</button></div></div>' +
    songTableHTML(songs);
  bindSongTable(view, songs);
  $('#playAll').onclick = () => playQueue(songs, 0);
};

/* ─────────────── 路由：歌手（搜索态） ─────────────── */
ROUTES.singer = async (view) => {
  const hot = await call(M.hotSearch()).catch(() => ({ words: [] }));
  const picks = ['周杰伦', '林俊杰', '邓紫棋', '陈奕迅', '薛之谦', '五月天', '李荣浩', '毛不易',
    '华晨宇', '张杰', '孙燕姿', '王力宏'];
  view.innerHTML =
    '<div class="view-head"><div><div class="view-title">歌手</div>' +
    '<div class="view-sub">输入歌手名查找</div></div></div>' +
    '<div class="sec"><div class="sec-head"><div class="sec-title">热门歌手</div></div>' +
    '<div class="grid c6" id="singerGrid">' +
    picks.map((n) => '<div class="singer-card" data-sname="' + esc(n) + '">' +
      '<div class="singer-av" style="display:flex;align-items:center;justify-content:center;' +
      'background:linear-gradient(135deg,#2a2a3c,#1e1e2c);font-size:26px;color:#4a4a62">' +
      esc(n.slice(0, 1)) + '</div><div class="singer-name">' + esc(n) + '</div></div>').join('') +
    '</div></div>' +
    '<div id="singerResult"></div>';

  const searchTo = (name) => {
    $('#globalSearch').value = name;
    doSearch(name, 'singer');
  };
  $$('[data-sname]', view).forEach((el) => { el.onclick = () => searchTo(el.dataset.sname); });

  // 拉取热门歌手的真实头像
  const grid = $('#singerGrid');
  picks.slice(0, 12).forEach(async (name) => {
    try {
      const r = await call(M.search(name, 'singer', 1, 1));
      const s = r.list && r.list[0];
      if (!s) return;
      const el = grid.querySelector('[data-sname="' + name + '"]');
      if (!el) return;
      el.dataset.sid = s.id;
      el.onclick = () => go('singerDetail', { id: s.id, name: s.name || name });
    } catch (e) { /* ignore */ }
  });
};

/* ─────────────── 路由：歌手详情 ─────────────── */
ROUTES.singerDetail = async (view, p) => {
  view.innerHTML = loadingHTML();
  const [info, songsR, albumsR] = await Promise.all([
    call(M.singerInfo(p.id)).catch(() => ({ name: p.name || '', img: '', fans: '' })),
    call(M.singerSongs(p.id, 1)).catch(() => ({ songs: [] })),
    call(M.singerAlbums(p.id, 1)).catch(() => ({ albums: [] })),
  ]);
  const songs = songsR.songs || [];
  const albums = albumsR.albums || [];
  const name = info.name || p.name || '歌手';

  let html =
    '<div class="detail-head">' +
    '<div class="detail-cover" style="border-radius:50%">' + imgTag(info.img, name) + '</div>' +
    '<div class="detail-meta">' +
    '<div class="detail-kind">歌手</div>' +
    '<div class="detail-title">' + esc(name) + '</div>' +
    '<div class="detail-sub">' + (info.fans ? '<span>' + num(info.fans) + ' 粉丝</span>' : '') +
    '<span>' + songs.length + ' 首歌曲</span>' + (albums.length ? '<span>' + albums.length + ' 张专辑</span>' : '') + '</div>' +
    '<div class="detail-act"><button class="btn primary" id="playAll">' +
    '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放热门</button></div>' +
    '</div></div>';

  if (albums.length) {
    html += '<div class="sec"><div class="sec-head"><div class="sec-title">专辑</div></div>' +
      '<div class="hscroll">' + albums.map((a) =>
        '<div class="card" data-album="' + esc(a.id) + '"><div class="card-img">' + imgTag(a.img, a.name) +
        (a.digital ? '<span class="badge">数字</span>' : '') +
        '<div class="card-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div></div>' +
        '<div class="card-name">' + esc(a.name) + '</div><div class="card-sub">' + esc(a.date || '') + '</div></div>'
      ).join('') + '</div></div>';
  }
  html += '<div class="sec"><div class="sec-head"><div class="sec-title">热门歌曲</div></div>' + songTableHTML(songs) + '</div>';
  view.innerHTML = html;
  bindSongTable(view, songs);
  $('#playAll').onclick = () => playQueue(songs, 0);
  $$('[data-album]', view).forEach((el) => { el.onclick = () => go('album', { id: el.dataset.album }); });
};

/* ─────────────── 路由：歌单详情 ─────────────── */
ROUTES.playlist = async (view, p) => {
  view.innerHTML = loadingHTML();
  const pl = await call(M.playlist(p.id));
  const songs = pl.songs || [];
  view.innerHTML =
    '<div class="detail-head">' +
    '<div class="detail-cover">' + imgTag(pl.img || (songs[0] && songs[0].img), pl.title) + '</div>' +
    '<div class="detail-meta">' +
    '<div class="detail-kind">歌单</div>' +
    '<div class="detail-title">' + esc(pl.title) + '</div>' +
    '<div class="detail-sub"><span>' + (pl.count || songs.length) + ' 首</span>' +
    (pl.owner ? '<span>by ' + esc(pl.owner) + '</span>' : '') +
    (pl.tags && pl.tags.length ? '<span>' + pl.tags.map(esc).join(' / ') + '</span>' : '') + '</div>' +
    (pl.summary ? '<div class="detail-desc">' + esc(pl.summary) + '</div>' : '') +
    '<div class="detail-act"><button class="btn primary" id="playAll">' +
    '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放全部</button></div>' +
    '</div></div>' + songTableHTML(songs);
  bindSongTable(view, songs);
  $('#playAll').onclick = () => playQueue(songs, 0);
};

/* ─────────────── 路由：专辑详情 ─────────────── */
ROUTES.album = async (view, p) => {
  view.innerHTML = loadingHTML();
  const al = await call(M.album(p.id));
  const songs = al.songs || [];
  view.innerHTML =
    '<div class="detail-head">' +
    '<div class="detail-cover">' + imgTag(al.img || (songs[0] && songs[0].img), al.title) + '</div>' +
    '<div class="detail-meta">' +
    '<div class="detail-kind">专辑</div>' +
    '<div class="detail-title">' + esc(al.title) + '</div>' +
    '<div class="detail-sub">' +
    (al.singer ? '<a id="toSinger">' + esc(al.singer) + '</a>' : '') +
    (al.publishDate ? '<span>' + esc(al.publishDate) + '</span>' : '') +
    '<span>' + (al.count || songs.length) + ' 首</span></div>' +
    (al.summary ? '<div class="detail-desc">' + esc(al.summary) + '</div>' : '') +
    '<div class="detail-act"><button class="btn primary" id="playAll">' +
    '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放全部</button></div>' +
    '</div></div>' +
    (songs.length ? songTableHTML(songs) : emptyHTML('该专辑暂无歌曲'));
  bindSongTable(view, songs);
  const pa = $('#playAll');
  if (pa) pa.onclick = () => playQueue(songs, 0);
  const ts = $('#toSinger');
  if (ts && al.singerId) ts.onclick = () => go('singerDetail', { id: al.singerId, name: al.singer });
};

/* ─────────────── 路由：搜索结果 ─────────────── */
ROUTES.search = async (view, p) => {
  const q = p.q || '';
  const tab = p.tab || 'song';
  view.innerHTML =
    '<div class="view-head"><div><div class="view-title">' +
    (q ? '搜索：' + esc(q) : '搜索') + '</div>' +
    '<div class="view-sub" id="searchSub">' + (q ? '正在检索…' : '在上方输入关键词开始搜索') + '</div></div></div>' +
    '<div class="tabs" id="searchTabs">' +
    ['song:单曲', 'singer:歌手', 'album:专辑', 'playlist:歌单'].map((x) => {
      const [k, n] = x.split(':');
      return '<div class="tab' + (k === tab ? ' active' : '') + '" data-tab="' + k + '">' + n + '</div>';
    }).join('') + '</div>' +
    '<div id="searchBody">' + (q ? loadingHTML() : emptyHTML('输入关键词开始搜索')) + '</div>';

  $$('[data-tab]', view).forEach((el) => {
    el.onclick = () => go('search', { q, tab: el.dataset.tab }, true);
  });
  if (!q) return;

  const body = $('#searchBody');
  const r = await call(M.search(q, tab, 1, 40));
  const list = r.list || [];
  $('#searchSub').textContent = '共找到 ' + (r.total || list.length) + ' 个结果';

  if (!list.length) { body.innerHTML = emptyHTML('没有找到相关内容'); return; }

  if (tab === 'song') {
    body.innerHTML = songTableHTML(list);
    bindSongTable(body, list);
  } else if (tab === 'singer') {
    body.innerHTML = '<div class="grid c6">' + list.map((s) =>
      '<div class="singer-card" data-sid="' + esc(s.id) + '" data-sname="' + esc(s.name) + '">' +
      '<div class="singer-av">' + imgTag(s.img, s.name) + '</div>' +
      '<div class="singer-name">' + esc(s.name) + '</div></div>').join('') + '</div>';
    $$('[data-sid]', body).forEach((el) => {
      el.onclick = () => go('singerDetail', { id: el.dataset.sid, name: el.dataset.sname });
    });
  } else if (tab === 'album') {
    body.innerHTML = '<div class="grid auto">' + list.map((a) =>
      '<div class="card" data-aid="' + esc(a.id) + '"><div class="card-img">' + imgTag(a.img, a.name) +
      (a.type === '5' ? '<span class="badge">数字</span>' : '') + '</div>' +
      '<div class="card-name">' + esc(a.name) + '</div>' +
      '<div class="card-sub">' + esc(a.singer || '') + (a.date ? ' · ' + esc(a.date) : '') + '</div></div>').join('') + '</div>';
    $$('[data-aid]', body).forEach((el) => { el.onclick = () => go('album', { id: el.dataset.aid }); });
  } else {
    body.innerHTML = '<div class="grid auto">' + list.map((a) =>
      '<div class="card" data-plid="' + esc(a.id) + '"><div class="card-img">' + imgTag(a.img, a.name) +
      (a.playCount ? '<span class="badge">' + num(a.playCount) + '</span>' : '') + '</div>' +
      '<div class="card-name">' + esc(a.name) + '</div>' +
      '<div class="card-sub">' + (a.count || 0) + ' 首' + (a.tags && a.tags.length ? ' · ' + esc(a.tags.slice(0, 2).join('/')) : '') + '</div></div>'
    ).join('') + '</div>';
    $$('[data-plid]', body).forEach((el) => { el.onclick = () => go('playlist', { id: el.dataset.plid }); });
  }
};

/* ─────────────── 路由：我的收藏（云端「我喜欢的」） ─────────────── */
ROUTES.favorite = async (view) => {
  // 未登录：提示去登录，不代表「没有收藏」
  if (!S.auth) {
    view.innerHTML =
      '<div class="view-head"><div><div class="view-title">我的收藏</div>' +
      '<div class="view-sub">跟随咪咕账号的「我喜欢的」歌单</div></div></div>' +
      '<div class="fav-guest">' +
      '<div class="fav-guest-t">登录后这里会显示你账号里「我喜欢的」歌曲</div>' +
      '<div class="fav-guest-s">收藏不再存在本机，换台电脑登录同一个账号也是同一份列表。</div>' +
      '<button class="btn primary" id="favLogin">去登录</button></div>';
    $('#favLogin').onclick = () => go('me');
    return;
  }

  const songs = S.favorite || [];
  const first = !S.favLoaded && !S.favLoading;
  view.innerHTML =
    '<div class="view-head"><div><div class="view-title">我的收藏</div>' +
    '<div class="view-sub">' + (S.favLoading || first ? '正在同步账号收藏…' : songs.length + ' 首 · 已同步到咪咕账号') + '</div></div>' +
    (songs.length ? '<div style="margin-left:auto"><button class="btn" id="favReload">刷新</button>' +
      '<button class="btn primary" style="margin-left:8px" id="playAll">' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放全部</button></div>'
      : '<div style="margin-left:auto"><button class="btn" id="favReload">刷新</button></div>') + '</div>' +
    (S.favLoading || first
      ? '<div class="fav-guest"><div class="fav-guest-t">正在读取账号里的「我喜欢的」…</div></div>'
      : (songs.length ? songTableHTML(songs, { fav: true })
        : (S.favError
          ? '<div class="fav-guest"><div class="fav-guest-t">同步失败</div><div class="fav-guest-s">' + esc(S.favError) + '</div></div>'
          : emptyHTML('账号里还没有收藏歌曲，点播放器上的心形图标会同步到「我喜欢的」'))));

  if (songs.length && !S.favLoading) {
    bindSongTable(view, songs);
    const pa = $('#playAll');
    if (pa) pa.onclick = () => playQueue(songs, 0);
    $$('[data-fav]', view).forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const s = songs[Number(btn.dataset.fav)];
        if (s) toggleFav(s);
      };
    });
  }
  const rl = $('#favReload');
  if (rl) rl.onclick = async () => { S.favLoading = true; go('favorite', {}, true); await refreshFavorites(); };
  if (first) refreshFavorites({ silent: true });
};

/* ─────────────── 路由：最近播放 ─────────────── */
ROUTES.recent = async (view) => {
  const songs = S.recent || [];
  view.innerHTML =
    '<div class="view-head"><div><div class="view-title">最近播放</div>' +
    '<div class="view-sub">' + songs.length + ' 首</div></div>' +
    (songs.length ? '<div style="margin-left:auto"><button class="btn primary" id="playAll">' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放全部</button></div>' : '') + '</div>' +
    (songs.length ? songTableHTML(songs) : emptyHTML('还没有播放记录'));
  if (songs.length) {
    bindSongTable(view, songs);
    const pa = $('#playAll');
    if (pa) pa.onclick = () => playQueue(songs, 0);
  }
};

/* ─────────────── 搜索交互 ─────────────── */
let suggTimer = null;
function doSearch(q, tab) {
  if (!q || !q.trim()) return;
  q = q.trim();
  $('#suggBox').classList.remove('show');
  go('search', { q, tab: tab || 'song' });
}
$('#globalSearch').addEventListener('input', (e) => {
  const v = e.target.value.trim();
  clearTimeout(suggTimer);
  if (!v) { $('#suggBox').classList.remove('show'); return; }
  suggTimer = setTimeout(async () => {
    try {
      const s = await call(M.suggest(v));
      const items = [];
      (s.singers || []).forEach((n) => items.push({ n, t: '歌手' }));
      (s.songs || []).forEach((n) => items.push({ n, t: '单曲' }));
      if (!items.length) { $('#suggBox').classList.remove('show'); return; }
      const box = $('#suggBox');
      box.innerHTML = items.slice(0, 10).map((x) =>
        '<div class="sugg-item" data-sg="' + esc(x.n) + '"><span class="st">' + x.t + '</span>' + esc(x.n) + '</div>'
      ).join('');
      box.classList.add('show');
      $$('.sugg-item', box).forEach((el) => {
        el.onclick = () => { $('#globalSearch').value = el.dataset.sg; doSearch(el.dataset.sg, 'song'); };
      });
    } catch (err) { /* ignore */ }
  }, 260);
});
$('#globalSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch(e.target.value, 'song');
  if (e.key === 'Escape') $('#suggBox').classList.remove('show');
});
$('#globalSearch').addEventListener('blur', () => {
  setTimeout(() => $('#suggBox').classList.remove('show'), 160);
});
$('#searchGo').onclick = () => doSearch($('#globalSearch').value, 'song');

/* ─────────────── 侧栏 / 顶栏 ─────────────── */
$$('.side-item, .sc-btn').forEach((el) => {
  el.onclick = () => go(el.dataset.view, {});
});
$('#navBack').onclick = back;
$('#navFwd').onclick = fwd;
$('#btnMin').onclick = () => M.window.minimize();
$('#btnMax').onclick = () => M.window.toggleMaximize();
$('#btnClose').onclick = () => M.window.close();
M.window.onState((s) => {
  $('#btnMax').innerHTML = s.maximized
    ? '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M5 5h14v14H5zm1.5 1.5v11h11v-11z"/></svg>';
});

/* ─────────────── 播放器事件 ─────────────── */
$('#btnPlay').onclick = () => {
  if (!S.queue.length) { toast('播放队列为空'); return; }
  if (!audio.src) { loadCurrent(true); return; }
  if (audio.paused) { S.pauseStamp = 0; audio.play().then(() => { S.playing = true; updatePlayIcon(); }).catch(() => {}); }
  else { audio.pause(); S.pauseStamp = Date.now(); S.playing = false; updatePlayIcon(); }
};
$('#btnPrev').onclick = playPrev;
$('#btnNext').onclick = () => playNext(false);

$('#btnLoop').onclick = () => {
  const order = ['list', 'one', 'shuffle'];
  S.loop = order[(order.indexOf(S.loop) + 1) % order.length];
  const icons = {
    list: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
    one: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
    shuffle: 'M14.8 5H21v6.2h-2V8.4l-4.6 4.6-1.4-1.4L17.6 7h-2.8zM3 7h4.5l3 3-1.4 1.4L6.9 9H3zm14.5 12H21v-2h-2.8l-8-8',
  };
  $('#loopIcon').innerHTML = '<path d="' + icons[S.loop] + '"/>';
  $('#btnLoop').classList.toggle('active', S.loop !== 'list');
  toast({ list: '列表循环', one: '单曲循环', shuffle: '随机播放' }[S.loop]);
};

$('#seekBar').addEventListener('click', (e) => {
  if (!audio.duration) return;
  const bar = e.currentTarget.querySelector('.bar-bg');
  const rect = bar.getBoundingClientRect();
  const p = (e.clientX - rect.left) / rect.width;
  audio.currentTime = p * audio.duration;
  setSeek(p);
});

const volBar = $('#volBar');
volBar.addEventListener('click', (e) => {
  const rect = e.currentTarget.querySelector('.bar-bg').getBoundingClientRect();
  S.volume = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  S.muted = false;
  audio.volume = S.volume;
  updateVol();
  M.storeSet({ volume: S.volume });
});
$('#btnMute').onclick = () => {
  S.muted = !S.muted;
  audio.volume = S.muted ? 0 : S.volume;
  updateVol();
};
function updateVol() {
  $('#volFill').style.width = (S.muted ? 0 : S.volume * 100) + '%';
  $('#volIcon').innerHTML = S.muted || S.volume === 0
    ? '<path d="M4 9v6h4l5 5V4L8 9zm15.5 0-1.4-1.4L16 9.6l-2.1-2.1L12.5 8.9l2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4-2.1-2.1z"/>'
    : '<path d="M4 9v6h4l5 5V4L8 9z"/><path d="M16 8.6a4.8 4.8 0 0 1 0 6.8l1.3 1.3a6.6 6.6 0 0 0 0-9.4z"/>';
}

$('#selQuality').onchange = (e) => {
  S.quality = e.target.value;
  // 手动换档 = 用户明确表态，清掉之前为这首记下的自动降档，否则选回高档也会被旧记忆压回去
  const cur = S.queue[S.qIndex];
  if (cur) delete S.toneForce[cur.contentId];
  M.storeSet({ quality: S.quality });
  if (S.queue.length && S.qIndex >= 0) {
    // 换音质要「换源不换位置」：从当前进度续上，并且原本暂停着就保持暂停，
    // 别让用户只是调个音质就被从头放一遍（这是「一直在唤起播放」的主要来源）。
    const t = audio.currentTime;
    const wasPlaying = !audio.paused;
    if (t > 1) S.seekTo = t;
    if (!wasPlaying) S.pauseStamp = Date.now();
    loadCurrent(wasPlaying);
  }
  toast('音质：' + e.target.selectedOptions[0].text);
};

$('#plLike').onclick = () => toggleFav(S.queue[S.qIndex]);

/* 提示条按钮 */
(function bindVipTip() {
  const box = $('#vipTip');
  if (!box) return;
  $('#vtClose').onclick = () => hideVipTip();
  $('#vtNext').onclick = () => { hideVipTip(); playNext(true); };
  $('#vtOpen').onclick = () => {
    M.openExternal(S.vtUrl || 'https://music.migu.cn/v5/pages/vip/index');
    hideVipTip();
  };
})();

/* 歌词 / 队列面板 */
function closeAllPanels() {
  $('#lyricPanel').classList.remove('open');
  $('#queuePanel').classList.remove('open');
  $('#btnLyric').classList.remove('active');
  $('#btnQueue').classList.remove('active');
  const lx = LX();
  if (lx && lx.isOpen()) lx.close();
}
function toggleLyric() {
  $('#lyricPanel').classList.remove('open');
  $('#queuePanel').classList.remove('open');
  $('#btnQueue').classList.remove('active');
  const lx = LX();
  if (!lx) return;
  lx.toggle();
  const on = lx.isOpen();
  $('#btnLyric').classList.toggle('active', on);
  const b2 = $('#btnLyric2');
  if (b2) b2.classList.toggle('active', on);
}
$('#btnLyric').onclick = toggleLyric;
$('#btnLyric2').onclick = toggleLyric;
$('#btnHome').onclick = () => go('home', {}, true);
$('#lpClose').onclick = () => { $('#lyricPanel').classList.remove('open'); $('#btnLyric').classList.remove('active'); };
$('#btnQueue').onclick = () => {
  const p = $('#queuePanel');
  const on = p.classList.toggle('open');
  $('#lyricPanel').classList.remove('open');
  $('#btnQueue').classList.toggle('active', on);
  $('#btnLyric').classList.remove('active');
  const lx = LX();
  if (lx && lx.isOpen()) lx.close();
};
$('#qClose').onclick = () => { $('#queuePanel').classList.remove('open'); $('#btnQueue').classList.remove('active'); };

/* 音频事件 */
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0;
  if (d) {
    $('#tCur').textContent = fmt(audio.currentTime);
    $('#tDur').textContent = fmt(d);
    setSeek(audio.currentTime / d);
  }
  syncLyric(audio.currentTime);
});
audio.addEventListener('play', () => { S.playing = true; updatePlayIcon(); });
audio.addEventListener('pause', () => { S.playing = false; updatePlayIcon(); });
audio.addEventListener('ended', () => playNext(true));
audio.addEventListener('error', () => {
  if (!audio.src) return;
  /* 先试着降一档音质再放弃：高端档位（3D WAV / 超高清）解码失败是常态，
     直接切歌对用户来说等于「这首歌坏了」。只有降到没有更低的档才真的跳过。 */
  if (toneCtx) { tryToneDown('解码失败'); return; }
  toast('音频加载失败，自动切歌');
  setTimeout(() => playNext(true), 900);
});

/* 键盘 */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); $('#btnPlay').click(); }
  else if (e.code === 'ArrowRight' && e.ctrlKey) $('#btnNext').click();
  else if (e.code === 'ArrowLeft' && e.ctrlKey) $('#btnPrev').click();
  else if (e.key === 'Escape') closeAllPanels();
});

/* ─────────────── 账号 / 个人中心 ─────────────── */
const TONE_ORDER = ['AV3A', 'ZQ32', 'ZQ24', 'Z3D', 'ZQ', 'SQ', 'HQ', 'PQ'];
const TONE_LABEL = {
  AV3A: '臻品音质', ZQ32: '臻品母带 32bit', ZQ24: '臻品母带 24bit',
  Z3D: '臻品三维声', ZQ: '臻品母带', SQ: '无损', HQ: '高清', PQ: '标准',
};
const toneLabel = (t) => TONE_LABEL[t] || t || '标准';
/**
 * 这两档咪咕给的是几十 MB 的 3D / 臻品 WAV（实测 71MB，Chromium readyState 恒 0），
 * 本地播放器解不了，所以不能当默认偏好，也不参与自动升档；真要听会由看门狗降到可解码档。
 */
const TONE_UNDECODABLE = { Z3D: 'ZQ', AV3A: 'ZQ' };
/** 云端全量档位（主进程给权威顺序，失败时用本地常量兜底） */
let TONE_ALL = TONE_ORDER.map((t) => ({ value: t, label: toneLabel(t) }));

const maskPhone = (m) => String(m || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');

/** 账号头像/昵称取最可靠的一份 */
function accountView() {
  const a = S.account || {};
  const p = a.profile || {};
  const v = a.vip || {};
  const auth = S.auth || {};
  const pc = a.pc || {};
  const nick = p.nickName || pc.nickName || (auth.msisdn ? '咪咕用户' : '');
  const phone = p.mobile || auth.msisdn || pc.msisdn || '';
  // 会员身份以身份项为准：体验会员的 memLevel 恒为 0，只有 identityItems/userServices 才有
  const isVip = v.isMember != null ? !!v.isMember : Number(v.memLevel || 0) > 0;
  return {
    nick: nick || '咪咕用户',
    phone,
    avatar: p.avatar || pc.avatar || '',
    province: p.province || '',
    city: p.city || '',
    memName: v.memName || (isVip ? '会员' : '非会员'),
    memLevel: Number(v.memLevel || 0),
    isTrial: !!v.isTrial,
    expire: v.expire || '',
    identities: v.identities || [],
    vipInfos: v.vipInfos || [],
    services: v.services || [],
    isVip,
    levelName: pc.levelName || '',
    credit: pc.credit || '',
    medals: pc.medals || [],
    tonePref: pc.toneListen || pc.toneDownload || '',
  };
}

/**
 * 音质下拉：始终渲染全量档位，当前曲目没有的档位标出来但不禁用。
 * 关键：绝不因为「当前这首没有该档」就改掉用户的偏好——否则听一首标准音质的歌，
 * 偏好会被静默降级，后面所有歌都只按标准播（这正是「最高音质只有无损」的由来）。
 * 真正取不到时由主进程逐档回落，并 toast 告知实际音质。
 */
function renderQualityOptions(qualities) {
  const sel = $('#selQuality');
  if (!sel) return;
  const q = (qualities || []).filter((x) => TONE_LABEL[x]);
  const has = q.length ? new Set(q) : null;
  // 注意：不能按 qualities 给档位标「此曲不提供」——实测 search 返回的 qualities 常缺档
  // （晴天 qualities=["Z3D","SQ","HQ","PQ"]，但请求 ZQ/ZQ24/AV3A 都能拿到 flac）。
  // 标错的比不标更伤人，所以只把「接口声称提供」放进 title 作参考。
  sel.innerHTML = TONE_ALL.map((t) => '<option value="' + t.value + '">' + esc(t.label) + '</option>').join('');
  if (!TONE_ALL.some((t) => t.value === S.quality)) S.quality = 'PQ';
  sel.value = S.quality;
  sel.title = has
    ? '当前曲目提供：' + q.map(toneLabel).join(' / ')
    : '按所选音质请求，服务端不支持时自动回落';
}

/** 当前曲目可用的音质档（来自 search/detail 的 qualities） */
function currentQualities() {
  const s = S.queue[S.qIndex];
  if (!s) return null;
  return s.qualities && s.qualities.length ? s.qualities : null;
}

/** 主进程后台刷新完账号后推过来：只更状态，不打断用户当前操作 */
if (M.onAuthUpdated) {
  M.onAuthUpdated(async (d) => {
    if (!d || !d.auth) return;
    const changed = JSON.stringify(d.account && d.account.profile) !== JSON.stringify(S.account && S.account.profile);
    S.auth = d.auth;
    S.account = d.account || null;
    paintAccount();
    if (changed && S.curRoute === 'me') go('me', {}, true);
  });
}

async function refreshAuth(opts) {
  opts = opts || {};
  try {
    if (!TONE_ALL || !TONE_ALL.length) {
      const t = await M.tones();
      if (Array.isArray(t) && t.length) TONE_ALL = t;
    }
    const r = await M.authStatus();
    S.auth = r && r.loggedIn ? r.auth : null;
    S.account = r && r.loggedIn ? (r.account || null) : null;
    paintAccount();
    // 账号音质上限：未登录/非会员时把高档位标出来，避免用户以为能解锁
    if ($('#selQuality')) renderQualityOptions(currentQualities());
    if (opts.repaintView && S.curRoute === 'me') go('me', {}, true);
    // 收藏跟着账号走：登录态变化后重新拉一次云端「我喜欢的」
    if (S.auth) refreshFavorites({ silent: true });
    else { S.favorite = []; S.favIds = {}; S.favLoaded = false; S.favError = ''; updateLikeBtn(); }
  } catch (e) { /* ignore */ }
}

/** 侧栏账号条 */
function paintAccount() {
  const a = accountView();
  const loggedIn = !!S.auth;
  $('#accName').textContent = loggedIn ? a.nick : '未登录';
  $('#accSub').textContent = loggedIn
    ? (a.isVip ? a.memName + (a.phone ? ' · ' + maskPhone(a.phone) : '') : (a.phone ? maskPhone(a.phone) : '已登录'))
    : '点击登录咪咕账号';
  $('#btnLogin').classList.toggle('active', loggedIn);

  const box = $('#accAva');
  const img = $('#accAvaImg');
  const txt = $('#accAvaTxt');
  if (loggedIn && a.avatar) {
    img.src = a.avatar; img.hidden = false; txt.hidden = true;
  } else {
    img.removeAttribute('src'); img.hidden = true; txt.hidden = false;
    txt.textContent = loggedIn ? a.nick.slice(0, 1) : '咪';
  }
  box.classList.toggle('vip', loggedIn && a.isVip);
}

/** 扫码通道已废弃：咪咕网页端二维码走 TV/大屏登录，手机 App 扫会提示「TV版扫码错误」。
 *  登录统一走 doLogin()（内嵌 passport 官方页 + 短信验证码）。下面这个空函数只为了
 *  让路由切换里的 stopQr() 调用保持原样，不再有任何轮询。 */
let qrTimer = null;
function stopQr() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  if (typeof smsStopTick === 'function') smsStopTick();
}


/* ─── 站内短信登录（不弹网页，直接打 passport 接口） ─── */
let smsTimer = null;
function smsStopTick() {
  if (smsTimer) { clearInterval(smsTimer); smsTimer = null; }
}
function smsMsg(text, kind) {
  const el = $('#smsMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'me-form-msg' + (kind ? ' ' + kind : '');
}
function bindSmsLogin() {
  const phoneEl = $('#smsPhone');
  const codeEl = $('#smsCode');
  const sendEl = $('#smsSend');
  const goEl = $('#smsGo');
  if (!phoneEl || !codeEl || !sendEl || !goEl) return;

  const phone = () => String(phoneEl.value || '').replace(/\D/g, '');

  let cool = 0;
  const tick = () => {
    cool -= 1;
    if (cool <= 0) {
      smsStopTick();
      sendEl.disabled = false;
      sendEl.textContent = '获取验证码';
      return;
    }
    sendEl.textContent = cool + 's 后重发';
  };

  sendEl.onclick = async () => {
    const n = phone();
    if (!/^1\d{10}$/.test(n)) { smsMsg('请输入 11 位手机号', 'bad'); phoneEl.focus(); return; }
    sendEl.disabled = true;
    sendEl.textContent = '发送中…';
    smsMsg('');
    const r = await M.smsSend(n);
    if (r && r.ok) {
      smsMsg('验证码已发送，请注意查收短信' + (r.isMiguUser ? '' : '（该号码可能还没注册咪咕账号）'), 'ok');
      cool = 60;
      smsStopTick();
      smsTimer = setInterval(tick, 1000);
      codeEl.focus();
    } else {
      sendEl.disabled = false;
      sendEl.textContent = '获取验证码';
      smsMsg((r && r.error) || '发送失败，请稍后重试', 'bad');
    }
  };

  const submit = async () => {
    const n = phone();
    const c = String(codeEl.value || '').replace(/\D/g, '');
    if (!/^1\d{10}$/.test(n)) { smsMsg('请输入 11 位手机号', 'bad'); phoneEl.focus(); return; }
    if (c.length < 4) { smsMsg('请输入收到的短信验证码', 'bad'); codeEl.focus(); return; }
    goEl.disabled = true;
    const old = goEl.textContent;
    goEl.textContent = '登录中…';
    smsMsg('正在登录…');
    const r = await M.smsLogin(n, c);
    goEl.disabled = false;
    goEl.textContent = old;
    if (r && r.ok) {
      smsStopTick();
      smsMsg('');
      S.account = r.account || null;
      S.auth = r.auth || (r.account && r.account.auth) || S.auth;
      await refreshAuth({ repaintView: true });
      toast('登录成功');
      if (S.curRoute === 'me') go('me', {}, true);
    } else {
      smsMsg((r && r.error) || '登录失败，请检查验证码', 'bad');
    }
  };

  goEl.onclick = submit;
  codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  phoneEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (sendEl.disabled) codeEl.focus(); else sendEl.click(); } });
  $('#meLogin').onclick = doLogin;
  setTimeout(() => { try { phoneEl.focus(); } catch (e) {} }, 60);
}

async function doLogin() {
  toast('正在打开登录页…');
  const r = await M.login();
  if (r && r.ok) {
    S.account = r.account || null;
    await refreshAuth({ repaintView: true });
    toast('登录成功');
    if (S.curRoute === 'me') go('me', {}, true);
  } else if (r && r.error && r.error !== '登录窗口已关闭') {
    toast(r.error);
  }
}

$('#btnLogin').onclick = async () => {
  if (S.auth) { go('me'); return; }
  await doLogin();
};
$('#accBox').onclick = () => { go('me'); };

/* ─────────────── 路由：个人中心 ─────────────── */
ROUTES.me = async (view) => {
  S.curRoute = 'me';
  if (!S.auth) {
    view.innerHTML =
      '<div class="view-head"><div><div class="view-title">个人中心</div>' +
      '<div class="view-sub">登录后同步会员权益、音质权限与云端歌单</div></div></div>' +
      '<div class="me-login">' +
      '<div class="me-login-h">' +
      '<div class="me-ava">咪</div>' +
      '<div><h2>登录咪咕账号</h2>' +
      '<p>用手机号 + 短信验证码直接登录，不用打开任何网页。' +
      '账号信息只保存在本机，不会上传。<br>' +
      '收不到短信时，也可以<b>打开咪咕官方登录页</b>用密码或短信登录。</p></div>' +
      '</div>' +
      '<div class="me-form">' +
      '<div class="me-field"><label>手机号</label>' +
      '<input type="tel" id="smsPhone" maxlength="11" placeholder="请输入 11 位手机号" autocomplete="tel"></div>' +
      '<div class="me-field"><label>验证码</label>' +
      '<div class="me-code-row">' +
      '<input type="text" id="smsCode" maxlength="8" placeholder="短信验证码" inputmode="numeric">' +
      '<button class="btn" id="smsSend">获取验证码</button>' +
      '</div></div>' +
      '<div class="me-form-foot">' +
      '<button class="btn primary big" id="smsGo">登录</button>' +
      '<button class="link-btn" id="meLogin">打开咪咕官方登录页</button>' +
      '</div>' +
      '<div class="me-form-msg" id="smsMsg"></div>' +
      '</div>' +
      '</div>';
    bindSmsLogin();
    return;
  }

  const a = accountView();
  view.innerHTML =
    '<div class="view-head"><div><div class="view-title">个人中心</div>' +
    '<div class="view-sub">咪咕音乐 · ' + (a.isVip ? esc(a.memName) : '普通用户') + '</div></div>' +
    '<div style="margin-left:auto;display:flex;gap:8px">' +
    '<button class="btn" id="meRefresh">刷新</button>' +
    '<button class="btn" id="meOut">退出登录</button></div></div>' +

    '<div class="me-hero">' +
    '<div class="me-ava">' + (a.avatar ? '<img src="' + esc(a.avatar) + '" alt="">' : esc(a.nick.slice(0, 1))) + '</div>' +
    '<div class="me-main">' +
    '<div class="me-nick">' + esc(a.nick) +
    '<span class="me-badge' + (a.isVip ? '' : ' free') + '">' + esc(a.memName) + '</span>' +
    (a.isTrial ? '<span class="me-badge trial">体验</span>' : '') +
    (a.levelName ? '<span class="me-badge lvl">' + esc(a.levelName) + '</span>' : '') +
    '</div>' +
    '<div class="me-meta">' +
    (a.phone ? '<span>手机号 <b>' + esc(maskPhone(a.phone)) + '</b></span>' : '') +
    (a.city || a.province ? '<span>地区 <b>' + esc([a.province, a.city].filter(Boolean).join(' ')) + '</b></span>' : '') +
    (a.isVip && a.expire ? '<span>会员有效期 <b>' + esc(a.expire) + '</b></span>' : '') +
    (a.credit ? '<span>' + esc(a.creditName || '成长值') + ' <b>' + esc(a.credit) + '</b></span>' : '') +
    '<span>默认音质 <b>' + esc(toneLabel(S.quality)) + '</b></span>' +
    '</div>' +
    '<div class="me-act">' +
    (a.isVip ? '' : '<button class="btn primary" id="meVip">开通会员</button>') +
    '<button class="btn" id="meFav">我的收藏 ' + (S.favLoaded ? (S.favorite || []).length : '—') + '</button>' +
    '<button class="btn" id="meRecent">最近播放 ' + (S.recent || []).length + '</button>' +
    '</div></div></div>' +

    (a.isVip && a.identities.length
      ? '<div class="me-card"><div class="me-card-h"><div class="me-card-t">会员身份</div>' +
        '<div class="me-card-s">' + (a.isTrial ? '体验会员在有效期内与付费会员享有同等播放权限' : '已生效的会员身份') + '</div></div>' +
        '<div class="me-rights">' +
        a.identities.map((it) => '<div class="me-right on" style="flex:1 1 100%">' +
          '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 1 7 7c0 3-2 5-3 6.5V18H8v-2.5C7 14 5 12 5 9a7 7 0 0 1 7-7m-3 18h6v1.5H9z"/></svg>' +
          '<span>' + esc(it.name) + (it.trial ? ' · 体验' : '') + '</span>' +
          '<span class="dot">' + esc(it.validTime && it.validTime.length >= 8
            ? it.validTime.slice(0, 4) + '-' + it.validTime.slice(4, 6) + '-' + it.validTime.slice(6, 8) + ' 到期'
            : '有效') + '</span>' +
          '</div>' +
          (it.desc ? '<div class="me-tip" style="flex:1 1 100%;margin:2px 0 0">' + esc(it.desc) + '</div>' : '')
        ).join('') +
        '</div></div>'
      : '') +

    '<div class="me-card"><div class="me-card-h"><div class="me-card-t">会员权益</div>' +
    '<div class="me-card-s">' + (a.isVip
      ? (a.isTrial ? '体验会员有效期内以下权益已生效' : '已生效的权益会高亮显示')
      : '当前为非会员，开通后以下权益生效') + '</div></div>' +
    '<div class="me-rights">' +
    (a.vipInfos.length
      ? a.vipInfos.map((v) => {
        // infoStatus 只表示「权益项存在」，是否真的可用要看当前有没有生效的会员身份
        const on = a.isVip && String(v.status) === '1';
        return '<div class="me-right' + (on ? ' on' : '') + '">' +
          '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 1 7 7c0 3-2 5-3 6.5V18H8v-2.5C7 14 5 12 5 9a7 7 0 0 1 7-7m-3 18h6v1.5H9z"/></svg>' +
          '<span>' + esc(v.name) + '</span>' +
          '<span class="dot">' + (on ? '可用' : '未开通') + '</span></div>';
      }).join('')
      : '<div class="me-right">暂无权益数据</div>') +
    '</div></div>' +

    '<div class="me-card"><div class="me-card-h"><div class="me-card-t">账号信息</div></div>' +
    '<div class="me-rows">' +
    '<div class="me-row"><span class="k">用户 ID</span><span class="v mono">' + esc((S.auth && S.auth.uid) || (S.account && S.account.profile && S.account.profile.userId) || '—') + '</span></div>' +
    '<div class="me-row"><span class="k">登录方式</span><span class="v">' + esc((S.auth && S.auth.authType) || '—') + '</span></div>' +
    '<div class="me-row"><span class="k">会话 ID</span><span class="v mono">' + esc((S.auth && S.auth.sid) || '—') + '</span></div>' +
    '<div class="me-row"><span class="k">凭证</span><span class="v mono">' + esc((S.auth && S.auth.pacmtoken ? S.auth.pacmtoken.slice(0, 10) + '…' + S.auth.pacmtoken.slice(-6) : '—')) + '</span></div>' +
    '<div class="me-row"><span class="k">本机设备</span><span class="v mono">' + esc((S.auth && S.auth.deviceId) || '—') + '</span></div>' +
    '</div></div>' +

    '<div class="me-card"><div class="me-card-h"><div class="me-card-t">音质偏好</div>' +
    '<div class="me-card-s">播放时按此档位请求，无权限会自动逐档回落</div></div>' +
    '<div class="me-rights">' +
    TONE_ALL.map((t) => '<div class="me-right' + (t.value === S.quality ? ' on' : '') + '" data-tone="' + esc(t.value) + '">' +
      '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3z"/></svg>' +
      '<span>' + esc(t.label) + '</span>' +
      '<span class="dot">' + esc(t.value) + '</span></div>').join('') +
    '</div>' +
    '<div class="me-tip" style="margin-top:14px">' +
    '臻品母带 / 24bit / 32bit / 三维声等超清档位需要对应会员权益；无权限时请求会按 32bit → 24bit → 三维声 → 臻品母带 → 无损 → 高清 → 标准 逐档回落，并在界面提示实际播放音质。' +
    '</div></div>';

  // 交互
  const pick = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  pick('meVip', () => M.openExternal('https://music.migu.cn/v5/pages/vip/index'));
  pick('meFav', () => go('favorite'));
  pick('meRecent', () => go('recent'));
  pick('meRefresh', async () => {
    toast('正在刷新账号信息…');
    el_disabled($('#meRefresh'), true);
    try {
      const r = await M.authRefresh();
      if (r && r.loggedIn) { await refreshAuth(); go('me', {}, true); toast('已刷新'); }
      else if (r && r.expired) { await refreshAuth(); toast('登录已过期，请重新登录'); go('me', {}, true); }
      else toast('刷新失败');
    } catch (e) { toast('刷新失败'); }
    el_disabled($('#meRefresh'), false);
  });
  pick('meOut', async () => {
    if (!confirm('确定退出当前咪咕账号？')) return;
    await M.logout();
    S.account = null;
    await refreshAuth();
    toast('已退出登录');
    go('me', {}, true);
  });
  $$('[data-tone]', view).forEach((el) => {
    el.onclick = () => {
      S.quality = el.dataset.tone;
      M.storeSet({ quality: S.quality });
      renderQualityOptions(currentQualities());
      toast('默认音质：' + toneLabel(S.quality));
      go('me', {}, true);
    };
  });
};

function el_disabled(el, on) { if (el) { el.disabled = !!on; el.style.opacity = on ? '.55' : ''; } }

/* ─────────────── 启动 ─────────────── */
(async function boot() {
  try {
    const st = await M.storeGet();
    if (st) {
      S.recent = st.recent || [];   // 收藏不再是本地数据，改由 refreshFavorites() 从账号拉
      S.volume = typeof st.volume === 'number' ? st.volume : 0.8;
      S.quality = st.quality || 'PQ';
    }
  } catch (e) { /* ignore */ }
  // 旧版本可能把 Z3D/AV3A 存成了偏好；这两档本机解不了，静默迁到可播放的最高档
  if (TONE_UNDECODABLE[S.quality]) {
    S.quality = TONE_UNDECODABLE[S.quality];
    M.storeSet({ quality: S.quality });
  }
  try {
    const tones = await M.tones();
    if (Array.isArray(tones) && tones.length) TONE_ALL = tones;
  } catch (e) { /* ignore */ }
  renderQualityOptions(null);
  audio.volume = S.volume;
  updateVol();
  updatePlayIcon();

  /* 沉浸浮动歌词引擎 */
  const lx = LX();
  if (lx) {
    lx.init({
      host: $('#app'),
      onSeek: (t) => {
        if (!audio.duration) return;
        audio.currentTime = Math.max(0, Math.min(audio.duration - 0.05, t));
        setSeek(audio.currentTime / audio.duration);
        $('#tCur').textContent = fmt(audio.currentTime);
        lx.setTime(audio.currentTime);
      },
      onClose: () => $('#btnLyric').classList.remove('active'),
    });
    lx.setTrack(S.queue[S.qIndex] || null);
  }
  await refreshAuth();
  // 本地没存过音质偏好时，跟随账号：会员默认「无损」，非会员「标准」。
  // 咪咕 PC 端自己的偏好记在 queryUserInfo 的 setting 里（08-<tone>），有就照它来。
  try {
    const st2 = await M.storeGet();
    // 体验会员/会员的一次性抬档：老版本（或旧测试）把偏好留在了 PQ/HQ/SQ，
    // 用户看到的就是「最高只有无损」。只迁一次，之后手动选的档位不再被覆盖。
    const av = accountView();
    if (av.isVip && !(st2 && st2.qualityV2) && ['PQ', 'HQ', 'SQ', ''].includes(String((st2 && st2.quality) || '').toUpperCase())) {
      S.quality = 'ZQ';
      M.storeSet({ quality: S.quality, qualityV2: true });
      renderQualityOptions(currentQualities());
    }
    if (!st2 || !st2.quality) {
      const a = accountView();
      const cloud = String(a.tonePref || '').toUpperCase();
      // 会员（含体验会员）默认直接给「臻品母带」：实测它下发的是 .flac，Chromium 能解；
      // 咪咕云端 setting 里的 08-PQ 只是它自己的老默认值，照搬等于把会员权益白放着不用。
      // 单曲没有这档时由主进程逐档回落并 toast 交代，用户偏好本身不被改写。
      if (a.isVip) S.quality = TONE_UNDECODABLE[cloud] || !TONE_LABEL[cloud] ? 'ZQ' : cloud;
      else S.quality = TONE_LABEL[cloud] ? cloud : 'PQ';
      M.storeSet({ quality: S.quality, qualityV2: true });
      renderQualityOptions(currentQualities());
    }
  } catch (e) { /* ignore */ }
  go('home', {}, true);
})();
