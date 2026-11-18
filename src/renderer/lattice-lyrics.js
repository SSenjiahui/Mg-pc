'use strict';
/* ─────────────────────────────────────────────────────────────
   lattice-lyrics.js —— 沉浸式浮动歌词引擎 v2
   复刻 Folia「LatticeLyrics」观感：
     · 景深行栈（alpha / scale / blur 三重衰减，参数取自原实现）
     · 行弹簧阻尼跟随（142/28/.82）+ 逐字独立弹簧（欠阻尼，带过冲）
     · 逐字入场：Bloom —— 每个字从压缩+模糊态按 24ms 错峰弹起
     · 逐字点亮：唱到哪个字，哪个字带速度冲击地弹一下
     · 面板开启：整层缩放弹簧 + 行列表开花 + 曲目信息滑入
     · 长行横向跑马、指针视差、边缘渐隐
   纯 DOM + CSS3D，无第三方依赖。
   暴露：window.LatticeLyrics
   ───────────────────────────────────────────────────────────── */
(function () {
  /* ── 弹簧参数 ── */
  /* 行：Folia monetLyricMotion 原值（ζ≈1.14 过阻尼，平滑无回弹） */
  const LINE_SPRING = { stiffness: 142, damping: 28, mass: 0.82 };
  /* 字：ζ≈0.80 微欠阻尼，约 1.5% 过冲 —— 这就是"弹"的手感 */
  const GLYPH_SPRING = { stiffness: 240, damping: 21, mass: 0.72 };
  /* 面板入场 */
  const STAGE_SPRING = { stiffness: 130, damping: 24, mass: 0.9 };

  const WIN = { before: 2, after: 4 };
  const MIN_FONT_PX = 6, MAX_FONT_PX = 42;
  const MAX_LINE_WIDTH_PX = 1520;

  /* 逐字入场：起始态（相对 fontPx）与错峰节奏 */
  const ENTER = { o: 0, dy: 0.52, s: 0.54, b: 9 };
  const STAGGER_MS = 26, STAGGER_CAP_MS = 320;

  /* 离场遮罩：旧行离开中心时立刻化开，避免与上新行穿行时文字重叠 */
  const LEAVE_T = 0.26, LEAVE_FADE = 0.85, LEAVE_BLUR = 6.5;

  const REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ── 行状态样式表（Folia a(e,t) 原值） ── */
  function stylePassed(n) {
    return {
      alpha: Math.max(0.28, 0.52 - (n - 1) * 0.12),
      scale: Math.max(0.68, 0.72 * Math.pow(0.9, n - 1)),
      blur: 1.1 + (n - 1) * 0.7
    };
  }
  function styleWaiting(n) {
    return {
      alpha: Math.max(0.36, 0.72 - (n - 1) * 0.18),
      scale: Math.max(0.68, 0.72 * Math.pow(0.9, n - 1)),
      blur: n === 1 ? 0.7 : 1.8 + (n - 2) * 0.8
    };
  }
  const STYLE_ACTIVE = { alpha: 1, scale: 1, blur: 0 };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  const S = {
    el: null, linesBox: null, glow: null, bg: null, emptyEl: null,
    headTitle: null, headSub: null, progFill: null,
    open: false, closing: false, built: false, closeT: 0,
    lyric: [], idx: -1, time: 0, duration: 0,
    raf: 0, last: 0,
    fontPx: 26, gap: 42, maxW: 760,
    winFrom: 0, winTo: -1,
    ptr: { px: 0, py: 0, tx: 0, ty: 0 },
    ent: { s: 1, o: 1, vs: 0, vo: 0, ts: 1, to: 1 },
    onSeek: null, onClose: null
  };

  /* ─────────── DOM ─────────── */
  function build(host) {
    if (S.built) return;
    const stage = document.createElement('div');
    stage.className = 'lx-stage';
    stage.id = 'lxStage';
    stage.innerHTML =
      '<div class="lx-bg" id="lxBg"></div>' +
      '<div class="lx-bg-wash"></div>' +
      '<div class="lx-vignette"></div>' +
      '<div class="lx-glow" id="lxGlow"></div>' +
      '<div class="lx-head">' +
        '<div class="lx-track"><strong id="lxTitle">未在播放</strong><small id="lxSub">—</small></div>' +
        '<div class="lx-actions">' +
          '<button class="icon-btn" id="lxClose" title="退出沉浸歌词 (Esc)">' +
            '<svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="lx-fade top"></div>' +
      '<div class="lx-lines" id="lxLines"></div>' +
      '<div class="lx-fade bot"></div>' +
      '<div class="lx-empty" id="lxEmpty">暂无歌词</div>' +
      '<div class="lx-foot"><div class="lx-progress"><div class="lx-progress-fill" id="lxProg"></div></div></div>';

    (host || document.getElementById('app') || document.body).appendChild(stage);

    S.el = stage;
    S.linesBox = stage.querySelector('#lxLines');
    S.bg = stage.querySelector('#lxBg');
    S.glow = stage.querySelector('#lxGlow');
    S.headTitle = stage.querySelector('#lxTitle');
    S.headSub = stage.querySelector('#lxSub');
    S.progFill = stage.querySelector('#lxProg');
    S.emptyEl = stage.querySelector('#lxEmpty');
    S.built = true;

    stage.querySelector('#lxClose').addEventListener('click', function () { close(); });

    stage.addEventListener('pointermove', function (e) {
      const r = stage.getBoundingClientRect();
      const nx = (e.clientX - r.left) / Math.max(1, r.width) - 0.5;
      const ny = (e.clientY - r.top) / Math.max(1, r.height) - 0.5;
      S.ptr.tx = clamp(nx * 7, -3.5, 3.5);
      S.ptr.ty = clamp(-ny * 5, -2.5, 2.5);
    });
    stage.addEventListener('pointerleave', function () { S.ptr.tx = 0; S.ptr.ty = 0; });

    S.linesBox.addEventListener('click', function (e) {
      const ln = e.target.closest('.lx-line');
      if (!ln) return;
      const l = S.lyric[Number(ln.dataset.i)];
      if (l && S.onSeek) S.onSeek(l.t);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.open) { e.preventDefault(); close(); }
    });

    layout();
    window.addEventListener('resize', layout);
  }

  /* ─────────── 排版量测 ─────────── */
  function layout() {
    if (!S.el) return;
    const w = S.el.clientWidth || window.innerWidth;
    const k = w <= 1536 ? 1 : 1 + 0.16 * Math.min(1, (w - 1536) / 664);
    S.fontPx = clamp(clamp(w * 0.0216, 20, 34) * k, MIN_FONT_PX, MAX_FONT_PX);
    S.gap = Math.round(S.fontPx * 1.72);
    S.maxW = Math.max(180, Math.min(MAX_LINE_WIDTH_PX, w * 0.84));
    S.winFrom = 0; S.winTo = -1;
    ensureWindow(true);
  }

  /* ─────────── 切分：CJK 按字，拉丁按词 ─────────── */
  const TOKEN_RE = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]|[^\s\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+|\s+/g;
  function splitTokens(text) {
    const out = [];
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) out.push(m[0]);
    return out.length ? out : [text];
  }

  /* ─────────── 逐字状态 ─────────── */
  function newGlyphState(el) {
    return {
      el: el,
      o: 1, y: 0, s: 1, b: 0,
      vo: 0, vy: 0, vs: 0, vb: 0,
      dl: 0, lit: false, cls: false,
      ts: '', to: '', tf: ''
    };
  }

  /* 入场 Bloom：整行逐字从压缩+模糊态错峰弹起 */
  function bloom(l) {
    if (!l || !l.gs || !l.gs.length) return;
    const n = l.gs.length;
    const stagger = REDUCE ? 0 : Math.min(STAGGER_MS, STAGGER_CAP_MS / Math.max(1, n));
    for (let i = 0; i < n; i++) {
      const g = l.gs[i];
      g.o = ENTER.o;
      g.y = S.fontPx * ENTER.dy;
      g.s = ENTER.s;
      g.b = ENTER.b;
      g.vo = g.vy = g.vs = g.vb = 0;
      g.dl = i * stagger;
    }
    l.cleared = false;
    l.cool = 0;
  }

  function clearGlyphs(l) {
    if (!l || !l.gs) return;
    for (let i = 0; i < l.gs.length; i++) {
      const g = l.gs[i];
      if (g.ts || g.to || g.tf) {
        g.el.style.transform = '';
        g.el.style.opacity = '';
        g.el.style.filter = '';
        g.ts = g.to = g.tf = '';
      }
      g.o = 1; g.y = 0; g.s = 1; g.b = 0;
      g.vo = g.vy = g.vs = g.vb = 0; g.dl = 0;
      if (g.lit || g.edge) {
        g.el.classList.remove('lit');
        g.el.classList.remove('edge');
        g.lit = false; g.cls = false; g.edge = false;
      }
    }
  }

  function writeGlyph(g) {
    const tr = 'translateY(' + g.y.toFixed(2) + 'px) scale(' + g.s.toFixed(3) + ')';
    if (g.ts !== tr) { g.el.style.transform = tr; g.ts = tr; }
    const op = g.o > 0.998 ? '1' : g.o.toFixed(3);
    if (g.to !== op) { g.el.style.opacity = op; g.to = op; }
    const fl = g.b > 0.08 ? 'blur(' + g.b.toFixed(2) + 'px)' : '';
    if (g.tf !== fl) { g.el.style.filter = fl; g.tf = fl; }
  }

  /* 算"这一行此刻该亮到第几个字"，并把 lit/edge 类同步到 DOM。
     不碰弹簧：RAF 停摆时（离屏窗口节流、拖动进度条 seek）画面依然立刻正确；
     RAF 正常跑时幂等，不改变任何动画节奏。 */
  function applyLit(l, active, p, time) {
    const gs = l.gs;
    if (!gs || !gs.length) return 0;
    const n = gs.length;
    /* 逐字时间轴优先：glyphT[i] 是第 i 个 token 的起唱时刻（绝对秒）。
       没有逐字源时 buildGlyphTimeline 已给出权重分配；p 只作最后兜底。 */
    let litN;
    if (!active) litN = 0;
    else if (l.glyphT && l.glyphT.length) {
      let k = 0;
      const lim = Math.min(n, l.glyphT.length);
      while (k < lim && time >= l.glyphT[k]) k++;
      litN = k;
      if (time >= l.t + l.dur - 0.02) litN = n;
    } else {
      litN = Math.floor(clamp(p, 0, 1) * n);
    }
    for (let i = 0; i < n; i++) {
      const g = gs[i];
      const lit = active && (i < litN || (i === litN && litN > 0));
      if (lit !== g.cls) { g.el.classList.toggle('lit', lit); g.cls = lit; }
      const edge = active && i === litN;
      if (edge !== g.edge) { g.el.classList.toggle('edge', edge); g.edge = edge; }
    }
    return litN;
  }

  /* 单帧推进一行的所有字：目标态由 applyLit 决定，这里只跑弹簧 */
  function stepGlyphs(l, active, p, dt, time) {
    const gs = l.gs;
    if (!gs || !gs.length) return;
    const n = gs.length;
    const fpx = S.fontPx;
    const litN = applyLit(l, active, p, time);
    const k = GLYPH_SPRING.stiffness, c = GLYPH_SPRING.damping, m = GLYPH_SPRING.mass;

    for (let i = 0; i < n; i++) {
      const g = gs[i];

      /* ── 目标态 ── */
      let tO, tY, tS, tB, lit = false;
      if (!active) { tO = 1.00; tY = 0; tS = 1.00; tB = 0; }
      else if (i < litN) { tO = 1.00; tY = -0.035 * fpx; tS = 1.008; tB = 0; lit = true; }
      else if (i === litN) { tO = 1.00; tY = -0.075 * fpx; tS = 1.052; tB = 0; lit = true; }
      /* 未唱字只降透明度靠 CSS 变色，不再叠 scale/blur —— 否则整行被劈成两半 */
      else { tO = 1.00; tY = 0; tS = 1.00; tB = 0; }

      /* 刚点亮：给一点速度冲击，产生"弹"的过冲 */
      if (lit && !g.lit) { g.vs += 4.2; g.vy -= 1.7; }
      g.lit = lit;

      /* 入场延迟窗口内冻结在起始态 */
      if (g.dl > 0) {
        g.dl -= dt * 1000;
        if (g.dl < 0) g.dl = 0;
        writeGlyph(g);
        continue;
      }

      /* ── 弹簧积分（半隐式欧拉） ── */
      let a;
      a = ((tO - g.o) * k - g.vo * c) / m; g.vo += a * dt; g.o += g.vo * dt;
      a = ((tY - g.y) * k - g.vy * c) / m; g.vy += a * dt; g.y += g.vy * dt;
      a = ((tS - g.s) * k - g.vs * c) / m; g.vs += a * dt; g.s += g.vs * dt;
      a = ((tB - g.b) * k - g.vb * c) / m; g.vb += a * dt; g.b += g.vb * dt;

      writeGlyph(g);
    }
  }

  /* ─────────── 窗口维护（增量） ─────────── */
  function ensureWindow(force) {
    if (!S.built) return;
    if (!S.lyric.length) {
      S.linesBox.innerHTML = '';
      S.winFrom = 0; S.winTo = -1;
      S.emptyEl.classList.remove('hide');
      return;
    }
    S.emptyEl.classList.add('hide');

    const i = S.idx < 0 ? 0 : S.idx;
    const from = Math.max(0, i - WIN.before);
    const to = Math.min(S.lyric.length - 1, i + WIN.after);
    if (!force && from === S.winFrom && to === S.winTo) return;

    for (let j = 0; j < S.lyric.length; j++) {
      const l = S.lyric[j];
      if (j >= from && j <= to) continue;
      if (l && l.el && l.el.parentNode) {
        l.el.parentNode.removeChild(l.el);
        l.el = null; l.inner = null; l.glyphs = null; l.gs = null; l.cx = null;
      }
    }

    const frag = [];
    for (let j = from; j <= to; j++) {
      const l = S.lyric[j];
      if (l.el) { l.el.style.zIndex = String(60 - Math.abs(j - i)); continue; }

      const el = document.createElement('div');
      el.className = 'lx-line';
      el.dataset.i = String(j);

      const inner = document.createElement('div');
      inner.className = 'lx-inner';
      const txt = document.createElement('span');
      txt.className = 'lx-txt';
      txt.style.fontSize = S.fontPx + 'px';

      const toks = splitTokens(l.txt);
      const gs = [];
      for (let k = 0; k < toks.length; k++) {
        const sp = document.createElement('span');
        sp.className = 'lx-g';
        sp.textContent = toks[k];
        txt.appendChild(sp);
        gs.push(newGlyphState(sp));
      }
      inner.appendChild(txt);
      el.appendChild(inner);

      const dist = j - i;
      const tgt = dist === 0 ? STYLE_ACTIVE : dist < 0 ? stylePassed(-dist) : styleWaiting(dist);
      /* 新行从更远处滑入（行弹簧负责），不是瞬移 */
      const startY = dist === 0 ? S.gap * 0.55 : dist * S.gap * 1.5;
      el.style.opacity = '0';
      el.style.transform =
        'translateY(calc(-50% + ' + startY.toFixed(1) + 'px)) translateZ(' +
        (-Math.min(Math.abs(dist), 4) * 34) + 'px) scale(' + (tgt.scale * 0.86).toFixed(3) + ')';
      el.style.zIndex = String(60 - Math.abs(dist));
      el.dataset.dir = dist === 0 ? '0' : dist < 0 ? '-1' : '1';
      if (dist === 0) el.classList.add('active');

      l.el = el;
      l.inner = inner;
      l.txtEl = txt;
      l.glyphs = Array.prototype.slice.call(txt.children);
      l.gs = gs;
      l.maxShift = 0;
      l.cool = 0;
      l.cleared = true;
      l.leave = 0;
      l.wasActive = dist === 0;
      l.cx = {
        y: startY, s: tgt.scale * 0.86, a: 0, b: tgt.blur,
        vy: 0, vs: 0, va: 0, vb: 0,
        ty: dist * S.gap, ts: tgt.scale, ta: tgt.alpha, tb: tgt.blur
      };
      frag.push(el);
    }
    for (let f = 0; f < frag.length; f++) S.linesBox.appendChild(frag[f]);

    S.winFrom = from; S.winTo = to;

    requestAnimationFrame(function () {
      for (let j = from; j <= to; j++) {
        const l = S.lyric[j];
        if (!l || !l.txtEl) continue;
        const over = (l.txtEl.scrollWidth || 0) - S.maxW;
        l.maxShift = over > 8 ? over : 0;
      }
    });
  }

  /* ── 弹簧步进 ── */
  function stepSpring(cx, keys, dt, P) {
    const k = P.stiffness, c = P.damping, m = P.mass;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i], vk = 'v' + key, tk = 't' + key;
      const a = ((cx[tk] - cx[key]) * k - cx[vk] * c) / m;
      const nv = cx[vk] + a * dt;
      cx[vk] = nv;
      cx[key] = cx[key] + nv * dt;
    }
  }

  /* ── 主循环 ── */
  function tick(now) {
    if (!S.open && !S.closing) { S.raf = 0; S.last = 0; return; }
    S.raf = requestAnimationFrame(tick);
    const dt = S.last ? Math.min(0.05, (now - S.last) / 1000) : 0.016;
    S.last = now;

    /* 面板入场/退场弹簧 */
    const e = S.ent;
    stepSpring(e, ['s', 'o'], dt, STAGE_SPRING);
    S.linesBox.style.transform =
      'rotateX(' + S.ptr.py.toFixed(3) + 'deg) rotateY(' + S.ptr.px.toFixed(3) + 'deg) scale(' + e.s.toFixed(4) + ')';
    S.linesBox.style.opacity = clamp(e.o, 0, 1).toFixed(3);

    /* 指针视差 */
    S.ptr.px = lerp(S.ptr.px, S.ptr.tx, 0.10);
    S.ptr.py = lerp(S.ptr.py, S.ptr.ty, 0.10);

    if (!S.lyric.length) return;
    /* DOM 窗口被清空（resize / 首次 open）时立即补齐，避免切行时出现整帧停住 */
    if (S.winTo < S.winFrom) ensureWindow(false);

    const i = S.idx < 0 ? 0 : S.idx;
    const cur = S.lyric[i];
    const p = cur && cur.dur > 0.12 ? clamp((S.time - cur.t) / cur.dur, 0, 1) : 1;

    for (let j = S.winFrom; j <= S.winTo; j++) {
      const l = S.lyric[j];
      if (!l || !l.el || !l.cx) continue;
      const dist = j - i;
      const tgt = dist === 0 ? STYLE_ACTIVE : dist < 0 ? stylePassed(-dist) : styleWaiting(dist);
      const cx = l.cx;

      cx.ty = dist * S.gap + (dist === 0 ? -p * S.fontPx * 0.06 : 0);
      cx.ts = tgt.scale;
      cx.ta = tgt.alpha;
      cx.tb = tgt.blur;

      stepSpring(cx, ['y', 's', 'a', 'b'], dt, LINE_SPRING);

      /* 刚离开中心的行：alpha 压下去、模糊拉上来，随 0.26s 线性回落 */
      if (l.leave > 0) l.leave = Math.max(0, l.leave - dt / LEAVE_T);
      const lv = l.leave;
      const alphaOut = clamp(cx.a, 0, 1) * (1 - LEAVE_FADE * lv);
      const blurOut = cx.b + LEAVE_BLUR * lv;

      l.el.dataset.dir = dist === 0 ? '0' : dist < 0 ? '-1' : '1';
      l.el.classList.toggle('active', dist === 0);
      l.el.style.opacity = alphaOut.toFixed(3);
      l.el.style.filter = blurOut > 0.06 ? 'blur(' + blurOut.toFixed(2) + 'px)' : 'none';
      const z = -Math.min(Math.abs(dist), 4) * 34;
      l.el.style.transform =
        'translateY(calc(-50% + ' + cx.y.toFixed(2) + 'px)) translateZ(' + z + 'px) scale(' + cx.s.toFixed(3) + ')';

      /* 逐字层 */
      if (dist !== 0) {
        if (l.wasActive) { l.wasActive = false; l.cool = 1.0; l.cleared = false; l.leave = 1; }
        if (l.cool > 0) {
          l.cool -= dt;
          stepGlyphs(l, false, 0, dt, S.time);
        } else if (!l.cleared) {
          clearGlyphs(l);
          l.cleared = true;
        }
      } else {
        l.wasActive = true;
        l.cool = 0;
        stepGlyphs(l, true, p, dt, S.time);
      }
    }

    if (cur) {
      if (cur.maxShift > 0 && cur.inner) {
        cur.inner.style.transform = 'translateX(' + (-p * cur.maxShift).toFixed(1) + 'px)';
      } else if (cur.inner && cur.inner.style.transform) {
        cur.inner.style.transform = '';
      }
      if (S.glow) S.glow.style.opacity = (0.55 + 0.45 * Math.sin(p * Math.PI)).toFixed(3);
    }

    if (S.progFill && S.duration > 0) {
      S.progFill.style.width = (clamp(S.time / S.duration, 0, 1) * 100).toFixed(2) + '%';
    }
  }

  function startLoop() { if (!S.raf) { S.last = 0; S.raf = requestAnimationFrame(tick); } }
  function stopLoop() { if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }

  /* 无逐字时间轴时的兜底：按 token 权重把行时长分配到每个字。
     CJK 单字 1.0；拉丁词按长度 0.55/字符（下限 0.55）；标点 0.35；空白 0.18。
     比原来的「均匀扫光」更贴真实语速，是 Folia 逐字锋面的最低保真替代。 */
  function buildGlyphTimeline(t, dur, txt) {
    const toks = splitTokens(String(txt || ''));
    const n = toks.length;
    if (!n) return [];
    const w = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const tk = toks[i];
      let v;
      if (/^\s+$/.test(tk)) v = 0.18;
      else if (/^[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]$/.test(tk)) v = 1;
      else if (/^[^\w\s]+$/u.test(tk)) v = 0.35;
      else v = Math.max(0.55, tk.length * 0.55);
      w[i] = v; sum += v;
    }
    if (!(sum > 0)) sum = 1;
    const out = new Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { out[i] = t + (acc / sum) * dur; acc += w[i]; }
    return out;
  }

  /* ── 时间轴（二分） ── */
  function pickIndex(t) {
    let lo = 0, hi = S.lyric.length - 1, r = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (S.lyric[mid].t <= t + 0.12) { r = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return r;
  }

  function setTime(t) {
    S.time = Number(t) || 0;
    if (!S.lyric.length) return;
    const idx = pickIndex(S.time);
    if (idx !== S.idx) {
      S.idx = idx;
      ensureWindow(false);
      if (idx >= 0) bloom(S.lyric[idx]);
      snapWindow();
      return;
    }
    const cur = S.lyric[idx];
    if (cur && cur.gs) {
      const p = cur.dur > 0.12 ? clamp((S.time - cur.t) / cur.dur, 0, 1) : 1;
      applyLit(cur, true, p, S.time);
    }
  }

  /* 把窗口内的行立即对齐到目标行：seek 后不必等弹簧收敛。
     RAF 被节流（离屏窗口）时也能得到正确构图，正常播放时它幂等。 */
  function snapWindow() {
    if (!S.built || !S.lyric.length) return;
    const i = S.idx < 0 ? 0 : S.idx;
    const cur = S.lyric[i];
    const p = cur && cur.dur > 0.12 ? clamp((S.time - cur.t) / cur.dur, 0, 1) : 1;
    for (let j = S.winFrom; j <= S.winTo; j++) {
      const l = S.lyric[j];
      if (!l || !l.el || !l.cx) continue;
      const dist = j - i;
      const tgt = dist === 0 ? STYLE_ACTIVE : dist < 0 ? stylePassed(-dist) : styleWaiting(dist);
      const cx = l.cx;
      cx.y = dist * S.gap + (dist === 0 ? -p * S.fontPx * 0.06 : 0);
      cx.s = tgt.scale; cx.a = tgt.alpha; cx.b = tgt.blur;
      cx.vy = 0; cx.vs = 0; cx.va = 0; cx.vb = 0;
      l.leave = 0;
      l.el.dataset.dir = dist === 0 ? '0' : dist < 0 ? '-1' : '1';
      l.el.classList.toggle('active', dist === 0);
      l.el.style.opacity = clamp(cx.a, 0, 1).toFixed(3);
      l.el.style.filter = cx.b > 0.06 ? 'blur(' + cx.b.toFixed(2) + 'px)' : 'none';
      const z = -Math.min(Math.abs(dist), 4) * 34;
      l.el.style.transform =
        'translateY(calc(-50% + ' + cx.y.toFixed(2) + 'px)) translateZ(' + z + 'px) scale(' + cx.s.toFixed(3) + ')';
      if (dist === 0) {
        l.wasActive = true; l.cool = 0;
        applyLit(l, true, p, S.time);
      } else {
        l.wasActive = false; l.cool = 0;
        if (!l.cleared) { clearGlyphs(l); l.cleared = true; }
      }
    }
    if (cur && cur.gs) applyLit(cur, true, p, S.time);
  }

  /* ── 对外 API ── */
  function setTrack(song) {
    if (!S.built) build();
    if (!S.headTitle) return;
    S.headTitle.textContent = (song && song.name) || '未在播放';
    S.headSub.textContent = (song && (song.singer || song.album)) || '—';
    S.duration = Number((song && song.duration) || 0) || 0;
    if (song && song.img) {
      S.bg.style.backgroundImage = 'url("' + String(song.img).replace(/"/g, '%22') + '")';
      S.bg.classList.add('show');
    } else {
      S.bg.classList.remove('show');
    }
  }

  function setLyric(list) {
    if (!S.built) build();
    const arr = Array.isArray(list) ? list : [];
    const total = S.duration;
    S.lyric = arr.map(function (l, i) {
      const next = arr[i + 1];
      let d = next ? next.t - l.t : (total > l.t ? total - l.t : 4);
      if (!(d > 0.12)) d = 0.9;
      if (d > 14) d = 14;
      return {
        t: l.t, txt: String(l.txt || ''), dur: d,
        glyphT: Array.isArray(l.glyphT) && l.glyphT.length
          ? l.glyphT.slice()
          : buildGlyphTimeline(l.t, d, l.txt),
        el: null, inner: null, txtEl: null, glyphs: null, gs: null, cx: null,
        maxShift: 0, cool: 0, cleared: true, wasActive: false, leave: 0
      };
    });
    S.idx = -1;
    S.winFrom = 0; S.winTo = -1;
    if (S.linesBox) S.linesBox.innerHTML = '';
    setTime(S.time);
    ensureWindow(true);
    if (S.idx >= 0) bloom(S.lyric[S.idx]);
  }

  function open() {
    if (!S.built) build();
    if (S.closeT) { clearTimeout(S.closeT); S.closeT = 0; }
    S.closing = false;
    S.open = true;
    S.el.classList.add('open');

    /* 入场起始态：整层放大 + 透明，弹簧回位 */
    S.ent.s = REDUCE ? 1 : 0.885;
    S.ent.o = REDUCE ? 1 : 0;
    S.ent.vs = 0; S.ent.vo = 0;
    S.ent.ts = 1; S.ent.to = 1;

    layout();
    S.winFrom = 0; S.winTo = -1;
    ensureWindow(true);
    if (S.idx >= 0) bloom(S.lyric[S.idx]);
    snapWindow();
    startLoop();
  }

  function close() {
    if (!S.built || S.closing) return;
    S.open = false;
    S.closing = true;
    S.ent.ts = REDUCE ? 1 : 1.045;
    S.ent.to = REDUCE ? 1 : 0;
    if (S.onClose) S.onClose();
    S.closeT = setTimeout(function () {
      S.closeT = 0;
      S.closing = false;
      S.el.classList.remove('open');
      stopLoop();
    }, 420);
  }

  function toggle() { if (S.open) close(); else open(); }

  window.LatticeLyrics = {
    init: function (opt) {
      opt = opt || {};
      build(opt.host);
      S.onSeek = opt.onSeek || null;
      S.onClose = opt.onClose || null;
      return window.LatticeLyrics;
    },
    setTrack: setTrack,
    setLyric: setLyric,
    setTime: setTime,
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function () { return S.open; },
    relayout: layout
  };
})();
