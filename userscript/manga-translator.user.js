// ==UserScript==
// @name         漫画图片翻译 (AI)
// @namespace    manga-translator-ai
// @version      2.4.0
// @description  用 AI 视觉模型翻译网页上的漫画图片，译文直接显示在图片上。手机浏览器可用。
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM.getValue
// @grant        GM_setValue
// @grant        GM.setValue
// @grant        GM_registerMenuCommand
// @connect      generativelanguage.googleapis.com
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      openrouter.ai
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @inject-into  content
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =====================================================================
   * 第一部分：和网页无关的纯逻辑（提示词、解析 AI 回复、错误说明等）
   * ===================================================================== */

  const DEFAULTS = {
    preset: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    model: 'gemini-3.5-flash-lite',
    targetLang: '简体中文',
    skipLangs: '',
    displayMode: 'overlay', // overlay = 盖在原文上；list = 图上标编号 + 屏幕底部列表
    rpm: 8, // 每分钟最多发给 AI 的请求数，0 = 不限制
    minSize: 150,
    extraPrompt: '',
    autoHosts: [], // 开启了自动翻译的网站
    hiddenHosts: [], // 不显示按钮的网站
    screenHosts: [], // 自动翻译时固定用「整屏」方式的网站（只在 App 里用到）
    fabX: 1, // 悬浮按钮的位置（0~1，相对屏幕）
    fabY: 0.7
  };

  const PRESETS = {
    gemini: {
      name: 'Google Gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai',
      keyName: 'Google AI Studio',
      keyUrl: 'https://aistudio.google.com/apikey',
      model: 'gemini-3.5-flash-lite',
      rpm: 8
    },
    deepseek: {
      name: 'DeepSeek',
      url: 'https://api.deepseek.com',
      keyName: 'DeepSeek 开放平台',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      model: 'deepseek-flash', // DeepSeek 目前只有这个模型能看图
      rpm: 0
    },
    openai: { name: 'OpenAI', url: 'https://api.openai.com/v1', keyName: 'OpenAI 平台', keyUrl: 'https://platform.openai.com/api-keys' },
    openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', keyName: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys' },
    custom: { name: '自定义（兼容 OpenAI 格式的接口）', url: '', keyName: '', keyUrl: '' }
  };

  const TARGETS = ['简体中文', '繁體中文', '日本語', 'English', '한국어'];

  function buildPrompt(c) {
    const target = String(c.targetLang || '简体中文').trim();
    const skip = String(c.skipLangs || '').trim();
    const extra = String(c.extraPrompt || '').trim();
    const lines = [
      'You are a professional manga / comic / webtoon translator with perfect OCR.',
      `Task: find every piece of readable text in the attached image (speech bubbles, thought bubbles, narration boxes, captions, signs and prominent sound effects) and translate it into ${target}.`,
      '',
      'Output ONLY a JSON array. No markdown fences, no commentary. Each element has this shape:',
      '{"box":[ymin,xmin,ymax,xmax],"src":"original text","text":"translation","dark":false}',
      '',
      'Rules:',
      '- "box": four integers from 0 to 1000. ymin/ymax are normalized to the image height, xmin/xmax to the image width, origin at the top-left corner. The box must tightly cover the whole text block.',
      '- One element per bubble or text block. Merge all lines of the same bubble into one element. List elements in natural reading order.',
      '- "dark": true only when the text is light-colored on a dark background, otherwise false.',
      `- "text": a natural, fluent ${target} translation that fits the tone of the speaker. Keep names consistent. No translator notes.`,
      `- Skip text that is already written in ${target}.`,
      '- Skip watermarks, URLs, page numbers and tiny illegible text.',
      '- If there is nothing to translate, output [].'
    ];
    if (skip) lines.push(`- Do NOT include text written in these languages (the reader can already read them): ${skip}.`);
    if (extra) lines.push('- Extra instructions from the user: ' + extra);
    return lines.join('\n');
  }

  // 把 AI 的回复解析成 [{x,y,w,h,text,src,dark,hasBox}]，坐标是 0~1 的比例
  function parseItems(text, width, height) {
    let t = String(text || '').trim();
    if (!t) throw new Error('AI 没有返回任何内容。可能是这张图被该模型的内容过滤拦下了，可以换一个模型试试。');
    // 有些模型会先输出一段思考过程，去掉它，只保留后面的正式结果
    t = t.replace(/<(thought|think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    const open = t.search(/<(thought|think|thinking|reasoning)>/i);
    if (open >= 0) t = t.slice(open);
    t = t.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const tryParse = (s) => {
      try {
        return JSON.parse(s);
      } catch (e) {
        return undefined;
      }
    };
    let data = tryParse(t);
    if (data === undefined) {
      // 找出所有可能是结果数组开头的位置，从最后一个往前试（正式结果总在最后）
      const starts = [];
      const re = /\[\s*(\{|\])/g;
      let m;
      while ((m = re.exec(t))) starts.push(m.index);
      const b = t.lastIndexOf(']');
      for (let i = starts.length - 1; i >= 0 && data === undefined; i--) {
        if (b > starts[i]) data = tryParse(t.slice(starts[i], b + 1));
      }
      if (data === undefined && starts.length) {
        // 输出被截断时：保留到最后一个完整的 }
        const c = t.lastIndexOf('}');
        const a = starts[starts.length - 1];
        if (c > a) data = tryParse(t.slice(a, c + 1) + ']');
        if (data === undefined && starts.length > 1 && c > starts[0]) data = tryParse(t.slice(starts[0], c + 1) + ']');
      }
    }
    if (data && !Array.isArray(data) && typeof data === 'object') {
      data = data.items || data.result || data.translations || Object.values(data).find(Array.isArray);
    }
    if (!Array.isArray(data)) {
      throw new Error('AI 返回的内容无法解析，可以重试或换一个模型。返回开头：' + t.slice(0, 80));
    }
    const lim = (v) => Math.min(1000, Math.max(0, v));
    const items = [];
    for (const it of data) {
      if (!it || typeof it !== 'object') continue;
      const tr = String(it.text || it.translation || it.dst || '').trim();
      if (!tr) continue;
      const item = { text: tr, src: String(it.src || it.original || '').trim(), dark: !!it.dark, hasBox: false, x: 0, y: 0, w: 0, h: 0 };
      const b = it.box || it.box_2d || it.bbox;
      if (Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && isFinite(n))) {
        let y0 = b[0];
        let x0 = b[1];
        let y1 = b[2];
        let x1 = b[3];
        const mx = Math.max(y0, x0, y1, x1);
        if (mx > 1000 && width && height) {
          // 模型给的是像素坐标
          y0 = (y0 / height) * 1000;
          y1 = (y1 / height) * 1000;
          x0 = (x0 / width) * 1000;
          x1 = (x1 / width) * 1000;
        } else if (mx <= 1) {
          // 模型给的是 0~1 的小数
          y0 *= 1000;
          x0 *= 1000;
          y1 *= 1000;
          x1 *= 1000;
        }
        y0 = lim(y0);
        x0 = lim(x0);
        y1 = lim(y1);
        x1 = lim(x1);
        if (y1 < y0) [y0, y1] = [y1, y0];
        if (x1 < x0) [x0, x1] = [x1, x0];
        if (y1 - y0 >= 2 && x1 - x0 >= 2) {
          item.hasBox = true;
          item.x = x0 / 1000;
          item.y = y0 / 1000;
          item.w = (x1 - x0) / 1000;
          item.h = (y1 - y0) / 1000;
        }
      }
      items.push(item);
    }
    return items;
  }

  function contentToText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p) => (p && (p.text || '')) || '').join('');
    return '';
  }

  // 从接口返回的原始文本里取出 AI 的回复
  function completionText(raw) {
    let j;
    try {
      j = JSON.parse(raw);
    } catch (e) {
      throw new Error('AI 接口返回的不是有效数据，请检查接口地址。返回开头：' + String(raw || '').slice(0, 60));
    }
    if (Array.isArray(j)) j = j[0];
    if (j && j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    return contentToText(m && m.content);
  }

  function describeHttpError(status, text) {
    let detail = '';
    try {
      let j = JSON.parse(text);
      if (Array.isArray(j)) j = j[0];
      detail = (j && j.error && (j.error.message || j.error)) || '';
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch (e) {
      detail = String(text || '');
    }
    detail = detail.slice(0, 200);
    let hint = '请求失败';
    if (!status) hint = '连不上 AI 接口';
    else if (status === 401 || status === 403) hint = 'API Key 无效或没有权限';
    else if (status === 404) hint = '接口地址或模型名称不对';
    else if (status === 429) hint = '请求太频繁，已自动重试多次仍失败。等一分钟再试，或在设置里调低「每分钟最多请求数」';
    else if (status === 400) hint = '请求被拒绝（可能是该模型不支持图片输入）';
    else if (status >= 500) hint = 'AI 服务端出错，请稍后再试';
    return `${hint}（${status || 0}）${detail ? '：' + detail : ''}`;
  }

  // 根据文件开头的几个字节判断图片类型
  function sniffMime(bytes, fallback) {
    const b = bytes || [];
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69) return 'image/avif';
    return /^image\//i.test(fallback || '') ? fallback : 'image/jpeg';
  }

  // 并发控制：同时最多执行 max 个任务
  function limiter(max) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= max || !queue.length) return;
      active++;
      const job = queue.shift();
      job
        .fn()
        .then(job.resolve, job.reject)
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

  function parseHostList(text) {
    const out = [];
    for (const raw of String(text || '').split(/[\s,，]+/)) {
      const s = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase();
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }

  // 不在浏览器里（比如用 Node 做自测）时，只导出上面的纯逻辑
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { DEFAULTS, buildPrompt, parseItems, completionText, describeHttpError, sniffMime, limiter, parseHostList };
    }
    return;
  }

  /* =====================================================================
   * 第二部分：在网页里运行的部分
   * ===================================================================== */

  try {
    if (window.top !== window) return; // 只在最外层页面运行，不在内嵌框架里重复出现
  } catch (e) {
    return;
  }
  if (window.__mgtlUserScript) return;
  window.__mgtlUserScript = true;

  const HOST = location.hostname;
  const cfg = Object.assign({}, DEFAULTS);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  // 在安卓 App 里运行时，App 会提供一组原生接口；在浏览器的脚本管理器里运行时这里是 null
  const APP = typeof __mgtlApp !== 'undefined' && __mgtlApp ? __mgtlApp : null;

  // ---------- 保存设置（兼容不同的脚本管理器） ----------
  const store = {
    async get(key, def) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key, def);
        if (typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function') return await GM.getValue(key, def);
      } catch (e) {}
      try {
        const v = localStorage.getItem('mgtl_' + key);
        return v == null ? def : v;
      } catch (e) {
        return def;
      }
    },
    async set(key, val) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(key, val);
          return;
        }
        if (typeof GM !== 'undefined' && GM && typeof GM.setValue === 'function') {
          await GM.setValue(key, val);
          return;
        }
      } catch (e) {}
      try {
        localStorage.setItem('mgtl_' + key, val);
      } catch (e) {}
    }
  };

  async function loadCfg() {
    let raw = null;
    try {
      raw = await store.get('cfg', null);
    } catch (e) {}
    if (raw) {
      try {
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        for (const k of Object.keys(DEFAULTS)) if (obj[k] !== undefined && obj[k] !== null) cfg[k] = obj[k];
      } catch (e) {}
    }
    if (!Array.isArray(cfg.autoHosts)) cfg.autoHosts = [];
    if (!Array.isArray(cfg.hiddenHosts)) cfg.hiddenHosts = [];
    if (!Array.isArray(cfg.screenHosts)) cfg.screenHosts = [];
  }

  // 修改设置前先读一次最新的，避免覆盖其他标签页刚做的修改
  async function mutateCfg(fn) {
    await loadCfg();
    fn(cfg);
    await store.set('cfg', JSON.stringify(cfg));
  }

  // ---------- 网络请求 ----------
  function gmFn() {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') return GM.xmlHttpRequest.bind(GM);
    return null;
  }

  function gmXhr(details) {
    return new Promise((resolve, reject) => {
      const fn = gmFn();
      if (!fn) {
        reject(new Error('NO_GM_XHR'));
        return;
      }
      let done = false;
      const finish = (f, v) => {
        if (!done) {
          done = true;
          f(v);
        }
      };
      try {
        const ret = fn(
          Object.assign({}, details, {
            onload: (res) => finish(resolve, res),
            onerror: () => finish(reject, new Error('NETWORK')),
            ontimeout: () => finish(reject, new Error('TIMEOUT')),
            onabort: () => finish(reject, new Error('NETWORK'))
          })
        );
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
      } catch (e) {
        finish(reject, new Error('NETWORK'));
      }
    });
  }

  // 发一个请求，返回 {status, text}。优先用脚本管理器的跨域请求，没有时退回普通 fetch
  async function httpText(method, url, headers, body, timeoutMs) {
    if (gmFn()) {
      const d = { method, url, headers, timeout: timeoutMs };
      if (body != null) d.data = body;
      const res = await gmXhr(d);
      const text = typeof res.responseText === 'string' ? res.responseText : typeof res.response === 'string' ? res.response : '';
      return { status: res.status || 0, text };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const init = { method, headers, signal: ac.signal };
      if (body != null) init.body = body;
      const r = await fetch(url, init);
      return { status: r.status, text: await r.text() };
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
  }

  function endpoint(path) {
    let base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('还没有填写接口地址，请打开设置。');
    base = base.replace(/\/chat\/completions$/, '');
    return base + path;
  }

  function authHeaders() {
    const hd = { 'Content-Type': 'application/json' };
    const key = String(cfg.apiKey || '').trim();
    if (key) hd.Authorization = 'Bearer ' + key;
    return hd;
  }

  const isLocal = () => /localhost|127\.0\.0\.1/.test(cfg.baseUrl || '');
  const isConfigured = () => !!String(cfg.model || '').trim() && (!!String(cfg.apiKey || '').trim() || isLocal());

  // 限速：把请求均匀排开，避免撞到免费额度的每分钟上限
  let nextSlot = 0;
  async function waitForSlot() {
    const rpm = Number(cfg.rpm) || 0;
    if (rpm <= 0) return;
    const gap = 60000 / rpm;
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + gap;
    if (at > now) await sleep(at - now);
  }

  // 把一张图（data URL）发给 AI，返回译文列表
  async function translateDataUrl(dataUrl, width, height, timeoutMs) {
    if (!String(cfg.apiKey || '').trim() && !isLocal()) throw new Error('还没有填写 API Key，请打开设置。');
    if (!String(cfg.model || '').trim()) throw new Error('还没有填写模型，请打开设置。');
    await waitForSlot();
    const body = {
      model: String(cfg.model).trim(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(cfg) },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ]
    };
    // Gemini 的新模型默认会先思考很久；翻译漫画不需要，调低可以明显加快
    if (/googleapis\.com/i.test(cfg.baseUrl || '')) body.reasoning_effort = 'low';
    // DeepSeek 默认开着"思考模式"，翻译漫画用不着，关掉更快也更省
    if (/deepseek\.com/i.test(cfg.baseUrl || '')) body.thinking = { type: 'disabled' };
    const slow = '等了很久 AI 都没有回复。多半是这个模型现在太忙，请稍后再试，或换一个模型。';
    const deadline = Date.now() + (timeoutMs || 120000);
    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      if (left < 2000) throw new Error(slow);
      let res;
      try {
        res = await httpText('POST', endpoint('/chat/completions'), authHeaders(), JSON.stringify(body), left);
      } catch (e) {
        if (e && e.message === 'TIMEOUT') throw new Error(slow);
        if (e && e.message === 'NETWORK') throw new Error('连不上 AI 接口，请检查网络和接口地址。');
        throw e;
      }
      // 个别模型不接受上面这两个加速用的参数：去掉后重试一次
      if (res.status === 400 && (body.reasoning_effort || body.thinking)) {
        delete body.reasoning_effort;
        delete body.thinking;
        continue;
      }
      if (res.status === 429 && /per\s*day|perday|daily/i.test(res.text)) {
        throw new Error('今天的免费额度已经用完了。可以在设置里换一个模型继续用，或换成付费的 Key。');
      }
      // 请求太频繁（429）或服务端繁忙（5xx）时自动等一会儿再试
      const busy = res.status === 429 || (res.status >= 500 && res.status <= 504);
      if (busy && attempt < 3) {
        await sleep((res.status === 429 ? 7000 : 4000) * (attempt + 1));
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(describeHttpError(res.status, res.text));
      return parseItems(completionText(res.text), width, height);
    }
  }

  // ---------- 读取图片内容 ----------
  const srcOf = (el) => (el.tagName === 'IMG' ? el.currentSrc || el.src || '' : null);

  // 把图片数据解码成可以画到画布上的对象
  async function decode(blob) {
    if (!blob || !blob.size) return null;
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob);
        if (bmp.width < 32 || bmp.height < 32) return null;
        return { img: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close && bmp.close() };
      } catch (e) {}
    }
    return new Promise((resolve) => {
      let url;
      try {
        url = URL.createObjectURL(blob);
      } catch (e) {
        resolve(null);
        return;
      }
      const im = new Image();
      im.onload = () => {
        if (im.naturalWidth < 32 || im.naturalHeight < 32) {
          URL.revokeObjectURL(url);
          resolve(null);
        } else {
          resolve({ img: im, w: im.naturalWidth, h: im.naturalHeight, close: () => URL.revokeObjectURL(url) });
        }
      };
      im.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      im.src = url;
    });
  }

  const canvasBlob = (c, type) =>
    new Promise((resolve, reject) => {
      try {
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('empty'))), type || 'image/png');
      } catch (e) {
        reject(e);
      }
    });

  // 通过脚本管理器跨域下载图片（网页自己读不到时使用）
  async function gmFetchBlob(url) {
    const res = await gmXhr({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000, headers: { Referer: location.href } });
    if (res.status && (res.status < 200 || res.status >= 300)) throw new Error('HTTP ' + res.status);
    const body = res.response;
    if (!body) throw new Error('empty');
    let bytes;
    if (typeof body.byteLength === 'number') bytes = new Uint8Array(body);
    else if (typeof body.arrayBuffer === 'function') bytes = new Uint8Array(await body.arrayBuffer());
    else throw new Error('unsupported');
    const m = /content-type:\s*([^\r\n;]+)/i.exec(res.responseHeaders || '');
    return new Blob([bytes], { type: sniffMime(bytes, m ? m[1].trim() : '') });
  }

  // 依次尝试：网页内直接读 → 脚本管理器跨域下载 → 把页面上的图直接画到画布
  async function grabDirect(el) {
    let pic = null;
    if (el.tagName === 'CANVAS') {
      try {
        pic = await decode(await canvasBlob(el));
      } catch (e) {}
    } else {
      const url = srcOf(el);
      if (url) {
        try {
          const r = await fetch(url, { cache: 'force-cache' });
          if (r.ok) pic = await decode(await r.blob());
        } catch (e) {}
        if (!pic && /^https?:/i.test(url)) {
          try {
            pic = await decode(await gmFetchBlob(url));
          } catch (e) {}
        }
      }
      if (!pic && el.naturalWidth && el.naturalHeight) {
        try {
          const s = Math.min(1, Math.sqrt(12e6 / (el.naturalWidth * el.naturalHeight)));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(el.naturalWidth * s));
          c.height = Math.max(1, Math.round(el.naturalHeight * s));
          c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
          pic = await decode(await canvasBlob(c));
        } catch (e) {}
      }
    }
    return pic;
  }

  // ---------- 截屏（只在安卓 App 里可用） ----------
  // 有些阅读器的漫画读不到内容（受保护的画布、拼起来的小块、内嵌框架）。
  // 这时不再一张张图片去对位置，而是把当前屏幕整个截下来当成一张图翻译，译文按屏幕位置盖上去。
  function screenRect() {
    const vv = window.visualViewport;
    return vv ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height } : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }
  // 「整个屏幕」这张虚拟的图
  const SCREEN = {
    tagName: 'SCREEN',
    isConnected: true,
    rect: null, // 截屏那一刻屏幕所在的位置；之后保持不变，译文才不会跟着缩放乱跑
    getBoundingClientRect() {
      return this.rect || screenRect();
    }
  };

  const needShot = new WeakSet(); // 已经知道读不到内容的图片
  const shotLimit = limiter(1); // 截屏一次只做一张

  // 向 App 要一张当前屏幕的截图（不动我们自己的界面）
  async function grabShot() {
    const b64 = await Promise.race([
      APP.capture(),
      new Promise((res, rej) => setTimeout(() => rej(new Error('截屏超时')), 8000))
    ]);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const shot = await decode(new Blob([bytes], { type: sniffMime(bytes, 'image/jpeg') }));
    if (!shot) throw new Error('截屏失败');
    return shot;
  }

  // 用来翻译的截屏：先把我们自己的按钮和译文藏起来，免得被拍进去
  async function captureScreen() {
    host.style.setProperty('visibility', 'hidden', 'important');
    try {
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      await sleep(120);
      SCREEN.rect = screenRect();
      const shot = await grabShot();
      shot.sig = sigOf(shot, null);
      return shot;
    } finally {
      host.style.removeProperty('visibility');
    }
  }

  // 画面"指纹"：把截图缩成很小的灰度图，用来判断两次截屏是不是同一个画面（翻页了没有、图片加载完了没有）
  const SIG_W = 48;
  const SIG_H = 72;
  function sigOf(shot, rects) {
    const c = document.createElement('canvas');
    c.width = SIG_W;
    c.height = SIG_H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(shot.img, 0, 0, SIG_W, SIG_H);
    const d = g.getImageData(0, 0, SIG_W, SIG_H).data;
    const v = new Uint8Array(SIG_W * SIG_H);
    const m = new Uint8Array(SIG_W * SIG_H); // 1 = 这一格被我们自己的界面挡住了，比较时不算
    for (let i = 0; i < v.length; i++) v[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
    for (const r of rects || []) {
      // 四周多留两格：按钮和提示有阴影，会稍微超出自己的边框
      const x0 = clamp(Math.floor(r.x0 * SIG_W) - 2, 0, SIG_W - 1);
      const x1 = clamp(Math.ceil(r.x1 * SIG_W) + 1, 0, SIG_W - 1);
      const y0 = clamp(Math.floor(r.y0 * SIG_H) - 2, 0, SIG_H - 1);
      const y1 = clamp(Math.ceil(r.y1 * SIG_H) + 1, 0, SIG_H - 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * SIG_W + x] = 1;
    }
    return { v, m };
  }
  function sameSig(a, b) {
    let n = 0;
    let big = 0;
    let sum = 0;
    for (let i = 0; i < a.v.length; i++) {
      if (a.m[i] || b.m[i]) continue;
      const d = Math.abs(a.v[i] - b.v[i]);
      n++;
      sum += d;
      if (d > 18) big++;
    }
    if (!n) return true;
    // 同一个静止画面的两次截屏几乎一模一样，所以标准定得很严：换了一个对话框也要能看出来
    return big <= 2 && sum / n < 2;
  }

  // 我们自己的界面（按钮、提示、菜单…）在屏幕上占的位置，按屏幕比例表示
  function uiRects() {
    const vr = screenRect();
    const out = [];
    const add = (el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      out.push({ x0: (r.left - vr.left) / vr.width, y0: (r.top - vr.top) / vr.height, x1: (r.right - vr.left) / vr.width, y1: (r.bottom - vr.top) / vr.height });
    };
    add(fab);
    add(toastEl);
    add(menu);
    add(sheet);
    for (const b of root.querySelectorAll('.badge')) add(b);
    return out;
  }

  // 不打扰界面的快速截屏，只取"指纹"
  async function quickSig() {
    const rects = uiRects();
    const shot = await shotLimit(grabShot);
    try {
      return sigOf(shot, rects);
    } finally {
      try {
        shot.close();
      } catch (e) {}
    }
  }

  async function grabImage(el) {
    if (el === SCREEN) return shotLimit(captureScreen);
    const pic = needShot.has(el) ? null : await grabDirect(el);
    if (pic) return pic;
    const err = new Error('这张图片受网站保护，脚本读不到它的内容');
    if (APP) err.code = 'NEEDSHOT'; // 在 App 里：改用截屏翻译整个屏幕
    throw err;
  }

  function encode(pic, sx, sy, sw, sh) {
    const MAX = 1600;
    const s = Math.min(1, MAX / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * s));
    const ht = Math.max(1, Math.round(sh * s));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = ht;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, ht);
    g.imageSmoothingQuality = 'high';
    g.drawImage(pic.img, sx, sy, sw, sh, 0, 0, w, ht);
    return { dataUrl: c.toDataURL('image/jpeg', 0.88), w, h: ht };
  }

  const jobLimit = limiter(2); // 同时处理的图片数
  const apiLimit = limiter(3); // 同时进行的 AI 请求数

  // 长条图（韩漫等）切成几段分别翻译
  async function runTiles(pic) {
    const W = pic.w;
    const H = pic.h;
    let n = 1;
    if (H > W * 2.5) n = Math.min(12, Math.ceil(H / (W * 1.6)));
    const tasks = [];
    for (let i = 0; i < n; i++) {
      const y0 = Math.round((i * H) / n);
      const y1 = Math.round(((i + 1) * H) / n);
      tasks.push(
        apiLimit(async () => {
          const enc = encode(pic, 0, y0, W, y1 - y0);
          const items = await translateDataUrl(enc.dataUrl, enc.w, enc.h);
          return items.map((it) => Object.assign({}, it, { y: (y0 + it.y * (y1 - y0)) / H, h: (it.h * (y1 - y0)) / H }));
        })
      );
    }
    const parts = await Promise.all(tasks);
    return [].concat.apply([], parts);
  }

  // ---------- 界面（放在 Shadow DOM 里，避免和网页样式互相影响） ----------
  const FONT = 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    .layer { position: fixed; left: 0; top: 0; z-index: 1; pointer-events: none; }
    .box { position: absolute; transform: translate(-50%, -50%); display: flex; align-items: center; justify-content: center;
      padding: 2px 3px; border-radius: 6px; background: rgba(255,255,255,.97); color: #111; text-align: center;
      line-height: 1.25; font-weight: 500; font-family: ${FONT}; overflow-wrap: anywhere; word-break: break-word; }
    .box.dark { background: rgba(0,0,0,.92); color: #fff; }
    .box > span { display: block; width: 100%; white-space: pre-wrap; }
    .num { position: absolute; transform: translate(-50%, -50%); min-width: 20px; height: 20px; padding: 0 4px; border-radius: 10px;
      background: #e8590c; color: #fff; text-align: center; font: 700 12px/20px ${FONT}; box-shadow: 0 1px 3px rgba(0,0,0,.5); }
    .badge { position: absolute; max-width: 250px; pointer-events: auto; background: rgba(20,20,20,.88); color: #fff;
      padding: 6px 10px; border-radius: 8px; font: 13px/1.45 ${FONT}; box-shadow: 0 1px 5px rgba(0,0,0,.45); }
    .badge.error { background: #c92a2a; cursor: pointer; }

    .fab { position: fixed; left: 0; top: 0; z-index: 5; width: 46px; height: 46px; border-radius: 23px;
      background: rgba(232,89,12,.94); color: #fff; text-align: center; font: 700 19px/46px ${FONT};
      pointer-events: auto; cursor: pointer; opacity: .8; touch-action: none; user-select: none; -webkit-user-select: none;
      box-shadow: 0 2px 8px rgba(0,0,0,.45); }
    .fab.auto { background: rgba(43,138,62,.95); }
    .fab.busy { opacity: 1; }
    .fab i { position: absolute; top: -5px; right: -5px; display: none; min-width: 19px; height: 19px; padding: 0 4px;
      border-radius: 10px; background: #111; color: #fff; font: 700 11px/19px ${FONT}; }

    .menu { position: fixed; left: 0; top: 0; z-index: 7; display: none; min-width: 230px; max-width: 86vw; overflow: hidden;
      background: #fff; color: #111; border-radius: 12px; box-shadow: 0 4px 18px rgba(0,0,0,.4); pointer-events: auto;
      font: 15px/1.3 ${FONT}; }
    .menu.on { display: block; }
    .menu, .mask, .sheet, .badge { touch-action: manipulation; }
    .menu div { padding: 13px 16px; border-bottom: 1px solid #eee; cursor: pointer; user-select: none; -webkit-user-select: none; }
    .menu div:last-child { border-bottom: 0; }
    .menu div:active { background: #f1f3f5; }
    .menu div.sub { color: #888; font-size: 13px; }

    .toast { position: fixed; left: 50%; bottom: 84px; z-index: 12; transform: translateX(-50%); width: max-content; max-width: 86vw;
      background: rgba(20,20,20,.92); color: #fff; padding: 9px 14px; border-radius: 10px; text-align: center;
      font: 14px/1.4 ${FONT}; pointer-events: none; opacity: 0; transition: opacity .2s; }
    .toast.on { opacity: 1; }

    .sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2; display: none; pointer-events: auto;
      background: rgba(255,255,255,.97); color: #111; border-radius: 14px 14px 0 0; box-shadow: 0 -2px 12px rgba(0,0,0,.3);
      font: 15px/1.5 ${FONT}; padding-bottom: env(safe-area-inset-bottom, 0px); }
    .sheet.on { display: block; }
    .sheet .hd { display: flex; align-items: center; justify-content: space-between; padding: 7px 14px 5px; color: #777;
      font-size: 13px; cursor: pointer; user-select: none; -webkit-user-select: none; }
    .sheet .bd { max-height: 30vh; overflow-y: auto; padding: 0 14px 10px; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .sheet.min .bd { display: none; }
    .sheet .row { margin: 0 0 6px; }
    .sheet .row b { color: #e8590c; margin-right: 6px; }

    .mask { position: fixed; left: 0; top: 0; right: 0; bottom: 0; z-index: 10; display: none; pointer-events: auto; background: rgba(0,0,0,.5); }
    .mask.on { display: block; }
    .dlg { position: absolute; top: 0; bottom: 0; left: 50%; transform: translateX(-50%); width: 100%; max-width: 560px;
      overflow-y: auto; background: #f6f6f4; color: #222; font: 16px/1.5 ${FONT}; padding: 0 16px 48px;
      overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .dlg .top { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between;
      background: #f6f6f4; padding: 14px 0 10px; }
    .dlg h1 { font-size: 19px; font-weight: 700; margin: 0; }
    .dlg h2 { font-size: 16px; font-weight: 700; margin: 0 0 4px; }
    .dlg section { background: #fff; border-radius: 12px; padding: 14px; margin: 0 0 14px; }
    .dlg label { display: block; font-weight: 600; font-size: 15px; margin: 12px 0 4px; }
    .dlg .hint { color: #777; font-size: 13px; margin-top: 4px; }
    .dlg input, .dlg select, .dlg textarea { display: block; width: 100%; margin: 0; padding: 10px; border: 1px solid #ccc;
      border-radius: 8px; background: #fff; color: #222; font: 16px/1.3 ${FONT}; }
    .dlg input, .dlg textarea { -webkit-appearance: none; appearance: none; }
    .dlg textarea { min-height: 70px; resize: vertical; }
    .dlg .btn { display: inline-block; margin: 0; padding: 10px 16px; border: 0; border-radius: 8px; background: #e9ecef;
      color: #222; font: 600 15px/1.2 ${FONT}; cursor: pointer; white-space: nowrap; }
    .dlg .btn.pri { background: #e8590c; color: #fff; }
    .dlg .row2 { display: flex; gap: 8px; align-items: center; }
    .dlg .row2 > input { flex: 1; min-width: 0; }
    .dlg .res { display: none; margin-top: 10px; padding: 9px 12px; border-radius: 8px; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
    .dlg .res.ok { display: block; background: #ebfbee; border: 1px solid #b2f2bb; }
    .dlg .res.err { display: block; background: #fff5f5; border: 1px solid #ffc9c9; }
    .dlg .res.info { display: block; background: #f1f3f5; border: 1px solid #dee2e6; }
    .dlg a { color: #d9480f; }
    .dlg .saved { color: #2b8a3e; font-size: 13px; margin-right: 10px; opacity: 0; transition: opacity .2s; }
    .dlg .saved.on { opacity: 1; }
  `;

  // 让一个元素响应"轻点"。平时靠浏览器发出的 click；
  // 但有些漫画阅读器会接管触摸手势，浏览器就不再发 click 了，这时改用触摸 / 指针事件自己判断。
  function onTap(el, fn) {
    let down = null;
    let timer = null;
    let noClick = false; // 网页取消了这次触摸的默认行为：可以确定不会再有 click
    let ignoreClickUntil = 0;
    const run = () => {
      if (!el.disabled) fn();
    };
    // 不等 click、自己执行（之后万一 click 又迟到了，要忽略它，免得同一次点按执行两遍）
    const fallback = () => {
      clearTimeout(timer);
      timer = null;
      ignoreClickUntil = Date.now() + 700;
      run();
    };
    el.addEventListener('pointerdown', (e) => {
      down = { id: e.pointerId, x: e.clientX, y: e.clientY };
      noClick = false;
    });
    el.addEventListener(
      'touchstart',
      (e) => {
        if (e.defaultPrevented) noClick = true;
      },
      { passive: true }
    );
    el.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
      clearTimeout(timer);
      timer = setTimeout(fallback, 400); // 保险：一直等不到 click 就自己执行
    });
    el.addEventListener(
      'touchend',
      (e) => {
        if (timer && (noClick || e.defaultPrevented)) fallback(); // 已经确定不会有 click，不用再等
      },
      { passive: true }
    );
    el.addEventListener('pointercancel', () => {
      down = null;
      clearTimeout(timer);
      timer = null;
    });
    el.addEventListener('click', () => {
      clearTimeout(timer);
      timer = null;
      if (Date.now() < ignoreClickUntil) {
        ignoreClickUntil = 0;
        return;
      }
      run();
    });
  }

  // 小工具：创建元素。h('div', {class:'x', onclick:fn}, 子元素或文字...)
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k === 'onclick' && typeof v === 'function') onTap(el, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k in el) {
          try {
            el[k] = v;
          } catch (e) {
            el.setAttribute(k, String(v));
          }
        } else el.setAttribute(k, String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kid = arguments[i];
      if (kid == null || kid === false) continue;
      if (Array.isArray(kid)) {
        for (const x of kid) if (x != null) el.append(x);
      } else el.append(kid);
    }
    return el;
  }

  let host = null;
  let root = null;
  let fab = null;
  let fabCnt = null;
  let menu = null;
  let toastEl = null;
  let sheet = null;
  let sheetHd = null;
  let sheetBd = null;
  let mask = null;

  const isHidden = () => cfg.hiddenHosts.includes(HOST);
  const autoOn = () => cfg.autoHosts.includes(HOST);

  function buildUI() {
    host = document.createElement('div');
    host.id = 'mgtl-host';
    host.style.cssText =
      'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;';
    root = host.attachShadow({ mode: 'closed' }); // closed：网页自己的脚本看不到我们界面里的内容
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    try {
      // 个别网站的安全策略会拦截上面这种样式写法，这里再用另一种方式加一遍
      const css = new CSSStyleSheet();
      css.replaceSync(CSS);
      root.adoptedStyleSheets = [css];
    } catch (e) {}

    fabCnt = h('i');
    fab = h('div', { class: 'fab' }, '译', fabCnt);
    menu = h('div', { class: 'menu' });
    toastEl = h('div', { class: 'toast' });
    sheetHd = h('div', { class: 'hd' });
    sheetBd = h('div', { class: 'bd' });
    sheet = h('div', { class: 'sheet' }, sheetHd, sheetBd);
    root.append(sheet, fab, menu, toastEl);

    // 我们界面上的点击、按键不要传给网页（否则点按钮时阅读器可能跟着翻页）
    const STOP = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'touchend', 'contextmenu', 'keydown', 'keyup', 'keypress', 'input', 'change'];
    for (const ev of STOP) root.addEventListener(ev, (e) => e.stopPropagation());

    // 悬浮按钮：轻点打开菜单，按住可以拖到别的位置
    let drag = null;
    fab.addEventListener('pointerdown', (e) => {
      const r = fab.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      try {
        fab.setPointerCapture(e.pointerId);
      } catch (err) {}
      e.preventDefault();
    });
    fab.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 8) return;
      drag.moved = true;
      closeMenu();
      fab.style.left = clamp(drag.ox + dx, 0, window.innerWidth - 46) + 'px';
      fab.style.top = clamp(drag.oy + dy, 0, window.innerHeight - 46) + 'px';
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      try {
        fab.releasePointerCapture(e.pointerId);
      } catch (err) {}
      if (d.moved) {
        const r = fab.getBoundingClientRect();
        const fx = clamp(r.left / Math.max(1, window.innerWidth - 46), 0, 1);
        const fy = clamp(r.top / Math.max(1, window.innerHeight - 46), 0, 1);
        mutateCfg((c) => {
          c.fabX = fx;
          c.fabY = fy;
        });
      } else if (e.type === 'pointerup') {
        if (menu.classList.contains('on')) closeMenu();
        else openMenu();
      }
    };
    fab.addEventListener('pointerup', endDrag);
    fab.addEventListener('pointercancel', endDrag);

    onTap(sheetHd, () => {
      sheetMin = !sheetMin;
      sheetKey = null;
      updateSheet(true);
    });

    // 点别处时收起菜单。
    // 注意：我们的界面在 closed 的 shadow DOM 里。从外面（document）看，点在界面上的事件，目标就是 host 本身，
    // 看不到里面具体点的是菜单还是按钮，所以"点的是不是菜单"要放到 root 里面去判断。
    document.addEventListener(
      'pointerdown',
      (e) => {
        autoBudget = AUTO_BUDGET; // 有人在操作：自动翻译可以继续
        if (e.target === host) return; // 点在我们自己的界面上
        closeMenu();
        dropScreen(true); // 碰了网页（翻页、滚动）：整屏翻译的译文已经对不上了
      },
      true
    );
    // 手指离开网页后，等画面停稳再自动翻译（只在整屏方式的自动翻译开着时才会真的去做）
    const pageTouchEnd = (e) => {
      if (e.target !== host) userMoved(600);
    };
    document.addEventListener('pointerup', pageTouchEnd, true);
    document.addEventListener('pointercancel', pageTouchEnd, true);
    root.addEventListener(
      'pointerdown',
      (e) => {
        if (!menu.classList.contains('on')) return;
        const t = e.target;
        if (menu.contains(t) || fab.contains(t)) return;
        closeMenu(); // 点在我们界面的其他地方（比如底部的译文列表）
      },
      true
    );
    window.addEventListener(
      'scroll',
      (e) => {
        // 只认整个网页的滚动；网页里某个小区域自己在滚（比如轮播广告）不算
        const t = e.target;
        if (t === document || t === document.documentElement || t === document.body) {
          dropScreen(true);
          kickScreen(600); // 注意：滚动本身不算"有人在操作"（网页自己也会滚），不恢复自动翻译的额度
        }
      },
      { capture: true, passive: true }
    );
    window.addEventListener('resize', () => {
      placeFab();
      closeMenu();
      dropScreen(false);
      kickScreen(800);
    });
    // 滚轮、键盘（电脑上）也算有人在操作
    const acted = () => {
      autoBudget = AUTO_BUDGET;
    };
    document.addEventListener('wheel', acted, { capture: true, passive: true });
    document.addEventListener('keydown', acted, true);
  }

  function ensureHost() {
    if (!host) {
      buildUI();
      placeFab();
    }
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  }

  function applyVisibility() {
    if (!host) return;
    if (isHidden()) host.style.setProperty('display', 'none', 'important');
    else {
      host.style.removeProperty('display');
      fab.style.display = '';
    }
  }

  function placeFab() {
    if (!fab) return;
    const fx = typeof cfg.fabX === 'number' ? cfg.fabX : 1;
    const fy = typeof cfg.fabY === 'number' ? cfg.fabY : 0.7;
    fab.style.left = clamp(fx * (window.innerWidth - 46), 6, window.innerWidth - 52) + 'px';
    fab.style.top = clamp(fy * (window.innerHeight - 46), 6, window.innerHeight - 52) + 'px';
  }

  let toastTimer = null;
  function toast(msg, ms) {
    ensureHost();
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms || 2600);
  }

  // ---------- 菜单 ----------
  function openMenu() {
    menu.textContent = '';
    const add = (label, fn, cls) =>
      menu.appendChild(
        h(
          'div',
          {
            class: cls || '',
            onclick: () => {
              closeMenu();
              fn();
            }
          },
          label
        )
      );
    add('翻译屏幕上的图片', actTranslateVisible);
    if (APP) add('翻译整个屏幕（读不到图片时用）', actTranslateScreen);
    add(autoOn() ? '自动翻译本网站：开（点击关闭）' : '自动翻译本网站：关（点击开启）', actToggleAuto);
    if (states.size) {
      add(showAll ? '看原图（暂时隐藏译文）' : '显示译文', actToggleShow);
      add('清除本页译文', actClear);
    }
    add('设置', openSettings);
    add('在这个网站隐藏按钮', actHideHere, 'sub');
    menu.classList.add('on');
    const r = fab.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = r.left + r.width / 2 > vw / 2 ? r.left - mw - 8 : r.right + 8;
    const y = r.top + r.height / 2 > vh / 2 ? r.bottom - mh : r.top;
    menu.style.left = clamp(x, 6, vw - mw - 6) + 'px';
    menu.style.top = clamp(y, 6, vh - mh - 6) + 'px';
  }

  function closeMenu() {
    if (menu) menu.classList.remove('on');
  }

  function needConfig() {
    if (isConfigured()) return false;
    if (APP && !String(cfg.apiKey || '').trim()) {
      toast('先填好 AI 的接口地址和 Key');
      APP.openKeySettings();
      return true;
    }
    toast('先在设置里填好 AI 的 Key 和模型');
    openSettings();
    return true;
  }

  function actTranslateVisible() {
    if (needConfig()) return;
    autoScr.budget = 3;
    const r = translateVisible();
    if (r.screen) {
      translateScreen(false);
      toast('这个页面的图片读不到内容，截屏翻译整个屏幕。翻译完成前请不要翻页或滚动', 4200);
    } else if (r.started) {
      dropScreen(false);
      pageScreen = false;
      if (APP && screenSite()) {
        // 你想按图片翻译：这个网站不再固定用整屏方式
        mutateCfg((c) => {
          c.screenHosts = c.screenHosts.filter((x) => x !== HOST);
        });
      }
      toast('开始翻译 ' + r.started + ' 张图片');
    } else if (r.already) toast('屏幕上的图片已经翻译过了');
    else if (APP) {
      translateScreen(false);
      rememberScreenSite();
      toast('没有找到单独的图片，改为截屏翻译整个屏幕。翻译完成前请不要翻页或滚动', 4200);
    } else toast('屏幕上没有找到可以翻译的图片');
  }

  function actTranslateScreen() {
    if (needConfig()) return;
    autoScr.budget = 3;
    const first = autoOn() && !screenSite();
    translateScreen(false);
    rememberScreenSite();
    if (first) toast('正在截屏翻译整个屏幕。这个网站的自动翻译也改成整屏方式了：翻页后会自动翻译新的一页', 5200);
    else toast('正在截屏翻译整个屏幕。翻译完成前请不要翻页或滚动', 3600);
  }

  // 自动翻译开着时，记住这个网站要用整屏方式（下一话、下一次打开也一样）
  function rememberScreenSite() {
    if (!autoOn() || screenSite()) return;
    mutateCfg((c) => {
      if (!c.screenHosts.includes(HOST)) c.screenHosts.push(HOST);
    });
  }

  // 把当前屏幕当成一张图来翻译（只在 App 里可用）
  function translateScreen(auto) {
    for (const st of Array.from(states.values())) if (st.el !== SCREEN) destroy(st); // 和按图片翻译的译文不同时显示，免得叠在一起
    sheetKey = null;
    const cur = states.get(SCREEN);
    if (cur && cur.status === 'loading') return;
    SCREEN.rect = screenRect();
    translateEl(SCREEN, true, auto);
  }

  // 整屏翻译的译文是按屏幕位置盖上去的：网页一动（翻页、滚动）就对不上了，所以要撤掉
  function dropScreen(byUser) {
    const st = states.get(SCREEN);
    if (!st || st.status === 'error') return;
    const wasLoading = st.status === 'loading';
    const wasAuto = st.auto || screenWanted();
    destroy(st);
    sheetKey = null;
    if (wasLoading && byUser && !wasAuto) toast('网页动了，这次整屏翻译已取消。等页面停稳后再点一次', 3600);
    housekeeping();
  }

  async function actToggleAuto() {
    const on = !autoOn();
    if (on && needConfig()) return;
    await mutateCfg((c) => {
      const s = c.autoHosts.filter((x) => x !== HOST);
      if (on) s.push(HOST);
      c.autoHosts = s;
    });
    housekeeping();
    if (on) {
      autoScan();
      userMoved(300);
    }
    if (!on) toast('已关闭自动翻译');
    else if (APP && (screenSite() || pageScreen || visibleNeedShot())) toast('已开启（整屏方式）：翻页或滚动停下后，会自动截屏翻译当前屏幕', 4200);
    else toast('已开启：这个网站的图片滚动到附近时会自动翻译', 3200);
  }

  function actToggleShow() {
    showAll = !showAll;
    for (const st of states.values()) layout(st);
    sheetKey = null;
    updateSheet(true);
  }

  function clearAll() {
    for (const st of Array.from(states.values())) destroy(st);
    sheetKey = null;
    updateSheet(true);
  }

  function actClear() {
    clearAll();
    // 自动翻译开着的话，清除后会马上重新翻译，所以一并关掉
    if (autoOn()) {
      mutateCfg((c) => {
        c.autoHosts = c.autoHosts.filter((x) => x !== HOST);
      }).then(housekeeping);
      toast('已清除译文，并关闭了这个网站的自动翻译', 3200);
    } else toast('已清除译文');
  }

  async function actHideHere() {
    clearAll();
    fab.style.display = 'none';
    toast('已在这个网站隐藏按钮。想恢复：在其他网站打开设置，从「不显示按钮的网站」里删掉它', 5200);
    await mutateCfg((c) => {
      if (!c.hiddenHosts.includes(HOST)) c.hiddenHosts.push(HOST);
      c.autoHosts = c.autoHosts.filter((x) => x !== HOST);
    });
    setTimeout(applyVisibility, 5200);
  }

  // ---------- 每张图片的状态和译文显示 ----------
  const states = new Map();
  let stateSeq = 0;
  let showAll = true;
  let looping = false;

  function isCandidate(el) {
    if (!el || (el.tagName !== 'IMG' && el.tagName !== 'CANVAS')) return false;
    if (el.tagName === 'IMG' && (!el.complete || el.naturalWidth < 64 || el.naturalHeight < 64)) return false;
    const r = el.getBoundingClientRect();
    const min = Math.max(60, Number(cfg.minSize) || 150);
    return r.width >= min && r.height >= min;
  }

  // 图片内容实际显示的区域（考虑 object-fit: contain 留白的情况）
  function contentRect(st) {
    const el = st.el;
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let width = r.width;
    let height = r.height;
    if (el.tagName === 'IMG' && el.naturalWidth && el.naturalHeight && width > 0 && height > 0) {
      const now = Date.now();
      if (now - st.fitAt > 1000) {
        st.fitAt = now;
        try {
          st.fit = getComputedStyle(el).objectFit;
        } catch (e) {
          st.fit = '';
        }
      }
      if (st.fit === 'contain') {
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

  function createState(el) {
    ensureHost();
    const wrap = h('div');
    const layer = h('div', { class: 'layer' }, wrap);
    root.insertBefore(layer, sheet);
    const st = { id: ++stateSeq, el, src: srcOf(el), status: 'loading', items: [], layer, wrap, badge: null, w: -1, h: -1, rect: null, fit: '', fitAt: 0, off: false, dirty: false, dead: false };
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
    const b = h('div', { class: 'badge' + (kind === 'error' ? ' error' : '') }, text + (kind === 'error' ? '（点这里重试）' : ''));
    if (kind === 'error') onTap(b, () => (st.el === SCREEN ? translateScreen() : translateEl(st.el, true)));
    st.layer.appendChild(b);
    st.badge = b;
  }

  function updateState(st) {
    const el = st.el;
    if (!el.isConnected || (st.src !== null && srcOf(el) !== st.src)) {
      destroy(st); // 图片被网页换掉或移除了
      return;
    }
    const r = contentRect(st);
    st.rect = r;
    if (r.width < 2 || r.height < 2 || r.top + r.height < 0 || r.top > window.innerHeight) {
      if (!st.off) {
        st.off = true;
        st.layer.style.display = 'none'; // 图片不在屏幕上，译文一起隐藏
      }
      return;
    }
    if (st.off) {
      st.off = false;
      st.layer.style.display = '';
    }
    st.layer.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
    if (Math.abs(r.width - st.w) > 0.5 || Math.abs(r.height - st.h) > 0.5) {
      st.w = r.width;
      st.h = r.height;
      st.layer.style.width = r.width + 'px';
      st.layer.style.height = r.height + 'px';
      st.dirty = true;
    }
    if (st.dirty) layout(st);
    if (st.badge) {
      st.badge.style.left = Math.max(0, -r.left) + 8 + 'px';
      st.badge.style.top = Math.max(0, -r.top) + 8 + 'px';
    }
  }

  // 把译文画到图片上。图片不在屏幕上时先记下来，等它出现再排版（否则量不出文字大小）
  function layout(st) {
    if (st.off || st.w <= 0) {
      st.dirty = true;
      st.wrap.textContent = '';
      return;
    }
    st.dirty = false;
    st.wrap.textContent = '';
    if (st.status !== 'done' || !showAll) return;
    const W = st.w;
    const H = st.h;
    if (cfg.displayMode === 'list') {
      st.items.forEach((it, i) => {
        if (!it.hasBox) return;
        const n = h('div', { class: 'num' }, String(i + 1));
        n.style.left = clamp(it.x * W, 12, W - 12) + 'px';
        n.style.top = clamp(it.y * H, 12, H - 12) + 'px';
        st.wrap.appendChild(n);
      });
      return;
    }
    const maxFont = Math.max(11, Math.min(40, W / 16));
    for (const it of st.items) {
      if (!it.hasBox) continue;
      const span = h('span', null, it.text);
      const box = h('div', { class: 'box' + (it.dark ? ' dark' : '') }, span);
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

  // 「编号 + 列表」模式：屏幕底部显示当前这张图里、正在屏幕上的那几句译文
  let sheetKey = ''; // 当前底部列表显示的内容；null 表示需要强制刷新
  let sheetMin = false;
  let sheetAt = 0;
  function updateSheet(force) {
    if (!sheet) return;
    const now = Date.now();
    if (!force && now - sheetAt < 200) return;
    sheetAt = now;
    let best = null;
    if (cfg.displayMode === 'list' && showAll) {
      const vh = window.innerHeight;
      const mid = vh / 2;
      let bestScore = 0;
      for (const st of states.values()) {
        if (st.status !== 'done' || !st.items.length || !st.rect) continue;
        const r = st.rect;
        const ov = Math.min(r.top + r.height, vh) - Math.max(r.top, 0);
        if (ov <= 0) continue;
        const score = r.top <= mid && r.top + r.height >= mid ? 1e9 : ov;
        if (score > bestScore) {
          bestScore = score;
          best = st;
        }
      }
    }
    const idx = [];
    if (best) {
      const r = best.rect;
      const vh = window.innerHeight;
      best.items.forEach((it, i) => {
        if (!it.hasBox) {
          idx.push(i);
          return;
        }
        const y0 = r.top + it.y * r.height;
        const y1 = y0 + it.h * r.height;
        if (y1 > 0 && y0 < vh) idx.push(i);
      });
    }
    const key = best && idx.length ? best.id + ':' + idx.join(',') + ':' + sheetMin : '';
    if (key === sheetKey) return;
    sheetKey = key;
    if (!key) {
      sheet.classList.remove('on');
      return;
    }
    sheetHd.textContent = '';
    sheetHd.append(h('span', null, '译文（' + idx.length + ' 句）'), h('span', null, sheetMin ? '展开 ▲' : '收起 ▼'));
    sheetBd.textContent = '';
    for (const i of idx) sheetBd.appendChild(h('div', { class: 'row' }, h('b', null, String(i + 1)), best.items[i].text));
    sheet.classList.toggle('min', sheetMin);
    sheet.classList.add('on');
  }

  // 动画循环：让译文跟着图片移动
  function startLoop() {
    if (looping) return;
    looping = true;
    requestAnimationFrame(tick);
  }
  function tick() {
    if (!states.size) {
      looping = false;
      updateSheet(true);
      return;
    }
    for (const st of Array.from(states.values())) updateState(st);
    updateSheet(false);
    requestAnimationFrame(tick);
  }

  // 画布内容的"指纹"。翻页式阅读器常常一直用同一块画布，翻页只是把它重画一遍；
  // 发现画布内容变了，就把旧译文撤掉（开着自动翻译的话会重新翻译新的一页）
  function canvasSig(el) {
    try {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(el, 0, 0, 16, 16);
      return g.getImageData(0, 0, 16, 16).data;
    } catch (e) {
      return null; // 读不到内容的画布
    }
  }
  function canvasChanged(st) {
    if (!st.csig) return false;
    const now = canvasSig(st.el);
    if (!now) return false;
    let big = 0;
    let sum = 0;
    for (let i = 0; i < now.length; i += 4) {
      const d = Math.abs(now[i] - st.csig[i]) + Math.abs(now[i + 1] - st.csig[i + 1]) + Math.abs(now[i + 2] - st.csig[i + 2]);
      sum += d;
      if (d > 90) big++;
    }
    return big > 3 || sum / (now.length / 4) > 12;
  }

  // 没有人碰网页时，自动翻译最多再翻这么多张图。防止网页自己不停地换图，导致一直重复翻译、白白消耗额度
  const AUTO_BUDGET = 12;
  let autoBudget = AUTO_BUDGET;

  // ---------- 翻译一张图 ----------
  async function translateEl(el, force, auto) {
    let st = states.get(el);
    if (st && st.status === 'loading') return;
    if (st && st.status === 'done' && !force) return;
    if (st) destroy(st);
    st = createState(el);
    st.auto = !!auto;
    setBadge(st, '排队中…');
    try {
      await jobLimit(async () => {
        if (st.dead) return;
        setBadge(st, '翻译中…');
        const pic = await grabImage(el);
        if (el === SCREEN) st.sig = pic.sig || null;
        else if (el.tagName === 'CANVAS') st.csig = canvasSig(el);
        let items;
        try {
          if (st.dead) return;
          items = await runTiles(pic);
        } finally {
          try {
            pic.close();
          } catch (e) {}
        }
        if (st.dead) return;
        if (canvasChanged(st)) {
          destroy(st); // 翻译途中画布已经换成了别的内容（翻页了）：这次结果作废
          return;
        }
        st.items = items;
        st.status = 'done';
        if (el === SCREEN && st.sig) cachePut(st.sig, items);
        if (!items.length) {
          setBadge(st, '没有发现需要翻译的文字');
          setTimeout(() => {
            if (!st.dead) setBadge(st, '');
          }, 3000);
        } else setBadge(st, '');
        layout(st);
        sheetKey = null;
        if (el === SCREEN && !items.length) kickScreen(2000); // 也可能是图片还没加载出来：过一会儿看看画面变了没有
      });
    } catch (e) {
      if (st.dead) return;
      if (e && e.code === 'NEEDSHOT') {
        // 这张图读不到内容（受网站保护）。在 App 里改用截屏翻译整个屏幕
        destroy(st);
        needShot.add(el);
        const big = isCandidate(el) && bigOnScreen(el.getBoundingClientRect());
        if (big) pageScreen = true;
        // 手动翻译时：读不到的是屏幕上的主要图片，或者别的图也都没翻成，就整屏翻译；只是角落里露出一点的图读不到，就不管它
        if (!st.auto && (big || !states.size)) {
          translateScreen(false);
          toast('这个页面的图片读不到内容，改为截屏翻译整个屏幕。翻译完成前请不要翻页或滚动', 4200);
        }
        housekeeping();
        return;
      }
      st.status = 'error';
      setBadge(st, '翻译失败：' + ((e && e.message) || e), 'error');
    }
    housekeeping(); // 马上更新按钮上的"进行中"数字
  }

  // 这块区域在屏幕上占的面积够不够大（只露出一条边的不算）
  function bigOnScreen(r) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const hh = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    return w > 0 && hh > 0 && w * hh >= vw * vh * 0.12;
  }

  // 屏幕上有没有"读不到内容"的大图
  function visibleNeedShot() {
    for (const el of document.querySelectorAll('img, canvas')) {
      if (needShot.has(el) && isCandidate(el) && bigOnScreen(el.getBoundingClientRect())) return true;
    }
    return false;
  }

  function translateVisible() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const todo = [];
    let already = 0;
    for (const el of document.querySelectorAll('img, canvas')) {
      if (!isCandidate(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      if (needShot.has(el)) {
        if (bigOnScreen(r)) return { screen: true }; // 屏幕上的主要图片读不到：直接整屏翻译
        continue;
      }
      const st = states.get(el);
      if (st && st.status !== 'error') {
        already++;
        continue;
      }
      todo.push(el);
    }
    for (const el of todo) translateEl(el, true);
    return { started: todo.length, already };
  }

  // 自动翻译（按图片）：只处理屏幕附近、够大的图，避免把广告和小图也翻了
  function autoScan() {
    if (document.hidden || !isConfigured()) return;
    if (states.has(SCREEN) || screenWanted()) return; // 整屏方式由下面另一套逻辑负责，这里不再按图片翻译
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const minW = Math.min(300, vw * 0.6);
    for (const el of document.querySelectorAll('img, canvas')) {
      if (states.has(el) || needShot.has(el) || !isCandidate(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < minW || r.height < 200) continue;
      if (r.bottom < -vh * 0.5 || r.top > vh * 2 || r.right < 0 || r.left > vw) continue;
      if (autoBudget <= 0) return;
      autoBudget--;
      translateEl(el, false, true);
    }
  }

  // ---------- 自动翻译（整屏方式，只在 App 里） ----------
  // 什么时候用：这个网站被记成了整屏方式，或者这个页面上的主要图片读不到内容。
  // 做法：你碰过网页（翻页、滚动）之后，等画面停稳 → 截屏 → 翻译 → 盖上译文。译文显示着的时候什么都不做，所以不会闪。
  let pageScreen = false; // 这个页面上发现过读不到内容的大图
  const screenCache = []; // 最近翻译过的几屏 { sig, items }：回到看过的画面时直接用，不再问 AI
  const autoScr = { timer: null, running: false, stopped: false, prev: null, unstable: 0, idle: 0, fail: 0, budget: 3 };
  const screenSite = () => cfg.screenHosts.includes(HOST);
  const screenWanted = () => !!APP && autoOn() && isConfigured() && (screenSite() || pageScreen || visibleNeedShot());

  function cachePut(sig, items) {
    screenCache.unshift({ sig, items });
    if (screenCache.length > 8) screenCache.length = 8;
  }

  function kickScreen(ms) {
    if (!APP) return;
    clearTimeout(autoScr.timer);
    autoScr.timer = setTimeout(stepScreen, ms);
  }

  // 用户刚碰过网页：之后可以再自动翻译几次
  function userMoved(ms) {
    if (!APP) return;
    autoScr.budget = 3;
    autoScr.idle = 0;
    autoScr.fail = 0;
    autoScr.stopped = false;
    kickScreen(ms);
  }

  async function stepScreen() {
    autoScr.timer = null;
    if (!host || !screenWanted() || document.hidden) return;
    if (autoScr.running || menu.classList.contains('on') || (mask && mask.classList.contains('on'))) {
      kickScreen(700); // 正忙，或者菜单 / 设置开着：等一下再看
      return;
    }
    const busy = (st) => st && (st.status !== 'done' || st.items.length > 0);
    if (busy(states.get(SCREEN))) return; // 正在翻译 / 译文正显示着 / 出错了等你点重试

    autoScr.running = true;
    let sig = null;
    try {
      sig = await quickSig();
    } catch (e) {}
    autoScr.running = false;
    if (autoScr.timer) return; // 截屏期间你又动了网页：交给新的那一次处理
    if (!sig) {
      if (++autoScr.fail <= 5) kickScreen(2000);
      else autoScr.stopped = true; // 截屏一直失败：先停下，等你下次碰网页再试
      return;
    }
    autoScr.fail = 0;
    if (!autoScr.prev || !sameSig(sig, autoScr.prev)) {
      autoScr.prev = sig;
      if (++autoScr.unstable <= 10) {
        kickScreen(450); // 画面还在变（翻页动画、图片还在加载）：等它停稳
        return;
      }
    }
    autoScr.unstable = 0;

    const cur = states.get(SCREEN);
    if (busy(cur)) return;
    if (cur && cur.sig && sameSig(sig, cur.sig)) {
      // 这一屏刚翻过，没有文字。隔一会儿再看看画面变了没有，看够次数就停
      if (++autoScr.idle <= 12) kickScreen(2000);
      return;
    }
    const hit = screenCache.find((c) => sameSig(sig, c.sig));
    if (hit) {
      showScreen(hit); // 看过的画面：直接把上次的译文盖回去
      if (!hit.items.length && ++autoScr.idle <= 12) kickScreen(2000);
      return;
    }
    if (autoScr.budget <= 0) {
      autoScr.stopped = true; // 你没动过网页、画面却一直在变（动画、广告）：不再继续花额度，等你下次碰网页
      return;
    }
    autoScr.budget--;
    translateScreen(true);
  }

  function showScreen(hit) {
    for (const st of Array.from(states.values())) destroy(st);
    SCREEN.rect = screenRect();
    const st = createState(SCREEN);
    st.auto = true;
    st.sig = hit.sig;
    st.items = hit.items;
    st.status = 'done';
    layout(st);
    sheetKey = null;
    housekeeping();
  }

  // 每半秒做一次的杂事：更新按钮上的数字、自动翻译扫描
  let hkCount = 0;
  function housekeeping() {
    hkCount++;
    if (isHidden() || !host) return;
    ensureHost();
    let busy = 0;
    for (const st of Array.from(states.values())) {
      if (st.status === 'loading') busy++;
      else if (st.csig && !st.off && canvasChanged(st)) destroy(st); // 画布被重画成别的内容了（翻页）
    }
    fab.classList.toggle('busy', busy > 0);
    fab.classList.toggle('auto', autoOn());
    fabCnt.textContent = busy ? String(busy) : '';
    fabCnt.style.display = busy ? 'block' : 'none';
    if (autoOn() && hkCount % 2 === 0) autoScan();
    if (APP && !autoScr.timer && !autoScr.running && !autoScr.stopped && !states.has(SCREEN) && screenWanted()) kickScreen(300);
  }

  // ---------- 设置面板 ----------
  const F = {};
  let saveTimer = null;
  let savedTimer = null;

  function openSettings() {
    ensureHost();
    closeMenu();
    if (!mask) buildSettings();
    fillForm();
    mask.classList.add('on');
  }

  async function closeSettings() {
    await saveForm();
    mask.classList.remove('on');
    F.apiKey.value = ''; // 关闭后不把 Key 留在页面的输入框里
  }

  function showResult(kind, text) {
    F.result.className = 'res ' + kind;
    F.result.textContent = text;
  }

  function updateKeyHint() {
    const p = PRESETS[F.preset.value] || PRESETS.custom;
    F.keyHint.textContent = '';
    if (p.keyUrl) F.keyHint.append('在 ', h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener' }, p.keyName), ' 申请 Key。');
    else F.keyHint.append('填写任何兼容 OpenAI 格式的接口地址和对应的 Key。');
  }

  function buildSettings() {
    const inp = (type, ph) => h('input', { type, placeholder: ph || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
    const fld = (label, control, hint) => [h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null];

    F.preset = h('select', null, Object.keys(PRESETS).map((k) => h('option', { value: k }, PRESETS[k].name)));
    F.keyHint = h('div', { class: 'hint' });
    F.baseUrl = inp('url', 'https://.../v1');
    F.apiKey = inp('password', '粘贴你的 Key');
    F.model = inp('text', '模型名称');
    F.modelSel = h('select', { style: 'display:none;margin-top:8px' });
    F.result = h('div', { class: 'res' });
    F.saved = h('span', { class: 'saved' }, '已保存');
    F.targetSel = h('select', null, TARGETS.map((t) => h('option', { value: t }, t)), h('option', { value: '__custom' }, '其他（自己填）'));
    F.targetCustom = inp('text', '例如：Español');
    F.targetCustom.style.marginTop = '8px';
    F.skipLangs = inp('text', '例如：日语');
    F.displayMode = h('select', null, h('option', { value: 'overlay' }, '直接盖在原文位置上'), h('option', { value: 'list' }, '图上标编号，译文列在屏幕底部'));
    F.extraPrompt = h('textarea', { placeholder: '例如：人名保留原文；语气口语化一点' });
    F.rpm = inp('number');
    F.minSize = inp('number');
    F.autoHosts = h('textarea', { placeholder: '每行一个网站，例如 example.com', autocapitalize: 'off', spellcheck: false });
    F.hiddenHosts = h('textarea', { placeholder: '每行一个网站', autocapitalize: 'off', spellcheck: false });

    F.keyState = h('div', { class: 'hint' });
    // 在 App 里，接口地址和 Key 由 App 自己保管（网页读不到），这里只显示状态
    const connFields = APP
      ? [h('label', null, '接口地址和 Key'), F.keyState, h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn', type: 'button', onclick: () => APP.openKeySettings() }, '在 App 里修改'))]
      : [].concat(fld('AI 服务', F.preset), [F.keyHint], fld('接口地址', F.baseUrl), fld('API Key', F.apiKey));
    const listBtn = h('button', { class: 'btn', type: 'button', onclick: listModels }, '获取列表');
    const testBtn = h('button', { class: 'btn pri', type: 'button', onclick: runTest }, '测试');
    F.testBtn = testBtn;
    F.listBtn = listBtn;

    const dlg = h(
      'div',
      { class: 'dlg' },
      h('div', { class: 'top' }, h('h1', null, '漫画翻译 · 设置'), h('div', null, F.saved, h('button', { class: 'btn pri', type: 'button', onclick: closeSettings }, '完成'))),
      h(
        'section',
        null,
        h('h2', null, '连接 AI'),
        connFields,
        h('label', null, '模型'),
        h('div', { class: 'row2' }, F.model, listBtn),
        F.modelSel,
        h('div', { class: 'hint' }, '必须是能看图的模型。'),
        h('div', { style: 'margin-top:14px' }, testBtn),
        F.result
      ),
      h(
        'section',
        null,
        h('h2', null, '翻译'),
        fld('翻译成', F.targetSel),
        F.targetCustom,
        fld('不需要翻译的语言（可留空）', F.skipLangs, '填了之后，这些语言的文字会保持原样。'),
        fld('译文显示方式', F.displayMode),
        fld('给 AI 的额外要求（可留空）', F.extraPrompt)
      ),
      h(
        'section',
        null,
        h('h2', null, '其他'),
        fld('每分钟最多发给 AI 多少次请求（0 = 不限制）', F.rpm, '免费的 Key 每分钟次数有限，数字小一点不容易报错。'),
        fld('小于这个尺寸的图片不处理（像素）', F.minSize),
        fld('开启了自动翻译的网站', F.autoHosts),
        fld('不显示按钮的网站', F.hiddenHosts)
      ),
      h('div', { class: 'hint' }, (APP ? 'Key 只保存在这个 App 里，网页读不到它。' : 'Key 只保存在这台设备的脚本管理器里。') + '每翻译一张图会调用一次 AI，消耗你这个 Key 的额度。')
    );
    mask = h('div', { class: 'mask' }, dlg);
    root.appendChild(mask);

    F.preset.addEventListener('change', () => {
      const p = PRESETS[F.preset.value];
      if (p && p.url) {
        F.baseUrl.value = p.url;
        F.model.value = p.model || ''; // 换了服务，原来的模型名就不能用了
        if (p.rpm !== undefined) F.rpm.value = String(p.rpm);
      }
      F.modelSel.style.display = 'none';
      updateKeyHint();
    });
    F.targetSel.addEventListener('change', () => {
      F.targetCustom.style.display = F.targetSel.value === '__custom' ? '' : 'none';
    });
    F.modelSel.addEventListener('change', () => {
      if (F.modelSel.value) F.model.value = F.modelSel.value;
    });
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveForm, 500);
    };
    dlg.addEventListener('input', scheduleSave);
    dlg.addEventListener('change', scheduleSave);
  }

  function fillForm() {
    F.preset.value = PRESETS[cfg.preset] ? cfg.preset : 'custom';
    F.baseUrl.value = cfg.baseUrl || '';
    F.apiKey.value = cfg.apiKey || '';
    F.model.value = cfg.model || '';
    if (TARGETS.includes(cfg.targetLang)) {
      F.targetSel.value = cfg.targetLang;
      F.targetCustom.value = '';
      F.targetCustom.style.display = 'none';
    } else {
      F.targetSel.value = '__custom';
      F.targetCustom.value = cfg.targetLang || '';
      F.targetCustom.style.display = '';
    }
    F.skipLangs.value = cfg.skipLangs || '';
    F.displayMode.value = cfg.displayMode === 'list' ? 'list' : 'overlay';
    F.extraPrompt.value = cfg.extraPrompt || '';
    F.rpm.value = String(cfg.rpm);
    F.minSize.value = String(cfg.minSize);
    F.autoHosts.value = cfg.autoHosts.join('\n');
    F.hiddenHosts.value = cfg.hiddenHosts.join('\n');
    F.result.className = 'res';
    F.keyState.textContent = String(cfg.apiKey || '').trim() ? '已设置。接口地址：' + (cfg.baseUrl || '') : '还没有设置，点下面的按钮填写。';
    updateKeyHint();
  }

  async function saveForm() {
    clearTimeout(saveTimer);
    if (!mask || !mask.classList.contains('on')) return;
    const custom = F.targetSel.value === '__custom';
    const rpm = Number(F.rpm.value);
    const v = {
      preset: F.preset.value,
      baseUrl: F.baseUrl.value.trim(),
      apiKey: F.apiKey.value.trim(),
      model: F.model.value.trim(),
      targetLang: custom ? F.targetCustom.value.trim() || '简体中文' : F.targetSel.value,
      skipLangs: F.skipLangs.value.trim(),
      displayMode: F.displayMode.value,
      extraPrompt: F.extraPrompt.value.trim(),
      rpm: isFinite(rpm) && rpm >= 0 ? Math.min(600, Math.round(rpm)) : 8,
      minSize: clamp(Number(F.minSize.value) || 150, 60, 1000),
      autoHosts: parseHostList(F.autoHosts.value),
      hiddenHosts: parseHostList(F.hiddenHosts.value)
    };
    await mutateCfg((c) => Object.assign(c, v));
    F.saved.classList.add('on');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => F.saved.classList.remove('on'), 1200);
    for (const st of states.values()) layout(st);
    sheetKey = null;
    updateSheet(true);
    housekeeping();
  }

  async function listModels() {
    await saveForm();
    F.listBtn.disabled = true;
    showResult('info', '正在获取模型列表…');
    try {
      if (!String(cfg.apiKey || '').trim() && !isLocal()) throw new Error('请先填写 API Key。');
      let res;
      try {
        res = await httpText('GET', endpoint('/models'), authHeaders(), null, 20000);
      } catch (e) {
        throw new Error('连不上 AI 接口，请检查网络和接口地址。');
      }
      if (res.status < 200 || res.status >= 300) throw new Error(describeHttpError(res.status, res.text));
      const j = JSON.parse(res.text);
      const list = (j.data || j.models || [])
        .map((m) => String((m && (m.id || m.name)) || '').replace(/^models\//, ''))
        .filter(Boolean)
        .sort();
      if (!list.length) throw new Error('接口没有返回任何模型，请手动填写模型名。');
      F.modelSel.textContent = '';
      F.modelSel.append(h('option', { value: '' }, '请选择模型（共 ' + list.length + ' 个）'));
      for (const m of list) F.modelSel.append(h('option', { value: m }, m));
      F.modelSel.style.display = '';
      if (list.includes(F.model.value)) F.modelSel.value = F.model.value;
      showResult('ok', 'Key 有效，找到 ' + list.length + ' 个模型。在上面的下拉框里选一个能看图的，然后点「测试」。');
    } catch (e) {
      showResult('err', '获取失败：' + ((e && e.message) || e));
    }
    F.listBtn.disabled = false;
  }

  // 画一张带文字的小图，用来完整测试「看图 → 翻译」流程
  function makeTestImage() {
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = 240;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#000';
    g.lineWidth = 4;
    g.beginPath();
    g.ellipse(240, 120, 200, 90, 0, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#000';
    g.font = 'bold 34px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('Bonjour, ça va ?', 240, 120);
    return { dataUrl: c.toDataURL('image/jpeg', 0.92), w: c.width, h: c.height };
  }

  async function runTest() {
    await saveForm();
    F.testBtn.disabled = true;
    const t0 = Date.now();
    const tickMsg = () => showResult('info', '正在发送一张测试图片给 AI，已等待 ' + Math.round((Date.now() - t0) / 1000) + ' 秒…（最多等 60 秒）');
    tickMsg();
    const ticker = setInterval(tickMsg, 1000);
    try {
      const t = makeTestImage();
      const items = await translateDataUrl(t.dataUrl, t.w, t.h, 60000);
      clearInterval(ticker);
      if (!items.length) showResult('err', 'AI 有回复，但没有认出测试图里的文字。这个模型可能不擅长看图，建议换一个。');
      else {
        const it = items[0];
        showResult(
          'ok',
          '成功！AI 读到了「' + (it.src || '（未返回原文）') + '」，翻译为「' + it.text + '」。\n' +
            (it.hasBox ? '位置信息也正常。' : '注意：这个模型没有返回文字位置，建议把显示方式改成「图上标编号」。') +
            '\n点右上角「完成」，然后点悬浮的「译」按钮开始用。'
        );
      }
    } catch (e) {
      clearInterval(ticker);
      showResult('err', '测试失败：' + ((e && e.message) || e));
    }
    F.testBtn.disabled = false;
  }

  // ---------- 启动 ----------
  (async function init() {
    await loadCfg();
    if (APP) {
      // App 里改了接口地址或 Key 之后，会通知这里重新读取设置
      APP.onNativeEvent = async (what) => {
        if (what !== 'cfg') return;
        await loadCfg();
        if (mask && mask.classList.contains('on')) fillForm();
        housekeeping();
      };
    }
    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('漫画翻译：设置', () => {
          ensureHost();
          host.style.removeProperty('display');
          if (isHidden()) fab.style.display = 'none';
          openSettings();
        });
        GM_registerMenuCommand('漫画翻译：在本网站显示 / 隐藏按钮', async () => {
          const hide = !isHidden();
          await mutateCfg((c) => {
            c.hiddenHosts = c.hiddenHosts.filter((x) => x !== HOST);
            if (hide) c.hiddenHosts.push(HOST);
          });
          if (hide) clearAll();
          ensureHost();
          applyVisibility();
        });
      }
    } catch (e) {}
    setInterval(housekeeping, 500);
    if (isHidden()) return;
    ensureHost();
    housekeeping();
  })();
})();
