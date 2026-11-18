// 内容脚本：在网页里找漫画图片、显示「译」按钮、把译文盖在图片上
(() => {
  if (window.__mgtlLoaded) return;
  window.__mgtlLoaded = true;

  const D = globalThis.MGTL_DEFAULTS;
  const cfg = { displayMode: D.displayMode, hoverButton: D.hoverButton, minSize: D.minSize, autoAfterClick: D.autoAfterClick, autoHosts: [] };
  const HOST = location.hostname;

  try {
    chrome.storage.local.get(cfg).then((v) => {
      Object.assign(cfg, v);
      syncAuto();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      for (const k of Object.keys(cfg)) {
        if (ch[k]) cfg[k] = ch[k].newValue === undefined ? D[k] : ch[k].newValue;
      }
      if (ch.displayMode) for (const st of states.values()) layout(st);
      if (ch.hoverButton && !cfg.hoverButton) hoverEl = null;
      if (ch.autoHosts) syncAuto();
    });
  } catch (e) {}

  // ---------- 界面（放在 Shadow DOM 里，避免和网页样式互相影响） ----------
  const CSS = `
    .btns { position: fixed; left: 0; top: 0; display: none; gap: 4px; pointer-events: auto; }
    .btns.on { display: flex; }
    button { all: unset; cursor: pointer; background: rgba(20,20,20,.85); color: #fff; border-radius: 6px;
      padding: 7px 10px; font: 600 13px/1 system-ui, "Microsoft YaHei", "Hiragino Sans", sans-serif;
      box-shadow: 0 1px 5px rgba(0,0,0,.45); user-select: none; }
    button:hover { background: #e8590c; }
    .layer { position: fixed; left: 0; top: 0; pointer-events: none; }
    .box { position: absolute; transform: translate(-50%, -50%); box-sizing: border-box; display: flex;
      align-items: center; justify-content: center; padding: 2px 3px; border-radius: 6px;
      background: rgba(255,255,255,.97); color: #111; text-align: center; line-height: 1.25; font-weight: 500;
      font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Hiragino Sans", "Malgun Gothic", system-ui, sans-serif;
      overflow-wrap: anywhere; word-break: break-word; }
    .box.dark { background: rgba(0,0,0,.92); color: #fff; }
    .box > span { display: block; width: 100%; white-space: pre-wrap; }
    .badge { position: absolute; max-width: 300px; box-sizing: border-box; pointer-events: auto;
      background: rgba(20,20,20,.88); color: #fff; padding: 6px 10px; border-radius: 6px;
      font: 13px/1.45 system-ui, "Microsoft YaHei", sans-serif; box-shadow: 0 1px 5px rgba(0,0,0,.45); }
    .badge.error { background: #c92a2a; cursor: pointer; }
    .num { position: absolute; transform: translate(-50%, -50%); min-width: 18px; height: 18px; padding: 0 3px;
      box-sizing: border-box; border-radius: 9px; background: #e8590c; color: #fff; text-align: center;
      font: 700 11px/18px system-ui, sans-serif; box-shadow: 0 1px 3px rgba(0,0,0,.5); }
    .panel { position: absolute; width: 260px; overflow: auto; pointer-events: auto; box-sizing: border-box;
      background: rgba(255,255,255,.97); color: #111; border-radius: 8px; padding: 8px 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,.35);
      font: 14px/1.5 "Microsoft YaHei", "PingFang SC", "Hiragino Sans", system-ui, sans-serif; }
    .panel div { margin: 0 0 6px; }
    .panel b { color: #e8590c; margin-right: 5px; }
  `;

  let host = null;
  let root = null;
  let btnWrap = null;
  let btnMain = null;
  let btnRedo = null;
  let btnAuto = null;
  let overUI = false;

  function ensureHost() {
    if (!host) {
      host = document.createElement('div');
      host.id = 'mgtl-host';
      host.style.cssText =
        'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;';
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);

      btnWrap = document.createElement('div');
      btnWrap.className = 'btns';
      btnMain = document.createElement('button');
      btnRedo = document.createElement('button');
      btnRedo.textContent = '重译';
      btnRedo.title = '重新翻译这张图';
      btnAuto = document.createElement('button');
      btnWrap.append(btnMain, btnRedo, btnAuto);
      root.appendChild(btnWrap);

      btnWrap.addEventListener('mouseenter', () => (overUI = true));
      btnWrap.addEventListener('mouseleave', () => (overUI = false));
      const stop = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      btnMain.addEventListener('click', (e) => {
        stop(e);
        const el = hoverEl;
        if (!el) return;
        const st = states.get(el);
        if (st && st.status === 'done') {
          st.visible = !st.visible;
          layout(st);
        } else if (!st || st.status === 'error') {
          translateEl(el, { allowShot: true });
          if (cfg.autoAfterClick && !autoOn()) setAuto(true);
        }
      });
      btnAuto.addEventListener('click', (e) => {
        stop(e);
        setAuto(!autoOn());
      });
      btnRedo.addEventListener('click', (e) => {
        stop(e);
        if (hoverEl) translateEl(hoverEl, { allowShot: true, force: true });
      });
      for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
        btnWrap.addEventListener(ev, (e) => e.stopPropagation());
      }
    }
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  }

  // ---------- 图片判断与定位 ----------
  function isCandidate(el) {
    if (!el || (el.tagName !== 'IMG' && el.tagName !== 'CANVAS')) return false;
    if (el.tagName === 'IMG' && (!el.complete || el.naturalWidth < 64 || el.naturalHeight < 64)) return false;
    const r = el.getBoundingClientRect();
    const min = Math.max(60, Number(cfg.minSize) || 180);
    return r.width >= min && r.height >= min;
  }

  const srcOf = (el) => (el.tagName === 'IMG' ? el.currentSrc || el.src || '' : null);

  // 图片内容实际显示的区域（考虑 object-fit: contain 留白的情况）
  function contentRect(el) {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let width = r.width;
    let height = r.height;
    if (el.tagName === 'IMG' && el.naturalWidth && el.naturalHeight && width > 0 && height > 0) {
      let fit = '';
      try {
        fit = getComputedStyle(el).objectFit;
      } catch (e) {}
      if (fit === 'contain') {
        const s = Math.min(width / el.naturalWidth, height / el.naturalHeight);
        const w2 = el.naturalWidth * s;
        const h2 = el.naturalHeight * s;
        left += (width - w2) / 2;
        top += (height - h2) / 2;
        width = w2;
        height = h2;
      }
    }
    return { left, top, width, height };
  }

  // ---------- 每张图片的状态 ----------
  const states = new Map();
  let hoverEl = null;
  let looping = false;

  function createState(el) {
    ensureHost();
    const layer = document.createElement('div');
    layer.className = 'layer';
    const wrap = document.createElement('div');
    layer.appendChild(wrap);
    root.appendChild(layer);
    const st = { el, src: srcOf(el), status: 'loading', visible: true, items: [], layer, wrap, badge: null, panel: null, w: -1, h: -1, off: false, dirty: false };
    states.set(el, st);
    startLoop();
    return st;
  }

  function destroy(st) {
    st.dead = true;
    st.layer.remove();
    if (states.get(st.el) === st) states.delete(st.el);
  }

  function setBadge(st, text, kind) {
    if (st.badge) st.badge.remove();
    st.badge = null;
    if (!text) return;
    const b = document.createElement('div');
    b.className = 'badge' + (kind === 'error' ? ' error' : '');
    b.textContent = text + (kind === 'error' ? '（点击关闭）' : '');
    if (kind === 'error') {
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        destroy(st);
      });
    }
    st.layer.appendChild(b);
    st.badge = b;
  }

  function updateState(st) {
    const el = st.el;
    if (!el.isConnected || (st.src !== null && srcOf(el) !== st.src)) {
      destroy(st);
      return;
    }
    const r = contentRect(el);
    if (r.width < 2 || r.height < 2 || r.top + r.height < 0 || r.top > window.innerHeight) {
      if (!st.off) {
        st.off = true;
        st.layer.style.display = 'none'; // 图片不在屏幕上，译文也一起隐藏
      }
      return;
    }
    if (st.off) {
      st.off = false;
      st.layer.style.display = '';
    }
    st.layer.style.transform = `translate(${r.left}px, ${r.top}px)`;
    if (Math.abs(r.width - st.w) > 0.5 || Math.abs(r.height - st.h) > 0.5) {
      st.w = r.width;
      st.h = r.height;
      st.layer.style.width = r.width + 'px';
      st.layer.style.height = r.height + 'px';
      st.dirty = true;
    }
    if (st.dirty) layout(st);
    const topIn = Math.max(0, -r.top);
    const leftIn = Math.max(0, -r.left);
    if (st.badge) {
      st.badge.style.left = leftIn + 8 + 'px';
      st.badge.style.top = topIn + 44 + 'px';
    }
    if (st.panel) {
      const spaceRight = window.innerWidth - (r.left + r.width);
      st.panel.style.left = (spaceRight >= 272 ? r.width + 8 : Math.max(0, r.width - 268)) + 'px';
      st.panel.style.maxHeight = Math.max(80, Math.min(r.height, window.innerHeight)) + 'px';
      // 译文列表跟着图片走：不会超出这张图的底部，免得盖到下一张图旁边
      const ph = st.panel.offsetHeight;
      st.panel.style.top = Math.max(0, Math.min(topIn, r.height - ph)) + 'px';
    }
  }

  // 把译文画到图片上
  function layout(st) {
    st.wrap.textContent = '';
    st.panel = null;
    // 图片不在屏幕上时量不出文字大小，先记下来，等它回到屏幕上再排版
    if (st.off || st.w <= 0) {
      st.dirty = true;
      return;
    }
    st.dirty = false;
    if (st.status !== 'done' || !st.visible) return;
    const W = st.w;
    const H = st.h;
    if (cfg.displayMode === 'list') {
      const panel = document.createElement('div');
      panel.className = 'panel';
      st.items.forEach((it, i) => {
        if (it.hasBox) {
          const n = document.createElement('div');
          n.className = 'num';
          n.textContent = String(i + 1);
          n.style.left = it.x * W + 'px';
          n.style.top = it.y * H + 'px';
          st.wrap.appendChild(n);
        }
        const row = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = String(i + 1);
        row.append(b, document.createTextNode(it.text));
        if (it.src) row.title = it.src;
        panel.appendChild(row);
      });
      st.wrap.appendChild(panel);
      st.panel = panel;
      return;
    }
    const maxFont = Math.max(12, Math.min(40, W / 16));
    for (const it of st.items) {
      if (!it.hasBox) continue;
      const box = document.createElement('div');
      box.className = 'box' + (it.dark ? ' dark' : '');
      const span = document.createElement('span');
      span.textContent = it.text;
      box.appendChild(span);
      const bw = Math.max(it.w * W * 1.08 + 6, 26);
      const bh = Math.max(it.h * H * 1.08 + 6, 18);
      box.style.left = (it.x + it.w / 2) * W + 'px';
      box.style.top = (it.y + it.h / 2) * H + 'px';
      box.style.width = bw + 'px';
      box.style.minHeight = bh + 'px';
      st.wrap.appendChild(box);
      fitText(box, span, bh - 4, maxFont);
    }
  }

  // 自动选一个刚好放得下的字号
  function fitText(box, span, availH, maxFont) {
    let lo = 8;
    let hi = Math.floor(maxFont);
    box.style.fontSize = hi + 'px';
    if (span.offsetHeight <= availH) return;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      box.style.fontSize = mid + 'px';
      if (span.offsetHeight <= availH) lo = mid;
      else hi = mid - 1;
    }
    box.style.fontSize = lo + 'px';
  }

  // ---------- 悬停按钮 ----------
  function updateBtn() {
    if (!btnWrap) return;
    const el = hoverEl;
    if (!el || !el.isConnected) {
      btnWrap.classList.remove('on');
      return;
    }
    const st = states.get(el);
    if (st && st.status === 'loading') {
      btnWrap.classList.remove('on');
      return;
    }
    const r = contentRect(el);
    if (r.width < 2 || r.top + r.height < 40 || r.top > window.innerHeight - 20) {
      btnWrap.classList.remove('on');
      return;
    }
    const x = Math.min(Math.max(r.left + 8, 4), window.innerWidth - 230);
    const y = Math.min(Math.max(r.top + 8, 4), window.innerHeight - 40);
    btnWrap.style.transform = `translate(${x}px, ${y}px)`;
    const done = st && st.status === 'done';
    btnMain.textContent = done ? (st.visible ? '看原图' : '看译文') : '译';
    btnMain.title = done ? '切换原图 / 译文' : '翻译这张图片';
    btnRedo.style.display = done ? '' : 'none';
    const on = autoOn();
    btnAuto.textContent = on ? '自动：开' : '自动：关';
    btnAuto.title = on ? '本网站正在自动翻译图片，点击关闭' : '点击后，本网站的图片滚动到附近时会自动翻译';
    btnAuto.style.background = on ? '#2b8a3e' : '';
    btnWrap.classList.add('on');
  }

  let mx = 0;
  let my = 0;
  let moveTimer = null;
  function pick() {
    moveTimer = null;
    if (overUI) return;
    if (!cfg.hoverButton) {
      hoverEl = null;
      return;
    }
    let found = null;
    let els = [];
    try {
      els = document.elementsFromPoint(mx, my);
    } catch (e) {}
    for (const el of els) {
      if (isCandidate(el)) {
        found = el;
        break;
      }
    }
    hoverEl = found;
    if (found) {
      ensureHost();
      startLoop();
    }
  }
  document.addEventListener(
    'mousemove',
    (e) => {
      mx = e.clientX;
      my = e.clientY;
      if (!moveTimer) moveTimer = setTimeout(pick, 80);
    },
    { passive: true, capture: true }
  );
  document.documentElement.addEventListener('mouseleave', () => {
    if (!overUI) hoverEl = null;
  });

  // ---------- 动画循环：让译文跟着图片移动 ----------
  function startLoop() {
    if (looping) return;
    looping = true;
    requestAnimationFrame(tick);
  }
  function tick() {
    if (!states.size && !hoverEl) {
      looping = false;
      if (btnWrap) btnWrap.classList.remove('on');
      return;
    }
    ensureHost();
    for (const st of Array.from(states.values())) updateState(st);
    updateBtn();
    requestAnimationFrame(tick);
  }

  // ---------- 与后台通信 ----------
  function friendly(e) {
    const m = String((e && e.message) || e);
    if (/context invalidated|Extension context/i.test(m)) return '插件已更新或重新加载，请刷新本页面后再试';
    return m;
  }

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      throw new Error(friendly(e));
    }
  }

  function callTranslate(dataUrl, width, height) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'mgtl-translate' });
      } catch (e) {
        reject(new Error(friendly(e)));
        return;
      }
      let done = false;
      const ping = setInterval(() => {
        try {
          port.postMessage({ type: 'ping' });
        } catch (e) {}
      }, 15000);
      port.onMessage.addListener((msg) => {
        if (!msg || msg.type !== 'result') return;
        done = true;
        clearInterval(ping);
        try {
          port.disconnect();
        } catch (e) {}
        if (msg.ok) resolve(msg.items || []);
        else reject(new Error(msg.error || '翻译失败'));
      });
      port.onDisconnect.addListener(() => {
        clearInterval(ping);
        if (!done) reject(new Error('与插件后台的连接中断，请重试'));
      });
      port.postMessage({ type: 'start', dataUrl, width, height });
    });
  }

  // ---------- 读取图片内容 ----------
  function dataUrlToBlob(u) {
    const i = u.indexOf(',');
    const mime = u.slice(5, i).split(';')[0] || 'image/png';
    const bin = atob(u.slice(i + 1));
    const a = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k);
    return new Blob([a], { type: mime });
  }

  async function toBitmap(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      if (bmp.width < 32 || bmp.height < 32) return null;
      return bmp;
    } catch (e) {
      return null;
    }
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  async function screenshot(el) {
    if (window.top !== window) throw new Error('这张图片位于内嵌框架中，无法读取');
    const r = contentRect(el);
    const L = Math.max(r.left, 0);
    const T = Math.max(r.top, 0);
    const R = Math.min(r.left + r.width, window.innerWidth);
    const B = Math.min(r.top + r.height, window.innerHeight);
    if (R - L < 80 || B - T < 80) throw new Error('无法直接读取这张图片，请把它滚动到屏幕中间再点一次');
    let res;
    host.style.setProperty('visibility', 'hidden', 'important');
    try {
      await nextFrame();
      await nextFrame();
      await new Promise((r2) => setTimeout(r2, 60));
      res = await send({ type: 'mgtl-capture' });
    } finally {
      host.style.removeProperty('visibility');
    }
    if (!res || !res.ok) throw new Error('截图失败：' + ((res && res.error) || '未知原因'));
    const shot = await toBitmap(dataUrlToBlob(res.dataUrl));
    if (!shot) throw new Error('截图失败');
    const s = shot.width / window.innerWidth;
    const bitmap = await createImageBitmap(
      shot,
      Math.round(L * s),
      Math.round(T * s),
      Math.max(1, Math.round((R - L) * s)),
      Math.max(1, Math.round((B - T) * s))
    );
    return {
      bitmap,
      region: { x: (L - r.left) / r.width, y: (T - r.top) / r.height, w: (R - L) / r.width, h: (B - T) / r.height }
    };
  }

  // 依次尝试：页面内直接读 → 后台跨域抓取 → 截图
  async function grabImage(el, allowShot) {
    let bitmap = null;
    if (el.tagName === 'CANVAS') {
      try {
        const blob = await new Promise((res, rej) => el.toBlob((b) => (b ? res(b) : rej(new Error('empty'))), 'image/png'));
        bitmap = await toBitmap(blob);
      } catch (e) {}
    } else {
      const url = srcOf(el);
      if (url) {
        try {
          const r = await fetch(url, { cache: 'force-cache' });
          if (r.ok) bitmap = await toBitmap(await r.blob());
        } catch (e) {}
        if (!bitmap && /^https?:/i.test(url)) {
          try {
            const res = await send({ type: 'mgtl-fetch-image', url });
            if (res && res.ok) bitmap = await toBitmap(dataUrlToBlob(res.dataUrl));
          } catch (e) {}
        }
      }
    }
    if (bitmap) return { bitmap, region: null };
    if (!allowShot) throw new Error('无法直接读取这张图片，请把鼠标移到图上单独点「译」');
    return screenshot(el);
  }

  function encode(bmp, sx, sy, sw, sh) {
    const MAX = 1800;
    const s = Math.min(1, MAX / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * s));
    const h = Math.max(1, Math.round(sh * s));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    return { dataUrl: c.toDataURL('image/jpeg', 0.9), w, h };
  }

  // ---------- 并发控制 ----------
  function limiter(max) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= max || !queue.length) return;
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn()
        .then(resolve, reject)
        .finally(() => {
          active--;
          next();
        });
    };
    return (fn) =>
      new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
  }
  const jobLimit = limiter(2); // 同时处理的图片数
  const apiLimit = limiter(3); // 同时进行的 AI 请求数

  // 长条图（韩漫等）切成几段分别翻译
  async function runTiles(bitmap) {
    const W = bitmap.width;
    const H = bitmap.height;
    let n = 1;
    if (H > W * 2.5) n = Math.min(12, Math.ceil(H / (W * 1.6)));
    const tasks = [];
    for (let i = 0; i < n; i++) {
      const y0 = Math.round((i * H) / n);
      const y1 = Math.round(((i + 1) * H) / n);
      tasks.push(
        apiLimit(async () => {
          const enc = encode(bitmap, 0, y0, W, y1 - y0);
          const items = await callTranslate(enc.dataUrl, enc.w, enc.h);
          return items.map((it) => Object.assign({}, it, { y: (y0 + it.y * (y1 - y0)) / H, h: (it.h * (y1 - y0)) / H }));
        })
      );
    }
    const parts = await Promise.all(tasks);
    return parts.flat();
  }

  // ---------- 翻译一张图 ----------
  async function translateEl(el, opts) {
    const allowShot = !opts || opts.allowShot !== false;
    let st = states.get(el);
    if (st && st.status === 'loading') return;
    if (st && st.status === 'done' && !(opts && opts.force)) return;
    if (st) destroy(st);
    st = createState(el);
    setBadge(st, '排队中…');
    try {
      await jobLimit(async () => {
        if (st.dead) return;
        setBadge(st, '翻译中…');
        const src = await grabImage(el, allowShot);
        if (st.dead) return;
        let items = await runTiles(src.bitmap);
        if (src.bitmap.close) src.bitmap.close();
        if (src.region) {
          const g = src.region;
          items = items.map((it) =>
            Object.assign({}, it, { x: g.x + it.x * g.w, y: g.y + it.y * g.h, w: it.w * g.w, h: it.h * g.h })
          );
        }
        if (st.dead) return;
        st.items = items;
        st.status = 'done';
        st.visible = true;
        if (!items.length) {
          setBadge(st, '没有发现需要翻译的文字');
          setTimeout(() => {
            if (!st.dead) setBadge(st, '');
          }, 3000);
        } else {
          setBadge(st, '');
        }
        layout(st);
      });
    } catch (e) {
      if (st.dead) return;
      st.status = 'error';
      setBadge(st, '翻译失败：' + friendly(e), 'error');
    }
  }

  function candidates() {
    return Array.from(document.querySelectorAll('img, canvas')).filter(isCandidate);
  }

  function pending() {
    return candidates().filter((el) => {
      const s = states.get(el);
      return !s || s.status === 'error';
    });
  }

  // ---------- 自动翻译：滚动到哪里翻译到哪里 ----------
  let autoTimer = null;
  function autoOn() {
    return Array.isArray(cfg.autoHosts) && cfg.autoHosts.includes(HOST);
  }
  function autoScan() {
    if (document.hidden) return;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    for (const el of document.querySelectorAll('img, canvas')) {
      if (states.has(el) || !isCandidate(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 300) continue; // 自动模式只处理够大的图，避免翻译广告和小图
      if (r.bottom < -vh * 0.5 || r.top > vh * 2 || r.right < 0 || r.left > vw) continue; // 只处理屏幕附近的图
      translateEl(el, { allowShot: false });
    }
  }
  function syncAuto() {
    if (autoOn()) {
      if (!autoTimer) {
        autoTimer = setInterval(autoScan, 1000);
        autoScan();
      }
    } else if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }
  async function setAuto(on) {
    try {
      const v = await chrome.storage.local.get({ autoHosts: [] });
      const s = new Set(Array.isArray(v.autoHosts) ? v.autoHosts : []);
      if (on) s.add(HOST);
      else s.delete(HOST);
      cfg.autoHosts = Array.from(s);
      await chrome.storage.local.set({ autoHosts: cfg.autoHosts });
    } catch (e) {}
    syncAuto();
  }

  // ---------- 右键菜单 / 弹窗发来的指令 ----------
  let ctxEl = null;
  let ctxX = 0;
  let ctxY = 0;
  document.addEventListener(
    'contextmenu',
    (e) => {
      ctxEl = e.target;
      ctxX = e.clientX;
      ctxY = e.clientY;
    },
    true
  );

  function replyMaybe(count, sendResponse, extra) {
    const payload = Object.assign({ count }, extra || {});
    if (count > 0) {
      sendResponse(payload);
      return false;
    }
    if (window.top !== window) return false; // 内嵌框架里没有图片就不回应
    setTimeout(() => sendResponse(payload), 250); // 顶层页面稍等一下，让有图片的框架先回应
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'mgtl-translate-clicked') {
      let el = ctxEl && ctxEl.tagName === 'IMG' ? ctxEl : null;
      if (!el) {
        try {
          el = document.elementsFromPoint(ctxX, ctxY).find((x) => x.tagName === 'IMG') || null;
        } catch (e) {}
      }
      if (!el && msg.srcUrl) {
        el = Array.from(document.images).find((i) => i.currentSrc === msg.srcUrl || i.src === msg.srcUrl) || null;
      }
      if (el) {
        translateEl(el, { allowShot: true, force: true });
        if (cfg.autoAfterClick && !autoOn()) setAuto(true);
      }
      return;
    }
    if (msg.type === 'mgtl-count') {
      return replyMaybe(pending().length, sendResponse, { translated: states.size });
    }
    if (msg.type === 'mgtl-translate-all') {
      const list = pending();
      list.forEach((el) => translateEl(el, { allowShot: false }));
      return replyMaybe(list.length, sendResponse);
    }
    if (msg.type === 'mgtl-auto-get') {
      if (window.top === window) sendResponse({ on: autoOn(), host: HOST });
      return;
    }
    if (msg.type === 'mgtl-auto-set') {
      if (window.top === window) setAuto(!!msg.on).then(() => sendResponse({ on: autoOn() }));
      return window.top === window;
    }
    if (msg.type === 'mgtl-clear') {
      for (const st of Array.from(states.values())) destroy(st);
      if (window.top === window) sendResponse({ ok: true });
      return;
    }
  });
})();
