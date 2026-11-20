'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('migu', {
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
    isMaximized: () => invoke('window:isMaximized'),
    onState: (cb) => ipcRenderer.on('window:state', (e, s) => cb(s)),
  },
  openExternal: (url) => invoke('shell:openExternal', url),

  home: () => invoke('api:home'),
  hotSearch: () => invoke('api:hotSearch'),
  column: (id, pageNo) => invoke('api:column', id, pageNo),
  topLists: () => invoke('api:topLists'),
  search: (text, type, pageNo, pageSize) => invoke('api:search', text, type, pageNo, pageSize),
  suggest: (text) => invoke('api:suggest', text),
  playlist: (id) => invoke('api:playlist', id),
  album: (id) => invoke('api:album', id),
  singerTabs: () => invoke('api:singerTabs'),
  singerInfo: (id) => invoke('api:singerInfo', id),
  singerSongs: (id, pageNo) => invoke('api:singerSongs', id, pageNo),
  singerAlbums: (id, pageNo) => invoke('api:singerAlbums', id, pageNo),
  newSongs: () => invoke('api:newSongs'),
  todayRecommend: () => invoke('api:todayRecommend'),
  radio: () => invoke('api:radio'),
  songDetail: (q) => invoke('api:songDetail', q),
  listen: (cid, cp, tone) => invoke('api:listen', cid, cp, tone),
  canListen: (ids) => invoke('api:canListen', ids),
  lyric: (url, mrcUrl) => invoke('api:lyric', url, mrcUrl),
  raw: (p, params, opts) => invoke('api:raw', p, params, opts),

  /* 云端「我喜欢的」：跟着账号走，不落本地 */
  favorites: () => invoke('api:favorites'),
  like: (contentId) => invoke('api:like', contentId),
  unlike: (contentId) => invoke('api:unlike', contentId),
  checkLiked: (ids) => invoke('api:checkLiked', ids),

  /* 原生播放内核（FFmpeg + WASAPI），替代 Chromium <audio> */
  player: {
    available: () => invoke('player:available'),
    load: (url, autoplay) => invoke('player:load', url, !!autoplay),
    play: () => invoke('player:play'),
    pause: () => invoke('player:pause'),
    stop: () => invoke('player:stop'),
    seek: (t) => invoke('player:seek', t),
    volume: (v) => invoke('player:volume', v),
    state: () => invoke('player:state'),
    onEvent: (cb) => ipcRenderer.on('player:event', (e, d) => cb(d)),
  },


  /* ── 内核扩展（频谱 / 均衡器 / 音效 / 变速 / 音频图） ── */
  spectrum: (opts) => invoke('player:spectrum', opts),
  spectrumSnapshot: () => invoke('player:spectrumSnapshot'),
  spectrumStatus: () => invoke('player:spectrumStatus'),
  eq: (bands) => invoke('player:eq', bands),
  effect: (name, params) => invoke('player:effect', name, params),
  fade: (vol, sec) => invoke('player:fade', vol, sec),
  speed: (rate) => invoke('player:speed', rate),
  gain: (g) => invoke('player:gain', g),
  graph: () => invoke('player:graph'),
  graphPlan: (plan) => invoke('player:graphPlan', plan),
  devices: () => invoke('player:devices'),
  setDevice: (id) => invoke('player:setDevice', id),

  /* ── 系统集成（媒体卡片 / 任务栏歌词 / 本地库） ── */
  sys: {
    available: () => invoke('sys:available'),
    media: (meta) => invoke('sys:media', meta),
    mediaState: (st) => invoke('sys:mediaState', st),
    mediaTimeline: (tl) => invoke('sys:mediaTimeline', tl),
    taskbarLyric: (arg) => invoke('sys:taskbarLyric', arg),
    kvGet: (k) => invoke('sys:kvGet', k),
    kvSet: (k, v) => invoke('sys:kvSet', k, v),
    historyClear: () => invoke('sys:historyClear'),
    queueGet: () => invoke('sys:queueGet'),
    onMediaKey: (cb) => {
      ipcRenderer.on('media:play', () => cb('play'));
      ipcRenderer.on('media:pause', () => cb('pause'));
      ipcRenderer.on('media:toggle', () => cb('toggle'));
      ipcRenderer.on('media:next', () => cb('next'));
      ipcRenderer.on('media:prev', () => cb('prev'));
      ipcRenderer.on('media:stop', () => cb('stop'));
    },
  },

  storeGet: () => invoke('store:get'),
  storeSet: (patch) => invoke('store:set', patch),

  authStatus: () => invoke('auth:status'),
  onAuthUpdated: (cb) => ipcRenderer.on('auth:updated', (e, d) => cb(d)),
  authRefresh: () => invoke('auth:refresh'),
  member: () => invoke('auth:member'),
  tones: () => invoke('auth:tones'),
  qr: () => invoke('auth:qr'),
  qrPoll: (sid) => invoke('auth:qrPoll', sid),
  login: () => invoke('auth:login'),
  smsSend: (phone) => invoke('auth:smsSend', phone),
  smsLogin: (phone, code) => invoke('auth:smsLogin', phone, code),
  logout: () => invoke('auth:logout'),
});
