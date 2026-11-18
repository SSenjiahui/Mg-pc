'use strict';
/**
 * 登录窗口预加载脚本。
 *
 * 咪咕 passport 登录成功后不会写 Cookie，而是向父窗口 postMessage：
 *   { channel: '__AUTH_LOGIN__', preload: { ok: true, data: { token, ... } } }
 * （见 @migusdk 的 i7() / o7()：passport 页在 iframe 里，父页监听这条消息。）
 *
 * 我们把它提升为顶层窗口加载，所以消息的 target 就是本窗口 —— 在 preload 里
 * 挂一个 capture 阶段监听，转给主进程即可。同时兜底扫 localStorage 与 URL。
 */
const { ipcRenderer } = require('electron');

function send(payload) {
  try { ipcRenderer.send('auth:token-from-page', payload); } catch (e) {}
}

// 1) __AUTH_LOGIN__ postMessage
window.addEventListener('message', function (ev) {
  var d = ev && ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.channel === '__AUTH_LOGIN__') {
    send({ channel: d.channel, preload: d.preload || null, uid: '', msisdn: '' });
    return;
  }
  // 有些版本直接发 { type:'login', token }
  if (d.token && (d.type === 'login' || d.type === 'token' || d.action === 'login')) {
    send({ token: String(d.token) });
  }
}, true);

// 2) 兜底：DOM ready 后扫一次 localStorage
function scanStorage() {
  try {
    var g = function (k) { return localStorage.getItem(k) || sessionStorage.getItem(k) || ''; };
    var pac = g('mg_auth_pacmtoken');
    var ut = g('mg_auth_utoken');
    if (pac || ut) {
      send({ token: pac || ut, uid: g('mg_auth_uid'), msisdn: g('mg_auth_msisdn') });
    }
  } catch (e) {}
}
window.addEventListener('DOMContentLoaded', function () {
  scanStorage();
  setTimeout(scanStorage, 1500);
});
