'use strict';
/**
 * 原生播放内核：Rust/FFmpeg + WASAPI 的 napi 模块（预编译二进制，见 native/）。
 *
 * 为什么不用 <audio>：Chromium 只能解 RIFF/fLaC/MP3/Ogg/MP4 这几类容器，
 * 咪咕「臻品」档位下发的东西（几十 MB 的 3D WAV、伪装扩展名的封装）它一律 readyState=0，
 * 表现就是进度条不动、一直重取。FFmpeg 才认得这些格式。
 *
 * 模块来源（按优先级找）：
 *   1. 本项目 native/echo-ffmpeg-player.node（打包时随应用分发）
 *   2. resources/app/native/...
 *   3. 同机其它分发包的 native 目录（开发态兜底，可选）
 */
const path = require('path');
const fs = require('fs');

let mod = null;
let ready = false;
let lastError = '';
let emitter = () => {};

function candidates() {
  return [
    path.join(__dirname, '..', '..', 'native', 'echo-ffmpeg-player.node'),
    path.join(process.resourcesPath || '', 'app', 'native', 'echo-ffmpeg-player.node'),
    path.join(process.env.LOCALAPPDATA || '', 'EchoMusic', 'resources', 'native', 'echo-ffmpeg-player.node'),
    path.join(process.env['ProgramFiles'] || 'C:/Program Files', 'EchoMusic', 'resources', 'native', 'echo-ffmpeg-player.node'),
  ];
}

function init(onEvent) {
  if (typeof onEvent === 'function') emitter = onEvent;
  if (ready) return true;
  let file = '';
  for (const c of candidates()) {
    try { if (c && fs.existsSync(c)) { file = c; break; } } catch (e) { /* ignore */ }
  }
  if (!file) { lastError = '找不到 echo-ffmpeg-player.node'; return false; }
  try {
    mod = require(file);
  } catch (e) {
    lastError = '加载原生模块失败: ' + (e && e.message);
    return false;
  }
  try {
    mod.registerEventHandler((err, ev) => {
      if (err || !ev) return;
      forward(ev);
    });
    // 类型必须严格对齐：数字项给 f64、字符串项给 String，给错会抛
    // NumberExpected / StringExpected on PlayerConfigOptions.xxx
    mod.initialize({
      audioBufferSecs: 0.5,
      audioSamplerate: '48000',
      audioChannels: '2',
      audioFormat: 'f32',
      gaplessAudio: 'yes',
      demuxerReadaheadSecs: 5,
      cache: 'yes',
      cacheSecs: 30,
      cachePause: true,
      cachePauseWaitSecs: 10,
      demuxerMaxBytes: 0,
      demuxerMaxBackBytes: 0,
      networkTimeoutSecs: 15,
      playbackStallTimeoutSecs: 30,
      httpProxy: '',
    });
    ready = true;
    return true;
  } catch (e) {
    lastError = '初始化原生模块失败: ' + (e && e.message);
    mod = null;
    return false;
  }
}

/** 把原生事件裁成渲染层要的那几种，别把 log / packet-cache-stats 这种噪音全推过去 */
function forward(ev) {
  const name = ev.event;
  if (name === 'time-update') {
    emitter({ type: 'time', t: Number(ev.time) || 0 });
    return;
  }
  if (name === 'state-change' && ev.state) {
    emitter({
      type: 'state',
      playing: !!ev.state.playing,
      paused: !!ev.state.paused,
      duration: Number(ev.state.duration) || 0,
      timePos: Number(ev.state.timePos) || 0,
    });
    return;
  }
  if (name === 'duration-change') {
    emitter({ type: 'duration', d: Number(ev.duration) || 0 });
    return;
  }
  if (name === 'file-loaded') {
    emitter({ type: 'loaded' });
    return;
  }
  if (name === 'playback-end') {
    emitter({ type: 'end', reason: ev.reason || 'eof' });
    return;
  }
  if (name === 'error') {
    emitter({ type: 'error', message: ev.message || '播放出错', code: ev.errorCode || '' });
    return;
  }
  if (name === 'spectrum' || name === 'audio-graph') {
    emitter({ type: 'spectrum', data: ev.data || ev.values || null, at: Date.now() });
    return;
  }
  if (name === 'log' && ev.level === 'error') {
    emitter({ type: 'error', message: ev.message || '解码错误' });
    return;
  }
}

function load(url) {
  if (!ready) return Promise.reject(new Error(lastError || '原生播放器不可用'));
  return Promise.resolve(mod.stop()).catch(() => {}).then(() => mod.loadFile(String(url || ''))).then(() => {
    let s = {};
    try { s = mod.getState() || {}; } catch (e) { /* ignore */ }
    return Number(s.duration) || 0;
  });
}

function play() {
  if (!ready) return Promise.reject(new Error('原生播放器不可用'));
  return Promise.resolve(mod.play());
}
function pause() {
  if (!ready) return Promise.resolve();
  return Promise.resolve(mod.pause());
}
function stop() {
  if (!ready) return Promise.resolve();
  return Promise.resolve(mod.stop());
}
function seek(t) {
  if (!ready) return Promise.resolve();
  return Promise.resolve(mod.seek(Math.max(0, Number(t) || 0)));
}
/** v 取 0..1（渲染层口径），原生要 0..100 */
function setVolume(v) {
  if (!ready) return;
  try { mod.setVolume(Math.max(0, Math.min(100, (Number(v) || 0) * 100))); } catch (e) { /* ignore */ }
}
function getState() {
  if (!ready) return { playing: false, paused: true, duration: 0, timePos: 0 };
  try { return mod.getState() || {}; } catch (e) { return {}; }
}
function destroy() {
  if (!ready) return;
  try { mod.stop(); mod.destroy(); } catch (e) { /* ignore */ }
  ready = false;
}



/* ══════════════════════════════════════════════════════════════
   内核扩展能力（2026-11-20）
   echo-ffmpeg-player.node 实际导出 40+ 个方法，这里把它接出来：
   频谱 / 均衡器 / 音效 / 淡入淡出 / 变速 / 归一化增益 / 音频图。
   之前只用了 load/play/pause/seek/setVolume 六个。
   ══════════════════════════════════════════════════════════════ */

/** 频谱：先按需打开配置，再取快照 */
function configureSpectrum(opts) {
  if (!ready || typeof mod.configureSpectrum !== 'function') return false;
  try {
    const o = opts || {};
    mod.configureSpectrum({
      enabled: o.enabled !== false,
      bands: Number(o.bands) || 64,
      sampleRate: Number(o.sampleRate) || 48000,
      intervalMs: Number(o.intervalMs) || 33,
    });
    return true;
  } catch (e) { return false; }
}

function spectrumSnapshot() {
  if (!ready || typeof mod.getSpectrumSnapshot !== 'function') return null;
  try { return mod.getSpectrumSnapshot(); } catch (e) { return null; }
}

function spectrumStatus() {
  if (!ready || typeof mod.getSpectrumStatus !== 'function') return null;
  try { return mod.getSpectrumStatus(); } catch (e) { return null; }
}

/** 均衡器：bands = [{freq, gain}] 或 [{frequency, gain, q}] */
/**
 * 均衡器。实测内核只接受「纯 number 数组」——每个元素是该段的增益 dB（f64），
 * 传对象数组会抛 Failed to convert napi value Object into rust type f64。
 * 因此这里兼容两种入参：
 *   setEqualizer([3, 0, -2, ...])        直接给 dB 数组
 *   setEqualizer([{freq,gain}, ...])     先按频段取 gain 再投喂
 */
function setEqualizer(bands) {
  if (!ready || typeof mod.setEqualizer !== 'function') return false;
  let arr = [];
  if (Array.isArray(bands)) {
    arr = bands.map((b) => {
      if (typeof b === 'number') return Number(b) || 0;
      if (b && typeof b === 'object') return Number(b.gain) || 0;
      return 0;
    });
  }
  try { mod.setEqualizer(arr); return true; } catch (e) { return false; }
}

/** 音效预设：字符串名或对象 */
function setAudioEffect(name, params) {
  if (!ready || typeof mod.setAudioEffect !== 'function') return false;
  try {
    if (params === undefined) mod.setAudioEffect(String(name || ''));
    else mod.setAudioEffect(String(name || ''), params);
    return true;
  } catch (e) { return false; }
}

/** 淡入淡出：durationSec 秒 */
function fade(targetVolume, durationSec) {
  if (!ready || typeof mod.fade !== 'function') return Promise.resolve(false);
  const to = Number(targetVolume) || 0;
  const sec = Math.max(0.05, Number(durationSec) || 0.3);
  // 实测签名要 (from, to, sec) 三个 f64；只给两个会抛 Undefined
  const cur = (() => { try { return Number((mod.getState() || {}).volume) / 100 || 0; } catch (e) { return 0; } })();
  const attempts = [
    () => mod.fade(cur, to, sec),
    () => mod.fade(to, sec),
  ];
  for (const fn of attempts) {
    try { return Promise.resolve(fn()).then(() => true).catch(() => false); } catch (e) { /* 试下一种 */ }
  }
  return Promise.resolve(false);
}

/** 变速：rate 0.5~2 */
function setSpeed(rate) {
  if (!ready || typeof mod.setSpeed !== 'function') return false;
  try { mod.setSpeed(Math.max(0.25, Math.min(3, Number(rate) || 1))); return true; }
  catch (e) { return false; }
}

/** 响度归一化增益（dB 或线性，按内核实现透传） */
function setNormalizationGain(gain) {
  if (!ready || typeof mod.setNormalizationGain !== 'function') return false;
  try { mod.setNormalizationGain(Number(gain) || 0); return true; }
  catch (e) { return false; }
}

/** 音频图（DSP 链）：plan 结构由内核定义，这里只做透传 + 校验 */
function setAudioGraphPlan(plan) {
  if (!ready || typeof mod.setAudioGraphPlan !== 'function') return false;
  try { mod.setAudioGraphPlan(plan || {}); return true; }
  catch (e) { return false; }
}

function getAudioGraph() {
  if (!ready || typeof mod.getAudioGraph !== 'function') return null;
  try { return mod.getAudioGraph(); } catch (e) { return null; }
}

/** 输出设备：列出 / 切换 */
function getAudioDevices() {
  if (!ready || typeof mod.getAudioDevices !== 'function') return [];
  try {
    const d = mod.getAudioDevices();
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.devices)) return d.devices;
    return [];
  } catch (e) { return []; }
}

function setAudioOutput(deviceId) {
  if (!ready || typeof mod.setAudioOutput !== 'function') return false;
  try { mod.setAudioOutput(String(deviceId || '')); return true; } catch (e) { return false; }
}

module.exports = {
  init, load, play, pause, stop, seek, setVolume, getState, destroy,
  configureSpectrum, spectrumSnapshot, spectrumStatus,
  setEqualizer, setAudioEffect, fade, setSpeed, setNormalizationGain,
  setAudioGraphPlan, getAudioGraph, getAudioDevices, setAudioOutput,
  isReady: () => ready, lastError: () => lastError,
};
