/* errors.js —— 全局错误收集（外置以满足 script-src 'self'） */
window.__errs = [];
window.addEventListener('error', function (e) {
  window.__errs.push((e.message || '') + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', function (e) {
  window.__errs.push('reject: ' + ((e.reason && e.reason.message) || e.reason));
});
