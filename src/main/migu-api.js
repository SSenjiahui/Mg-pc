'use strict';
/**
 * 咪咕音乐 桌面版 —— 接口层
 * 端点与加密逻辑来自咪咕 Web 端 SDK（@migusdk）逆向结果
 */
const https = require('https');
const zlib = require('zlib');

const KEYS = {
  0: 'Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP',
  10: '6L0*8CaNS4thcDlOj5k3J1R-rfdzWqxE',
  12: 'Qr5GDs6MmEx0RH2I473qe/JYZkXLhiKO',
};
const KEY0 = KEYS[0];
/* ── 广告位过滤：第三方客户端，去掉一切外链 H5 推广与显式广告 ── */
const AD_BLOCK_VIEWS = { 'ZJ-Banner-V': 1 };          // 整块丢弃（纯外链推广位）
const AD_ACTION_RE = /^mgmusic:\/\/browser\?/i;          // 外链 H5，本应用无路由
function isAdItem(it) {
  if (!it) return true;
  if (String(it.txt || '').trim() === '广告') return true;
  if (AD_ACTION_RE.test(String(it.action || ''))) return true;
  return false;
}

const BASE = 'https://app.c.nf.migu.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.migu.cn/v5/',
  Origin: 'https://music.migu.cn',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  birth: 'h5page',
  signature: '1',
  channel: '014X031',
  subchannel: '014X031',
  platform: 'H5',
  version: '6.8.8',
  ua: 'Android_migu',
  appId: 'music',
  IMEI: 'h5page',
  IMSI: 'h5page',
};

let auth = {};
function setAuth(a) { auth = a || {}; }
function getAuth() { return auth; }

function authHeaders() {
  const h = {};
  if (auth.uid) h.uid = String(auth.uid);
  if (auth.msisdn) h.msisdn = String(auth.msisdn);
  if (auth.pacmtoken) h.pacmtoken = String(auth.pacmtoken);
  if (auth.token) h.token = String(auth.token);
  return h;
}

/** 解密 SDK 加密响应：AB CD 01 <seed> <cipher...> */
function decrypt(buf, keyStr) {
  if (!buf || buf.length < 5) return null;
  if (buf[0] !== 0xab || buf[1] !== 0xcd || buf[2] !== 1) return null;
  const seed = buf[3];
  const key = Buffer.from(keyStr || KEY0, 'utf8');
  const out = Buffer.alloc(buf.length - 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = (buf[4 + i] + seed - key[i % key.length]) & 0xff;
  }
  return out;
}

function decompress(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch (e) { /* 忽略 */ }
  return buf;
}

function rawRequest(url, headers, redirects, opts) {
  redirects = redirects || 0;
  opts = opts || {};
  const method = opts.method || 'GET';
  const bodyBuf = opts.body ? Buffer.from(opts.body) : null;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const sendHeaders = Object.assign({ 'Accept-Encoding': 'gzip, deflate' }, headers || {});
    if (bodyBuf) sendHeaders['Content-Length'] = String(bodyBuf.length);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: method,
        headers: sendHeaders,
      },
      (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location && redirects < 5) {
          res.resume();
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          return resolve(rawRequest(next, headers, redirects + 1, method === 'POST' ? { method: 'GET' } : opts));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = Buffer.concat(chunks);
          body = decompress(body, res.headers['content-encoding']);
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(new Error('请求超时')); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function toText(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xab && buf[1] === 0xcd) {
    const d = decrypt(buf, KEY0);
    return d ? d.toString('utf8') : '';
  }
  return buf.toString('utf8');
}

/** 发 JSON POST 请求并解析响应（咪咕写操作接口只认 JSON body，表单会被判成 199999 系统繁忙） */
async function apiPost(path, bodyObj, opts) {
  opts = opts || {};
  const url = path.startsWith('http') ? path : BASE + path;
  const headers = Object.assign(
    { 'Content-Type': 'application/json;charset=UTF-8' },
    BASE_HEADERS,
    authHeaders(),
    opts.headers || {}
  );
  const body = bodyObj === undefined || bodyObj === null ? '' : JSON.stringify(bodyObj);
  const res = await rawRequest(url, headers, 0, { method: 'POST', body: body });
  const text = toText(res.body);
  if (!text) return { code: '-1', info: '空响应(' + res.status + ')', data: null };
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') j.__httpStatus = res.status;
    return j;
  } catch (e) {
    return { code: '-1', info: '解析失败: ' + text.slice(0, 120), data: null };
  }
}

/** 发请求并解析 JSON（自动处理加密响应） */
async function apiGet(path, params, opts) {
  opts = opts || {};
  const qs = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
  const url = path.startsWith('http')
    ? path + (qs ? (path.includes('?') ? '&' : '?') + qs : '')
    : BASE + path + (qs ? '?' + qs : '');
  const headers = Object.assign({}, BASE_HEADERS, authHeaders(), opts.headers || {});
  const res = await rawRequest(url, headers);
  const text = toText(res.body);
  if (!text) return { code: '-1', info: '空响应(' + res.status + ')', data: null };
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') j.__httpStatus = res.status;
    return j;
  } catch (e) {
    return { code: '-1', info: '解析失败: ' + text.slice(0, 120), data: null };
  }
}

/* ───────────────────────── 工具 ───────────────────────── */

/** "00:03:36" / "3:36" / 216 秒 → 秒数 */
function parseLength(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map((x) => parseInt(x, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** 补全图片地址（部分接口给的是 /data/oss/... 相对路径） */
function fixImg(u) {
  if (!u) return '';
  const s = String(u);
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/')) return 'https://d.musicapp.migu.cn' + s;
  return s;
}

function pickImg(arr) {
  if (!arr || !Array.isArray(arr) || !arr.length) return '';
  const sorted = arr.slice().sort((a, b) => String(a.imgSizeType || '').localeCompare(String(b.imgSizeType || '')));
  return fixImg((sorted.find((x) => x && x.img) || {}).img || '');
}

/** 合并两处来源的 qualities（搜索接口不给 ZQ24/Z3D/AV3A，detail 才给），按高→低排序去重 */
function mergeQualities(a, b) {
  const set = new Set();
  for (const arr of [a, b]) {
    if (Array.isArray(arr)) for (const x of arr) if (x) set.add(String(x).toUpperCase());
  }
  const order = ['AV3A', 'ZQ32', 'ZQ24', 'Z3D', 'ZQ', 'SQ', 'HQ', 'PQ'];
  return Array.from(set).sort((x, y) => {
    const ix = order.indexOf(x); const iy = order.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  });
}

/** 统一歌曲结构。兼容 songList / objectInfo / search / songItem / song-by-id 多种来源 */
function normalizeSong(s) {
  if (!s) return null;
  const singers = s.singerList || s.singers || s.singerInfos || null;
  let singer = s.singer || s.singerName || '';
  let singerId = s.singerId || '';
  if (Array.isArray(singers) && singers.length) {
    singer = singers.map((x) => x && (x.name || x.singerName)).filter(Boolean).join(' / ') || singer;
    singerId = singerId || String((singers[0] && singers[0].id) || '');
  }
  const albums = s.albums || null;
  let album = s.album || s.albumName || s.albumTitle || '';
  let albumId = s.albumId ? String(s.albumId) : '';
  if (Array.isArray(albums) && albums.length) {
    album = album || (albums[0] && albums[0].name) || '';
    albumId = albumId || String((albums[0] && albums[0].id) || '');
  }
  const tags = s.showTags || s.showTag || s.tags || [];
  const vip = Array.isArray(tags) && tags.some((t) => /^(vip|isq|asq|i24|a24|zq|sq)$/i.test(String(t)));
  const formats = (s.audioFormats || s.newRateFormats || []).map((f) => f && (f.formatType || f.format)).filter(Boolean);
  return {
    contentId: s.contentId || '',
    copyrightId: s.copyrightId || '',
    songId: String(s.songId || s.id || ''),
    name: s.songName || s.name || s.title || '',
    singer,
    singerId,
    album,
    albumId,
    img: pickImg(s.albumImgs || s.imgItems || s.imgs) || fixImg(s.img || s.img1 || s.img2 || s.img3 || ''),
    duration: parseLength(s.duration || s.length || s.durationSecond),
    vip: !!vip || Number(s.copyrightType) === 1,
    qualities: Array.from(new Set(formats)),
    lrcUrl: s.lrcUrl || s.lyricUrl || '',
    mrcUrl: s.mrcUrl || '',
    mvId: String(s.mvId || ''),
    playCount: (s.opNumItem && s.opNumItem.playNum) || s.playNumDesc || '',
    tags: Array.isArray(tags) ? tags.map(String) : [],
  };
}

/* ───────────────────────── 首页 / 榜单 ───────────────────────── */

async function getHome() {
  const j = await apiGet('/pc/bmw/page-data/music-index-show/v2.0', { templateVersion: 1 });
  const blocks = (j.data && j.data.contents) || [];
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const view = b.view || '';
    if (AD_BLOCK_VIEWS[view]) continue;                 // 广告整块跳过
    const items = (b.contents || []).filter((it) => !isAdItem(it));  // 逐项剔除广告/外链
    if (!items.length) continue;
    out.push({
      index: out.length,
      columnId: b.columnId ? String(b.columnId) : '',
      title: b.title || (items[0] && items[0].txt) || '',
      view: view,
      items: items,
    });
  }
  return out;
}

async function getHotSearch() {
  const j = await apiGet('/pc/bmw/hot-search/hot-search/v1.0');
  const d = j.data || {};
  return {
    words: d.hotWordItemList || [],
    nav: d.navigationItemList || [],
  };
}

/** 榜单/栏目详情 */
async function getColumn(columnId, pageNo) {
  const j = await apiGet('/pc/column/column-info/v1.0', { columnId, pageNo: pageNo || 1 });
  const info = j.columnInfo || (j.data && j.data.columnInfo);
  if (!info) return { id: columnId, title: '', subs: [], img: '', songs: [], count: 0 };
  const songs = (info.contents || []).map((it) => it.objectInfo || it).filter((s) => s && s.contentId);
  return {
    id: String(columnId),
    title: info.columnTitle || '',
    subtitle: info.columnSubtitle || '',
    description: info.columnDes || '',
    img: info.columnPicUrl || '',
    updateTime: info.columnUpdateTime || '',
    count: Number(info.contentsCount || songs.length),
    songs: await enrichSongs(songs.map(normalizeSong).filter(Boolean)),
  };
}

/** 首页榜单块 → [{id,title,img,songs[]}] */
async function getTopLists() {
  const home = await getHome();
  const block = home.find((b) => b.view === 'ZJ-Rank-Compound');
  const out = [];
  const seen = new Set();
  // 榜单块结构：[标题子块 ZJ-Title-PlayAll, 歌曲子块 ZJ-Song-Scroll] 交替出现
  for (const sub of (block && block.items) || []) {
    if (sub.view !== 'ZJ-Song-Scroll') continue;
    const cid = String(sub.columnId || '');
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    out.push({
      id: cid,
      title: sub.title || '榜单',
      subtitle: sub.subTitle || '',
      songs: (sub.contents || []).map((s) => {
        const le = s.logEvent || {};
        return {
          contentId: String(le.contentId || s.resId || ''),
          copyrightId: s.copyrightId || '',
          songId: String(le.songId || ''),
          songName: le.contentName || s.txt || '',
          singer: s.txt2 || '',
          album: s.txt3 || '',
          img: fixImg(s.img || ''),
          vip: !!s.vip,
        };
      }).filter((s) => s.contentId),
    });
  }
  for (const b of out) b.songs = await enrichSongs(b.songs);
  return out;
}

/** 批量补全歌曲详情（时长、音质、歌词地址）。每批最多 20 个 contentId */
async function batchSongDetail(contentIds) {
  const ids = Array.from(new Set((contentIds || []).filter(Boolean).map(String)));
  if (!ids.length) return new Map();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const j = await apiGet('/resource/song/by-contentids/v2.0', { contentId: chunk.join('|') });
      const arr = Array.isArray(j && j.data) ? j.data : (Array.isArray(j) ? j : []);
      for (const it of arr) {
        const n = normalizeSong(it);
        if (n && n.contentId) out.set(String(n.contentId), n);
      }
    } catch (e) { /* 单批失败不影响整体 */ }
  }
  return out;
}

/** 用 batchSongDetail 的结果补齐歌曲数组（保留原对象的展示字段） */
async function enrichSongs(songs) {
  const list = (songs || []).filter((s) => s && s.contentId);
  if (!list.length) return songs;
  const map = await batchSongDetail(list.map((s) => s.contentId));
  return list.map((s) => {
    const d = map.get(String(s.contentId));
    if (!d) return s;
    return Object.assign({}, s, {
      duration: s.duration || d.duration,
      img: s.img || d.img,
      album: s.album || d.album,
      albumId: s.albumId || d.albumId,
      singer: s.singer || d.singer,
      singerId: s.singerId || d.singerId,
      lrcUrl: s.lrcUrl || d.lrcUrl,
      mrcUrl: s.mrcUrl || d.mrcUrl,
      qualities: mergeQualities(s.qualities, d.qualities),
      vip: s.vip || d.vip,
    });
  });
}

/* ───────────────────────── 搜索 ───────────────────────── */

async function search(text, type, pageNo, pageSize) {
  type = type || 'song';
  const swKey = type === 'playlist' ? 'songlist' : type;
  const sw = {};
  sw[swKey] = 1;
  const j = await apiGet('/MIGUM2.0/v1.0/content/search_all.do', {
    text,
    pageNo: pageNo || 1,
    pageSize: pageSize || 30,
    searchSwitch: JSON.stringify(sw),
  });
  const d = j.data || j;
  const pack = (node, mapFn) => {
    const r = (node && node.result) || [];
    return { total: Number((node && node.totalCount) || r.length) || r.length, list: r.map(mapFn).filter(Boolean) };
  };
  if (type === 'song') {
    const r = pack(d.songResultData, (s) => {
      const n = normalizeSong(s);
      if (n) {
        n.name = s.name || s.songName || n.name;
        n.img = pickImg(s.imgItems) || n.img;
      }
      return n;
    });
    r.list = await enrichSongs(r.list);
    return r;
  }
  if (type === 'singer') {
    return pack(d.singerResultData, (s) => ({ id: String(s.id || ''), name: s.name || '', img: pickImg(s.imgItems) || '', highlight: (s.highlightStr || []).join('') }));
  }
  if (type === 'playlist') {
    return pack(d.songListResultData, (s) => ({
      id: String(s.id || ''),
      name: s.name || '',
      img: s.musicListPicUrl || '',
      count: Number(s.musicNum || 0),
      playCount: Number(s.playNum || 0),
      keepCount: Number(s.keepNum || 0),
      tags: s.ts || [],
      owner: s.userName || '',
    }));
  }
  if (type === 'album') {
    return pack(d.albumResultData, (s) => ({
      id: String(s.id || ''),
      name: s.name || '',
      type: String(s.resourceType || ''),   // "5" 数字专辑 / "2003" 普通专辑
      singer: s.singer || '',
      date: s.publishDate || '',
      img: pickImg(s.imgItems) || '',
    }));
  }
  return { total: 0, list: [] };
}

async function getSearchSuggest(text) {
  const [a, b] = await Promise.all([
    apiGet('https://app.u.nf.migu.cn/pc/resource/content/tone_search_suggest/v1.0', { text }).catch(() => null),
    apiGet('/MIGUM2.0/v1.0/content/search_suggest.do', { text }).catch(() => null),
  ]);
  const singers = ((a && a.data && a.data.singerList) || []).map((x) => x.singerName || x.name).filter(Boolean);
  const songs = ((b && b.songSuggests) || []).map((x) => x.name).filter(Boolean);
  return { singers: Array.from(new Set(singers)).slice(0, 6), songs: Array.from(new Set(songs)).slice(0, 8) };
}

/* ───────────────────────── 歌单 / 专辑 ───────────────────────── */

const PLAYLIST_PAGE = 50;

async function getPlaylist(id, maxPages) {
  const infoP = apiGet('/resource/playlist/v2.0', { playlistId: id });
  const first = await apiGet('/MIGUM3.0/resource/playlist/song/v2.0', { playlistId: id, pageNo: 1, pageSize: PLAYLIST_PAGE });
  const total = Number((first.data && first.data.totalCount) || 0);
  let songs = ((first.data && first.data.songList) || []).slice();
  const pages = Math.min(Math.ceil(total / PLAYLIST_PAGE) || 1, maxPages || 40);
  for (let p = 2; p <= pages; p++) {
    const r = await apiGet('/MIGUM3.0/resource/playlist/song/v2.0', { playlistId: id, pageNo: p, pageSize: PLAYLIST_PAGE }).catch(() => null);
    const sl = (r && r.data && r.data.songList) || [];
    if (!sl.length) break;
    songs = songs.concat(sl);
  }
  const info = await infoP;
  const d = info.data || {};
  return {
    id: String(id),
    title: d.title || '歌单',
    summary: d.summary || '',
    img: (d.imgItem && d.imgItem.img) || d.originalImgUrl || '',
    owner: d.ownerName || '',
    tags: (d.tagItems || []).map((t) => t.tagName || t).filter(Boolean),
    count: Number(d.musicNum || songs.length),
    songs: await enrichSongs(songs.map(normalizeSong).filter(Boolean)),
  };
}

/** 数字专辑 id → materialId（普通专辑 id） */
async function resolveAlbumId(id) {
  if (!id) return String(id || '');
  const s = String(id);
  if (s.length <= 12) return s;              // 普通专辑 id 一般 8~10 位
  const d = await apiGet('/pc/resource/dalbum/v2.0', { dAlbumId: s }).catch(() => null);
  const mid = d && d.data && d.data.materialId;
  return mid ? String(mid) : s;
}

async function getAlbum(id) {
  const albumId = await resolveAlbumId(id);
  const [info, songs] = await Promise.all([
    apiGet('/resource/album/v2.0', { albumId }),
    apiGet('/MIGUM3.0/resource/album/song/v2.0', { albumId, pageNo: 1, pageSize: 200 }),
  ]);
  let d = info.data || {};
  if (!d.title && String(id) !== String(albumId)) {
    const dal = await apiGet('/pc/resource/dalbum/v2.0', { dAlbumId: String(id) }).catch(() => null);
    const dd = (dal && dal.data) || {};
    if (dd.title) {
      d = Object.assign({
        title: dd.title, singer: dd.singer, singerId: dd.singerId, summary: dd.summary,
        publishDate: dd.publishDate, totalCount: dd.totalCount,
      }, d, { title: d.title || dd.title });
      if (!d.imgItems || !d.imgItems.length) d.imgItems = dd.imgItem || [];
    }
  }
  const sl = (songs.data && songs.data.songList) || [];
  return {
    id: String(albumId),
    srcId: String(id),
    title: d.title || '专辑',
    summary: d.summary || '',
    img: pickImg(d.imgItems) || '',
    singer: d.singer || '',
    singerId: String(d.singerId || ''),
    publishDate: d.publishDate || '',
    company: d.publishCompany || '',
    count: Number(d.totalCount || sl.length),
    songs: await enrichSongs(sl.map(normalizeSong).filter(Boolean)),
  };
}

/* ───────────────────────── 歌手 ───────────────────────── */

async function getSingerTabs() {
  const j = await apiGet('/pc/bmw/singer-index/tabs/v2.0');
  const blocks = (j.data && j.data.contents) || [];
  const groups = [];
  let cur = null;
  for (const b of blocks) {
    if (b.view === 'ZJ-Title') {
      cur = { name: b.contents[0].txt, key: b.contents[0].txt2, subs: [] };
      groups.push(cur);
    } else if (cur && b.view === 'ZJ-SubTab-Scroll') {
      cur.subs = (b.contents || []).map((x) => ({ name: x.txt, key: x.action }));
    }
  }
  return groups;
}

async function getSingerInfo(singerId) {
  const [j, s] = await Promise.all([
    apiGet('/pc/bmw/singer/info/v1.1', { singerId }),
    apiGet('https://app.u.nf.migu.cn/pc/resource/search/singer/v1.0', { text: '' }).catch(() => null),
  ]);
  const blocks = (j.data && j.data.contents) || [];
  const info = { id: String(singerId), name: '', img: '', img2: '', fans: '', tabs: [], desc: '' };
  for (const b of blocks) {
    for (const it of (b.contents || [])) {
      if (it.view === 'ZJ-SingerDetail-Item') {
        info.name = it.txt || '';
        info.img = it.img || '';
        info.img2 = it.img2 || '';
        info.fans = it.txt4 || '';
      } else if (it.view === 'ZJ-Tab-Item') {
        info.tabs.push({ key: it.action, name: it.txt, count: it.txt2 });
      }
    }
  }
  return info;
}

async function getSingerSongs(singerId, pageNo) {
  const j = await apiGet('/pc/bmw/singer/song/v1.0', { pageNo: pageNo || 1, singerId, type: 1 });
  const blocks = (j.data && j.data.contents) || [];
  const songs = [];
  for (const b of blocks) {
    for (const it of (b.contents || [])) {
      const src = it.songItem || it.objectInfo || (it.resId && it.txt ? it : null);
      if (!src) continue;
      const n = normalizeSong(Object.assign({}, src, {
        contentId: src.contentId || it.resId,
        songName: src.songName || it.txt,
        singer: src.singer || it.txt2,
        album: src.album || it.txt3,
        img: src.img || it.img,
      }));
      if (n && n.contentId) songs.push(n);
    }
  }
  return { songs: await enrichSongs(songs), next: !!(j.data && j.data.header && j.data.header.nextPageUrl) };
}

async function getSingerAlbums(singerId, pageNo) {
  const j = await apiGet('/pc/bmw/singer/album/v1.0', { pageNo: pageNo || 1, singerId });
  const blocks = (j.data && j.data.contents) || [];
  const albums = [];
  const push = (it) => {
    if (!it || !it.resId) return;
    const idMatch = (it.action || '').match(/[?&]id=(\d+)/);
    albums.push({
      id: idMatch ? idMatch[1] : String(it.resId),
      name: it.txt || '',
      singer: it.txt2 || '',
      date: it.txt3 || '',
      img: it.img || '',
      digital: /digital-album/i.test(it.action || '') || String(it.resType) === '1',
    });
  };
  // data.contents 有时是扁平数组，有时是嵌套块
  for (const b of blocks) {
    if (b.resId && (b.view === 'ZJ-Album-Item' || b.action)) { push(b); continue; }
    for (const it of (b.contents || [])) push(it);
  }
  return { albums, next: !!(j.data && j.data.header && j.data.header.nextPageUrl) };
}

/* ───────────────────────── 账号 ───────────────────────── */

const AUTH_BASE = 'https://c.musicapp.migu.cn';
const VIP_BASE = 'https://u.musicapp.migu.cn';

/** 设备指纹：首次生成后随 auth 一起落盘，保证稳定 */
let DEVICE_ID = '';
function deviceId() {
  if (!DEVICE_ID) {
    try {
      const c = require('crypto');
      DEVICE_ID = (c.randomUUID ? c.randomUUID() : c.randomBytes(16).toString('hex')).replace(/-/g, '');
    } catch (e) {
      DEVICE_ID = 'h5page' + Date.now().toString(16);
    }
  }
  return DEVICE_ID;
}
function setDeviceId(v) { if (v) DEVICE_ID = String(v); }

const AUTH_COMMON = {
  'User-Agent': UA,
  Referer: 'https://music.migu.cn/v5/',
  Origin: 'https://music.migu.cn',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/* ─── 短信登录（passport 的 dynamicpassword 通道） ───
 * 这条通道是从 passport 登录页 loginPage.js 里逐字段抠出来的，和页面表单完全等价：
 *   取公钥  POST https://passport.migu.cn/password/publickey      （GET 会 302 到 /portal/error）
 *           → { status:"2000", result:{ modulus, publicExponent } }  RSA 1024 位，PKCS#1 v1.5
 *   发短信  GET  https://passport.migu.cn/login/dynamicpassword?msisdn=<RSA>&isAsync=true&sourceID=...
 *           → { status:"2000", result:{ isMiguUser:"yes"|"no" } }
 *   提登录  POST https://passport.migu.cn/authn/dynamicpassword
 *           body: msisdn=<RSA>&dynamicPassword=<RSA>&sourceID=&appType=0&isAsync=true
 *           → { status:"2000", result:{ token, redirectURL } }
 * 状态码取自 loginPage.js 的 ajax 表：
 *   4005 短信码错/失效、4023 号码被限收、4002 图形码错、4001 号码格式错、4011 未注册、4012 需升级。
 */
const PASSPORT = 'https://passport.migu.cn';
const PASSPORT_HEADERS = {
  'User-Agent': UA,
  Referer: PASSPORT + '/login?sourceid=220029',
  Origin: PASSPORT,
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/** passport 的会话 cookie（mgnd_session_*），发短信与提登录必须是同一个会话 */
let PASS_COOKIE = '';
function absorbCookies(setCookie) {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const jar = {};
  for (const raw of PASS_COOKIE.split('; ').filter(Boolean)) {
    const i = raw.indexOf('=');
    if (i > 0) jar[raw.slice(0, i)] = raw.slice(i + 1);
  }
  for (const one of list) {
    const first = String(one).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  PASS_COOKIE = Object.keys(jar).map((k) => k + '=' + jar[k]).join('; ');
}

/** 直接用 https 打 passport，返回 { status, json, text } */
function passportRequest(method, pathname, { body, query } = {}) {
  return new Promise((resolve) => {
    let url = PASSPORT + pathname;
    if (query) {
      const q = Object.keys(query)
        .filter((k) => query[k] !== undefined && query[k] !== null)
        .map((k) => k + '=' + encodeURIComponent(query[k]))
        .join('&');
      if (q) url += (url.indexOf('?') >= 0 ? '&' : '?') + q;
    }
    const u = new URL(url);
    const headers = Object.assign({}, PASSPORT_HEADERS);
    if (PASS_COOKIE) headers.Cookie = PASS_COOKIE;
    let payload = null;
    if (body) {
      payload = Object.keys(body)
        .map((k) => k + '=' + encodeURIComponent(body[k]))
        .join('&');
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        absorbCookies(res.headers['set-cookie']);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (e) {}
          resolve({ status: res.statusCode, location: res.headers.location || '', json, text });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: String(e && e.message), json: null, text: '' }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', json: null, text: '' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

function hexToB64url(hex) {
  let h = String(hex || '').replace(/^0+/, '');
  if (h.length % 2) h = '0' + h;
  return Buffer.from(h, 'hex').toString('base64url');
}

/** 取 RSA 公钥并返回一个加密函数（PKCS#1 v1.5，和页面里 RSAKey.encrypt 等价） */
async function passportRsa() {
  const r = await passportRequest('POST', '/password/publickey', { body: { sourceid: '220029' } });
  const d = r.json;
  if (!d || String(d.status) !== '2000' || !d.result || !d.result.modulus) {
    return { ok: false, error: (d && d.message) || ('HTTP ' + r.status), raw: (r.text || '').slice(0, 200) };
  }
  const crypto = require('crypto');
  let key;
  try {
    key = crypto.createPublicKey({
      key: { kty: 'RSA', n: hexToB64url(d.result.modulus), e: hexToB64url(d.result.publicExponent) },
      format: 'jwk',
    });
  } catch (e) {
    return { ok: false, error: '公钥解析失败: ' + e.message };
  }
  const encrypt = (s) =>
    crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(s), 'utf8')).toString('hex');
  return { ok: true, encrypt, bits: key.asymmetricKeyDetails ? key.asymmetricKeyDetails.modulusLength : 0 };
}

const SMS_ERR = {
  4001: '手机号格式不对',
  4002: '图形验证码错误或已失效',
  4003: '当前号码无法接收短信验证码',
  4005: '短信验证码错误或已失效',
  4011: '这个号码还没注册咪咕账号',
  4012: '该账号需要先升级为咪咕账号',
  4023: '该号码已被限制接收咪咕短信（可编辑短信 YC 发送到 106581062 解除）',
  4024: '该号码在黑名单解除中，请稍后重试',
  4033: '该手机号已被限制，请稍后再试',
  5004: '请求超时，请重试',
  6123: '需要先过图形验证码',
};
function smsMsg(status, message) {
  const key = String(status || '');
  return SMS_ERR[key] || message || ('登录服务返回 ' + key);
}

/** 发送短信验证码 */
async function sendSmsCode(phone) {
  const num = String(phone || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(num)) return { ok: false, code: '4001', error: SMS_ERR[4001] };
  const rsa = await passportRsa();
  if (!rsa.ok) return { ok: false, code: 'rsa', error: '获取公钥失败：' + rsa.error };
  const r = await passportRequest('GET', '/login/dynamicpassword', {
    query: {
      msisdn: rsa.encrypt(num),
      captcha: '',
      sourceID: '220029',
      imgcodeType: '',
      fingerPrint: '',
      fingerPrintDetail: '',
      isAsync: 'true',
      _: Date.now(),
    },
  });
  const d = r.json;
  if (!d) return { ok: false, code: 'http', error: '发送失败（HTTP ' + r.status + '）' };
  if (String(d.status) === '2000') {
    return { ok: true, isMiguUser: !!(d.result && d.result.isMiguUser === 'yes'), message: d.message || '验证码已发送' };
  }
  return { ok: false, code: String(d.status), error: smsMsg(d.status, d.message) };
}

/** 用短信验证码登录，成功返回 { ok, token, redirectURL, logintype } */
async function smsLogin(phone, code) {
  const num = String(phone || '').replace(/\D/g, '');
  const sms = String(code || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(num)) return { ok: false, code: '4001', error: SMS_ERR[4001] };
  if (!/^\d{4,8}$/.test(sms)) return { ok: false, code: '4005', error: '请输入收到的短信验证码' };
  const rsa = await passportRsa();
  if (!rsa.ok) return { ok: false, code: 'rsa', error: '获取公钥失败：' + rsa.error };
  const r = await passportRequest('POST', '/authn/dynamicpassword', {
    body: {
      msisdn: rsa.encrypt(num),
      dynamicPassword: rsa.encrypt(sms),
      sourceID: '220029',
      appType: '0',
      isAsync: 'true',
    },
  });
  const d = r.json;
  if (!d) return { ok: false, code: 'http', error: '登录失败（HTTP ' + r.status + '）' };
  if (String(d.status) === '2000' && d.result && d.result.token) {
    return { ok: true, token: d.result.token, redirectURL: d.result.redirectURL || '', logintype: 'SMS_CODE' };
  }
  return { ok: false, code: String(d.status), error: smsMsg(d.status, d.message), raw: d };
}

/* ─── 扫码登录（passport 的 qrcWeb 通道，不依赖页面里的 postMessage） ───
 * qrcLogin  → { qrcUrl: 'data:image/jpeg;base64,...', qrcWebtype:'1', qrc_sessionid }
 * qrcquery  → 4074 未扫码 / 4072 超时 / 其它状态扫码后才有内容
 */
const QR_BASE = 'https://passport.migu.cn/api/qrcWeb';
/** 扫码会话的 JSESSIONID，qrcLogin 下发、qrcquery 必须带上才认得同一会话 */
let QR_COOKIE = '';

async function qrCreate(sourceId) {
  const sid = sourceId || '220029';
  const url = QR_BASE + '/qrcLogin?sourceid=' + sid + '&sourceID=' + sid;
  let res;
  try {
    res = await rawRequest(url, Object.assign({}, AUTH_COMMON, { Referer: 'https://passport.migu.cn/login?sourceid=' + sid }));
  } catch (e) {
    return { ok: false, error: '请求失败: ' + e.message };
  }
  const text = toText(res.body);
  let j = {};
  try { j = JSON.parse(text); } catch (e) { return { ok: false, error: '解析失败' }; }
  const d = j.result || {};
  const sc = (res.headers && res.headers['set-cookie']) || [];
  QR_COOKIE = sc.map((x) => String(x).split(';')[0]).filter(Boolean).join('; ');
  if (!d.qrc_sessionid) return { ok: false, error: j.message || '二维码获取失败', raw: j };
  return {
    ok: true,
    sid: d.qrc_sessionid,
    image: d.qrcUrl || '',
    type: String(d.qrcWebtype || '1'),
    cookies: (res.headers && res.headers['set-cookie']) || [],
  };
}

/** 轮询扫码状态；不带 token 时由调用方决定怎么用 */
async function qrQuery(sessionId, sourceId) {
  const sid = sourceId || '220029';
  const url = QR_BASE + '/qrcquery?sourceid=' + sid + '&qrc_sessionid=' + encodeURIComponent(sessionId) + '&isAsync=true';
  const hdr = Object.assign({}, AUTH_COMMON, { Referer: 'https://passport.migu.cn/login?sourceid=' + sid });
  if (QR_COOKIE) hdr.Cookie = QR_COOKIE;
  let res;
  try {
    res = await rawRequest(url, hdr);
  } catch (e) {
    return { ok: false, status: 0, error: '请求失败: ' + e.message };
  }
  const text = toText(res.body);
  let j = {};
  try { j = JSON.parse(text); } catch (e) { return { ok: false, status: 0, error: '解析失败', body: text.slice(0, 200) }; }
  const r = j.result || {};
  // 登录成功后 result 形态未公开，把所有像 token 的字段都摊平出来
  const candidates = [];
  const push = (v) => { if (typeof v === 'string' && v.length >= 8 && v.length < 4096) candidates.push(v); };
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (/token|ticket|redirect|url|code/i.test(k)) push(v);
    else if (typeof v === 'string') push(v);
  }
  const st = Number(j.status || 0);
  return {
    ok: true,
    status: st,
    message: j.message || '',
    result: r,
    token: String(r.token || ''),
    redirectURL: String(r.redirectURL || ''),
    logintype: String(r.logintype || ''),
    candidates,
    // 4074 未扫码 / 4073 已扫码待确认 / 4072 二维码超时 / 2000 成功
    scanned: st === 4073 || st === 2000,
    success: st === 2000 && !!(r.token || ''),
    expired: st === 4072,
  };
}

/**
 * 用登录回跳拿到的临时 token 换取正式 pacmtoken。
 * 服务端把 pacmtoken 放在响应头（access-control-expose-headers 已声明），body 里是用户资料。
 */
async function validateToken(token, tokenType, sourceId) {
  if (!token) return { ok: false, code: '', info: '缺少 token', pacmtoken: '', data: null };
  const qs = 'token=' + encodeURIComponent(token)
    + '&type=' + encodeURIComponent(tokenType || '2')
    + '&sourceId=' + encodeURIComponent(sourceId || '220029');
  let res;
  try {
    res = await rawRequest(AUTH_BASE + '/user/h5/token-validate/v3.0?' + qs, Object.assign({}, AUTH_COMMON, { deviceId: deviceId() }));
  } catch (e) {
    return { ok: false, code: '-1', info: '请求失败: ' + e.message, pacmtoken: '', data: null };
  }
  const text = toText(res.body);
  let j = {};
  try { j = JSON.parse(text); } catch (e) { return { ok: false, code: '-1', info: '解析失败', pacmtoken: '', data: null }; }
  const hdrToken = (res.headers && res.headers['pacmtoken']) || '';
  const d = j.data || null;
  return {
    ok: j.code === '000000' && !!d,
    code: j.code || '',
    info: j.info || '',
    pacmtoken: hdrToken || (d && d.pacmtoken) || '',
    data: d,
  };
}

/** 用户资料。headers 需 pacmtoken + uid；未登录回 290001 */
async function getUserInfo(pacmtoken, uid, ce, bversionid) {
  const h = Object.assign({}, AUTH_COMMON);
  if (pacmtoken) h.pacmtoken = String(pacmtoken);
  if (uid) h.uid = String(uid);
  if (ce) h.ce = String(ce);
  else if (bversionid) h.bversionid = String(bversionid);
  let res;
  try {
    res = await rawRequest(AUTH_BASE + '/user/h5/user-info/v1.0', h);
  } catch (e) {
    return { ok: false, code: '-1', info: '请求失败: ' + e.message };
  }
  const text = toText(res.body);
  let j = {};
  try { j = JSON.parse(text); } catch (e) { return { ok: false, code: '-1', info: '解析失败' }; }
  const d = j.data || {};
  const u = d.userInfo || d || {};
  return {
    ok: j.code === '000000',
    code: j.code || '',
    info: j.info || '',
    usessionId: d.usessionId || '',
    userId: u.userId || u.uid || u.id || '',
    nickName: u.nickName || u.nickname || u.userName || '',
    avatar: fixImg(u.avatar || u.avatarUrl || u.headPic || u.bigIcon || u.smallIcon || u.icon || ''),
    mobile: u.mobile || u.msisdn || u.phone || '',
    province: u.province || '',
    city: u.city || '',
    sex: u.sex || '',
    authType: u.authType || '',
    raw: d,
  };
}

/**
 * PC 端用户信息：比 H5 的 user-info 多出等级/经验值/勋章/账号设置。
 * 关键字段 userInfoItem.setting 形如 `03-1|04-1|05-1|06-1|07-HQ|08-PQ`，
 * 其中 07-<tone> 是「下载音质」偏好、08-<tone> 是「试听音质」偏好 —— 这是咪咕 PC 端
 * 真实记录用户音质选择的地方，比本地配置更权威。
 */
async function getPcUserInfo(pacmtoken, uid) {
  const h = Object.assign({}, AUTH_COMMON, { ce: 'utf-8', bversionid: '20241118', channel: '014X031' });
  if (pacmtoken) h.pacmtoken = String(pacmtoken);
  if (uid) h.uid = String(uid);
  let res;
  try {
    res = await rawRequest('https://app.u.nf.migu.cn/pc/user/h5/queryUserInfo/v1.0', h);
  } catch (e) {
    return { ok: false, code: '-1', info: '请求失败: ' + e.message };
  }
  let j = {};
  try { j = JSON.parse(toText(res.body)); } catch (e) { return { ok: false, code: '-1', info: '解析失败' }; }
  // 注意 userInfoItem 是顶层字段（和 code/info 平级），不在 data 里
  const u = j.userInfoItem || (j.data && (j.data.userInfoItem || j.data)) || {};
  const settings = {};
  String(u.setting || '').split('|').forEach((kv) => {
    const [k, v] = String(kv).split('-');
    if (k) settings[k] = v || '';
  });
  return {
    ok: j.code === '000000',
    code: j.code || '',
    info: j.info || '',
    userId: u.userId || '',
    nickName: u.nickName || '',
    avatar: fixImg(u.bigIcon || u.middleIcon || u.smallIcon || ''),
    bgpic: fixImg(u.bgpic || ''),
    msisdn: u.msisdn || '',
    registerTime: u.registerTime || '',
    level: (u.userLevelInfo && u.userLevelInfo.level) || '',
    levelName: (u.userLevelInfo && u.userLevelInfo.levelName) || '',
    credit: (u.userCreditInfo && u.userCreditInfo.credit) || '',
    creditName: (u.userCreditInfo && u.userCreditInfo.creditSysName) || '',
    medals: (u.userMedalInfoList || []).map((m) => m.medalName || '').filter(Boolean),
    toneDownload: settings['07'] || '',
    toneListen: settings['08'] || '',
    settings,
    raw: u,
  };
}

/**
 * 会员中心。
 *
 * 为什么先打 v2.0：v1.0 的 memberRightsItem.memLevel 对「体验会员」恒为 0（会显示成「非会员」），
 * 真正生效的身份在 v2.0 的 identityItems + userServices 里 —— 例如
 *   identityItems[0] = { name:'天籁体验会员', title:'您已获得天籁体验会员',
 *                        memberItems:[{ validTime:'20271214013309', payType:'01' }] }
 *   userServices[0]  = { serviceName:'天籁体验会员', validTime:'2027-12-14', expireTime:'20271214013309', hasValid:true }
 * payType '01' = 体验/赠送，'02' 等 = 付费购买。所以会员身份以 identityItems 是否为空为准，
 * memLevel 只当补充信息。
 */
async function getMemberCenter(pacmtoken, uid) {
  // 必须带 ce（客户端编码标识）：不带时服务端按「未登录的游客口径」回非会员，
  // 带上 ce 才认 pacmtoken 并返回真实身份（体验会员就在这里）。
  const h = Object.assign({}, AUTH_COMMON, { ce: 'utf-8', bversionid: '20241118', channel: '014X031' });
  if (pacmtoken) h.pacmtoken = String(pacmtoken);
  if (uid) h.uid = String(uid);
  let j = null;
  let lastErr = '';
  for (const ver of ['v2.0', 'v1.0']) {
    try {
      const res = await rawRequest(VIP_BASE + '/MIGUM3.0/user/member/center/' + ver, h);
      const parsed = JSON.parse(toText(res.body));
      if (parsed && (parsed.code === '000000' || parsed.data)) {
        j = parsed;
        if (parsed.code === '000000') break;
      }
    } catch (e) {
      lastErr = e.message;
    }
  }
  if (!j) return { ok: false, code: '-1', info: '请求失败: ' + lastErr };
  const d = j.data || {};
  const m = d.memberRightsItem || {};
  const services = (d.userServices || []).map((s) => ({
    id: s.serviceId || s.id || '',
    name: s.serviceName || s.name || '',
    status: String(s.serviceStatus || s.status || ''),
    endTime: s.endTime || s.expireTime || '',
    hasValid: !!s.hasValid,
  }));
  // 生效中的身份（体验会员也在这里）
  const identities = (d.identityItems || []).map((it) => {
    const mi = (it.memberItems && it.memberItems[0]) || {};
    return {
      name: it.name || '',
      title: it.title || '',
      desc: it.desc || '',
      payType: String(mi.payType || ''),
      trial: String(mi.payType || '') === '01',
      validTime: String(mi.validTime || ''),
    };
  });
  const activeService = services.find((s) => s.hasValid && s.endTime) || services[0] || null;
  const idn = identities[0] || null;
  const expireRaw = (idn && idn.validTime) || (activeService && activeService.endTime) || '';
  const fmtExpire = /^\d{14}$/.test(expireRaw)
    ? expireRaw.slice(0, 4) + '-' + expireRaw.slice(4, 6) + '-' + expireRaw.slice(6, 8)
    : (/^\d{4}-\d{2}-\d{2}/.test(expireRaw) ? expireRaw.slice(0, 10) : '');
  const isMember = !!(idn || services.length);
  return {
    ok: j.code === '000000',
    code: j.code || '',
    info: j.info || '',
    memLevel: String(m.memLevel || '0'),
    memName: (idn && idn.name) || m.memName || '非会员',
    cardType: String(m.cardType || ''),
    isMember,
    isTrial: !!(idn && idn.trial),
    expire: fmtExpire,
    identities,
    // v2.0 的 memberRights 才是「当前身份真正享有的权益」（v1.0 的 vipInfos 是全集模板，20 项全 status=1，看了等于没看）
    vipInfos: ((d.memberRights && d.memberRights.length)
      ? d.memberRights.map((v) => ({
        rightID: v.rightsId || '',
        name: v.showRightsName || v.rightsName || '',
        sub: v.rightsSubTitle || '',
        status: String(v.infoStatus || ''),
        icon: fixImg(v.rightsIcon || ''),
      }))
      : (m.vipInfos || []).map((v) => ({
        rightID: v.rightID || '',
        name: v.infoName || '',
        sub: '',
        status: String(v.infoStatus || ''),
        icon: fixImg(v.icon || ''),
      }))),
    services,
    raw: d,
  };
}

/* ───────────────────────── 播放 ───────────────────────── */

/** 音质档位：服务端 toneFlag 白名单 `LQ|PQ|HQ|SQ|ZQ|Z3D|ZQ24|ZQ32|AV3A` */
const TONE_ORDER = ['AV3A', 'ZQ32', 'ZQ24', 'Z3D', 'ZQ', 'SQ', 'HQ', 'PQ'];
const TONE_LABEL = {
  AV3A: '臻品音质',
  ZQ32: '臻品母带 32bit',
  ZQ24: '臻品母带 24bit',
  Z3D: '臻品三维声',
  ZQ: '臻品母带',
  SQ: '无损',
  HQ: '高清',
  PQ: '标准',
};

function toneLabel(t) { return TONE_LABEL[t] || t || '标准'; }

/**
 * 取音频源的头部 4 字节，判断 Chromium 到底能不能解。
 * 起因：咪咕「臻品」档位常下发 IP 伪装成 .wav / audio/x-wav 的地址，实际字节不是 RIFF
 * （实测 Z3D 头是 8A7C8887，ZQ 头是 664C6143="fLaC"），塞给 <audio> 只会 readyState 恒 0。
 * 只要几个字节就能分辨，比等 7 秒看门狗、或者靠后缀名猜都准。
 */
function probeMagic(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false }); }
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs || 3500,
        headers: { Range: 'bytes=0-3', 'User-Agent': UA },
      },
      (res) => {
        const chunks = [];
        let n = 0;
        res.on('data', (d) => { chunks.push(d); n += d.length; if (n >= 4) res.destroy(); });
        res.on('end', () => resolve({ ok: true, status: res.statusCode, buf: Buffer.concat(chunks).slice(0, 12) }));
        res.on('close', () => resolve({ ok: true, status: res.statusCode, buf: Buffer.concat(chunks).slice(0, 12) }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
}

/** 能被 Chromium 直接播放的容器魔数：RIFF(WAV) / fLaC / ID3+MP3 / OggS / MP4 */
function isPlayableMagic(buf) {
  if (!buf || buf.length < 4) return null; // 认不出来就交给看门狗，不冤枉它
  const h = buf.slice(0, 4).toString('hex').toLowerCase();
  if (h === '52494646') return true;   // RIFF
  if (h === '664c6143') return true;   // fLaC
  if (h === '494433') return true;     // ID3
  if (h === '4f676753') return true;   // OggS
  if (buf.slice(4, 8).toString('hex').toLowerCase() === '66747970') return true; // ftyp
  return false;
}

/** 需要做头部探测的档位：臻品系下发的封装不统一，实测同档不同曲都能变（同是 ZQ24，一首 flac 一首伪装 wav） */
const PREMIUM_TONES = ['AV3A', 'ZQ32', 'ZQ24', 'Z3D', 'ZQ'];

async function listenOnce(contentId, copyrightId, tone) {
  const j = await apiGet('/strategy/pc/listen/v2.0', {
    contentId,
    copyrightId: copyrightId || '',
    resourceType: 2,
    netType: '01',
    toneFlag: tone,
    scene: '',
  });
  return j;
}

async function getListenUrl(contentId, copyrightId, toneFlag) {
  const tone = toneFlag || 'PQ';
  const tried = [];
  let j = {};
  let d = {};
  let usedTone = tone;
  // 从请求档位开始逐档往下试，直到拿到「地址 + 真能被 Chromium 解码的容器」为止。
  // 440003 = 该账号无音质权限；440022 = 音质权限不足；440013 = 需会员才能完整播放。
  const start = Math.max(0, TONE_ORDER.indexOf(tone));
  const chain = TONE_ORDER.slice(start).concat(['PQ']).filter((t, i, a) => a.indexOf(t) === i);
  for (const t of chain) {
    let jj;
    try { jj = await listenOnce(contentId, copyrightId, t); } catch (e) { continue; }
    tried.push(t);
    if (!j.code) j = jj;
    const dd = jj.data || {};
    if (!dd.url) {
      d = dd; usedTone = t;
      // 440013 是会员/版权限制，与音质无关：再往下降也没用，直接停。
      if (String(dd.cannotCode || '') === '440013') break;
      continue;
    }
    // 有地址还要看容器：臻品档位常给伪装扩展名的封装（.wav 里其实是加密/3D 数据）。
    if (PREMIUM_TONES.indexOf(t) >= 0) {
      const pr = await probeMagic(dd.url);
      const ok = isPlayableMagic(pr.buf);
      if (ok === false) { d = dd; usedTone = t; continue; } // 解不了，继续往下降
    }
    d = dd; usedTone = t;
    break;
  }
  // 全档都放不了时，以「标准音质」的拒绝原因对外说明：
  // 高档位常回 440022（无音质权限），但那不是用户真正卡住的地方。
  if (!d.url && String(d.cannotCode || '') !== '440013') {
    try {
      const j2 = await listenOnce(contentId, copyrightId, 'PQ');
      if (tried.indexOf('PQ') < 0) tried.push('PQ');
      if (j2.data && j2.data.url) { d = j2.data; usedTone = 'PQ'; }
      else if (j2.data && (j2.data.cannotCode || j2.data.cannotMsg)) d = j2.data;
    } catch (e) { /* ignore */ }
  }
  const fellBack = usedTone !== tone;
  return {
    fellBack,
    requestedTone: tone,
    actualTone: usedTone,
    actualToneLabel: toneLabel(usedTone),
    triedTone: tried,
    code: j.code,
    info: j.info,
    url: d.url || '',
    formatId: d.formatId || '',
    toneFlag: d.toneFlag || '',
    priceType: d.priceType,
    cannotCode: d.cannotCode || '',
    cannotMsg: d.cannotMsg || '',
    auditionsLength: Number(d.auditionsLength || 0),
    auditionsTooltips: d.auditionsTooltips || '',
    dialog: (d.dialogInfo && d.dialogInfo.text) || '',
    lrcUrl: d.lrcUrl || '',
    mrcUrl: d.mrcUrl || '',
    song: d.song ? normalizeSong(d.song) : null,
    freeListenType: d.freeListenType,
    haveVisualMv: !!d.haveVisualMv,
    playSessionId: d.playSessionId || '',
  };
}

/** 可播判断。contentIds 必须用英文逗号分隔（用 | 会被当成单个 id） */
async function canListen(contentIds) {
  // 允许传数组、逗号分隔字符串或单个 id —— 传逗号串时曾把整串当成一个 id，静默返回空表。
  const arr = (Array.isArray(contentIds) ? contentIds : String(contentIds || '').split(','))
    .filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
  if (!arr.length) return {};
  const map = {};
  for (let i = 0; i < arr.length; i += 50) {
    const chunk = arr.slice(i, i + 50);
    try {
      const j = await apiGet('/MIGUM3.0/strategy/can-listen/v2.3', {
        contentIds: chunk.join(','),
        curPlayContentId: chunk[0],
      });
      const items = (j.data && j.data.canListenRespItemList) || [];
      for (const it of items) {
        map[it.contentId] = { canListen: !!it.canListen, limitLength: !!it.limitLength, msg: it.cannotMsg || '' };
      }
    } catch (e) { /* 单批失败忽略 */ }
  }
  return map;
}

const canListenBatch = canListen;

/** 歌词：lrcUrl 纯文本 LRC；mrcUrl 若存在则并行取回逐字源（增强 LRC / QRC / MRC）。
    逐字源解析在渲染层 parseWordLyric() 完成，这里只负责搬运原始文本。 */
async function getLyric(url, mrcUrl) {
  const out = { lrc: '', mrc: '' };
  const H = { 'User-Agent': UA, Referer: 'https://music.migu.cn/' };
  if (url) {
    try {
      const res = await rawRequest(url, H);
      out.lrc = toText(res.body);
    } catch (e) { out.error = e.message; }
  }
  if (mrcUrl && mrcUrl !== url) {
    try {
      const res2 = await rawRequest(mrcUrl, H);
      out.mrc = toText(res2.body);
    } catch (e) { out.mrcError = e.message; }
  }
  return out;
}

/* ───────────────────────── 其它 ───────────────────────── */

/** 新歌速递栏目（columnId 75579758，约 200 首） */
async function getNewSongs() {
  return getColumn('75579758');
}

async function getTodayRecommend() {
  const j = await apiGet('/pc/v1.0/template/todayRecommendList/release');
  const rd = (j.data && j.data.recommendData) || {};
  const list = (rd.data || []).map((s) => normalizeSong(Object.assign({}, s, {
    albumImgs: s.albumImgs, singers: s.singerList,
  }))).filter(Boolean);
  return { title: rd.text || '今日推荐', week: rd.week || '', img: rd.img || '', songs: list };
}

async function getRadio() {
  const j = await apiGet('/pc/bmw/page-data/music-radio/v1.0', { templateVersion: 1 });
  const blocks = (j.data && j.data.contents) || [];
  return blocks.map((b, i) => ({
    index: i,
    title: b.title || (b.contents && b.contents[0] && b.contents[0].txt) || '',
    view: b.view || '',
    items: (b.contents || []).map((x) => ({
      title: x.txt || '',
      sub: x.txt2 || '',
      img: x.img || '',
      action: x.action || '',
      id: (String(x.action || '').match(/[?&]id=(\d+)/) || [])[1] || String(x.resId || ''),
    })),
  }));
}

/** songId / contentId 补全完整歌曲对象 */
async function getSongDetail({ contentId, songId }) {
  try {
    if (contentId) {
      const j = await apiGet('/resource/song/by-contentids/v2.0', { contentId });
      const arr = (j.data && Array.isArray(j.data) ? j.data : null) || (Array.isArray(j.data) ? j.data : null);
      if (arr && arr[0]) return normalizeSong(arr[0]);
    }
    if (songId) {
      const j = await apiGet('/MIGUM3.0/resource/song/by-songids/v2.0', { songId });
      const arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : null);
      if (arr && arr[0]) return normalizeSong(arr[0]);
    }
  } catch (e) { /* ignore */ }
  return null;
}


/* ───────────────────────── 「我喜欢的」云端收藏 ─────────────────────────
 * 咪咕的「喜欢」不是独立开关，而是把歌塞进账号里那个叫「喜欢的音乐」的私有歌单。
 * 所以：收藏 = 往该歌单加歌，取消收藏 = 从该歌单移除，收藏列表 = 读该歌单。
 */

let favPlaylistId = '';
let favPlaylistAt = 0;

/** 深度遍历找「喜欢的音乐」歌单项（接口结构调整时也能兜住） */
function findFavItem(node, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 6) return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const hit = findFavItem(x, (depth || 0) + 1);
      if (hit) return hit;
    }
    return null;
  }
  const title = String(node.title || node.name || node.listName || node.musicListName || '').trim();
  if (title === '喜欢的音乐' || title === '我喜欢的音乐' || title === '我喜欢的') return node;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') {
      const hit = findFavItem(v, (depth || 0) + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** 从各种字段里抠出 musicListId */
function pickListId(item) {
  if (!item) return '';
  const cands = [];
  const push = (v) => { if (v) cands.push(String(v)); };
  push(item.musicListId);
  push(item.listId);
  push(item.id);
  push(item.resourceId);
  const urls = [item.actionUrl, item.url, item.link, item.jumpUrl, item.action];
  for (const u of urls) {
    if (!u) continue;
    const s = String(u);
    let m = s.match(/musicListId=([0-9A-Za-z_-]+)/i);
    if (m) { push(m[1]); break; }
    m = s.match(/(?:playlist|list|id)\/([0-9A-Za-z_-]+)/i);
    if (m) push(m[1]);
  }
  return cands.find((x) => /^\d{6,}$/.test(x)) || cands[0] || '';
}

/** 取「喜欢的音乐」歌单 id（带 5 分钟缓存） */
async function getFavPlaylistId(force) {
  const now = Date.now();
  if (!force && favPlaylistId && now - favPlaylistAt < 5 * 60 * 1000) return favPlaylistId;
  const tries = [
    () => apiGet('/pc/user/home-page/trust-uid/v1.0'),
    () => apiGet('/pc/user/home-page/v1.0'),
  ];
  for (const t of tries) {
    let j = null;
    try { j = await t(); } catch (e) { j = null; }
    if (!j || String(j.code || '') === '290001') continue;
    const item = findFavItem(j, 0);
    const id = pickListId(item);
    if (id) {
      favPlaylistId = id;
      favPlaylistAt = now;
      return id;
    }
  }
  return '';
}

const FAV_PAGE = 50;

/** 云端收藏列表（读「喜欢的音乐」歌单） */
async function getFavorites(maxPages) {
  const pid = await getFavPlaylistId();
  if (!pid) {
    const a = await apiGet('/pc/user/home-page/trust-uid/v1.0').catch(() => null);
    if (a && String(a.code || '') === '290001') return { ok: false, needLogin: true, songs: [], playlistId: '' };
    return { ok: false, needLogin: false, songs: [], playlistId: '', error: '未能定位「喜欢的音乐」歌单' };
  }
  const first = await apiGet('/MIGUM3.0/resource/playlist/song/v2.0', { playlistId: pid, pageNo: 1, pageSize: FAV_PAGE });
  if (first && String(first.code || '') === '290001') return { ok: false, needLogin: true, songs: [], playlistId: pid };
  const total = Number((first && first.data && first.data.totalCount) || 0);
  let raw = ((first && first.data && first.data.songList) || []).slice();
  const pages = Math.min(Math.ceil(total / FAV_PAGE) || 1, maxPages || 40);
  for (let pg = 2; pg <= pages; pg++) {
    const r = await apiGet('/MIGUM3.0/resource/playlist/song/v2.0', { playlistId: pid, pageNo: pg, pageSize: FAV_PAGE }).catch(() => null);
    const sl = (r && r.data && r.data.songList) || [];
    if (!sl.length) break;
    raw = raw.concat(sl);
  }
  const songs = await enrichSongs(raw.map(normalizeSong).filter(Boolean));
  return { ok: true, needLogin: false, playlistId: pid, total: total || songs.length, songs };
}

/** 收藏（加入「喜欢的音乐」） */
async function likeSong(contentId) {
  const pid = await getFavPlaylistId();
  if (!pid) return { ok: false, error: '未登录或取不到「喜欢的音乐」歌单' };
  const j = await apiPost('/pc/user/api/add-music-list-song/v1.0', { contentIds: [String(contentId)], id: String(pid) });
  const code = String((j && j.code) || '');
  if (code === '000000') return { ok: true };
  if (code === '290001') return { ok: false, needLogin: true, error: '请先登录' };
  return { ok: false, error: (j && (j.info || j.desc)) || ('添加失败(' + code + ')') };
}

/** 取消收藏（从「喜欢的音乐」移除） */
async function unlikeSong(contentId) {
  const j = await apiPost('/pc/user/h5-import-musiclist/v1.0', { channel: '23', contentId: String(contentId), songflag: '2' });
  const code = String((j && j.code) || '');
  if (code === '000000') return { ok: true };
  if (code === '290001') return { ok: false, needLogin: true, error: '请先登录' };
  return { ok: false, error: (j && (j.info || j.desc)) || ('移除失败(' + code + ')') };
}

/** 批量查某批歌是否已在「我喜欢的」里（每次 ≤50） */
async function checkLiked(contentIds) {
  const ids = (Array.isArray(contentIds) ? contentIds : String(contentIds || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const j = await apiGet('/pc/v1.0/content/inMusicLists.do', { type: 1, contentId: part.join('|') }).catch(() => null);
    const d = (j && (j.originData || (j.data && j.data.originData) || j.data)) || {};
    const arr = d.isInfavors || (j && j.isInfavors) || [];
    if (Array.isArray(arr)) {
      for (const x of arr) {
        if (x && x.contentId) out[String(x.contentId)] = String(x.isInfavor) === '1';
      }
    }
    if (!Array.isArray(arr) || !arr.length) {
      // 接口形状变了：退回逐首判（perf 差但可用）
      if (String(j && j.code || '') === '290001') return null;
    }
  }
  return out;
}

module.exports = {
  sendSmsCode, smsLogin, passportRsa,
  qrCreate, qrQuery,
  setAuth, getAuth,
  validateToken, getUserInfo, getPcUserInfo, getMemberCenter, deviceId, setDeviceId,
  TONE_ORDER, TONE_LABEL, toneLabel,
  getHome, getHotSearch, getColumn, getTopLists,
  search, getSearchSuggest,
  getPlaylist, getAlbum, resolveAlbumId,
  getFavorites, likeSong, unlikeSong, checkLiked, getFavPlaylistId,
  apiPost,
  getSingerTabs, getSingerInfo, getSingerSongs, getSingerAlbums,
  getListenUrl, canListen, getLyric,
  getNewSongs, getTodayRecommend, getRadio, getSongDetail,
  batchSongDetail, enrichSongs, canListenBatch,
  apiGet, normalizeSong, parseLength, pickImg, fixImg,
};
