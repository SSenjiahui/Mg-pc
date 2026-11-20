'use strict';
/* 任务栏歌词窗口的渲染脚本：只做一件事——把当前歌词行铺到任务栏上 */
const el = document.getElementById('line');
let last = '';

window.tblSetText = function (text) {
  const s = String(text || '').trim();
  if (s === last) return;
  last = s;
  document.body.classList.toggle('empty', !s);
  if (!s) return;
  el.classList.add('swap');
  setTimeout(() => {
    el.textContent = s;
    el.classList.remove('swap');
  }, 150);
};

window.tblSetTheme = function (dark) {
  document.body.classList.toggle('light', !dark);
};
