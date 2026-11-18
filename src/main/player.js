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

module.exports = { init, load, play, pause, stop, seek, setVolume, getState, destroy, isReady: () => ready, lastError: () => lastError };
