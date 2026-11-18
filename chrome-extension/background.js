// 后台脚本：负责调用 AI 接口、跨域抓取图片、截图
importScripts('defaults.js');

const getCfg = () => chrome.storage.local.get(MGTL_DEFAULTS);

// ---------- 安装 / 右键菜单 ----------
chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'mgtl-translate',
      title: '翻译这张图片',
      contexts: ['image']
    });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'mgtl-translate' || !tab || tab.id == null) return;
  chrome.tabs
    .sendMessage(
      tab.id,
      { type: 'mgtl-translate-clicked', srcUrl: info.srcUrl },
      { frameId: info.frameId || 0 }
    )
    .catch(() => {});
});

// ---------- 工具函数 ----------
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function endpoint(cfg, path) {
  let base = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('还没有填写接口地址，请打开插件设置。');
  base = base.replace(/\/chat\/completions$/, '');
  return base + path;
}

function authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  const key = (cfg.apiKey || '').trim();
  if (key) h.Authorization = 'Bearer ' + key;
  // Claude 的接口要求从浏览器直接调用时带上这个请求头，否则会返回 401
  if (/anthropic\.com/i.test(cfg.baseUrl || '')) {
    h['anthropic-dangerous-direct-browser-access'] = 'true';
    h['anthropic-version'] = '2023-06-01';
    if (key) h['x-api-key'] = key;
  }
  return h;
}

function checkConfigured(cfg, needModel) {
  const isLocal = /localhost|127\.0\.0\.1/.test(cfg.baseUrl || '');
  if (!(cfg.apiKey || '').trim() && !isLocal) {
    throw new Error('还没有填写 API Key，请点插件图标 → 设置。');
  }
  if (needModel && !(cfg.model || '').trim()) {
    throw new Error('还没有选择模型，请点插件图标 → 设置。');
  }
}

async function httpError(r) {
  let detail = '';
  try {
    const t = await r.text();
    try {
      let j = JSON.parse(t);
      if (Array.isArray(j)) j = j[0];
      detail = (j && j.error && (j.error.message || j.error)) || t;
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch (e) {
      detail = t;
    }
  } catch (e) {}
  detail = String(detail || '').slice(0, 240);
  let hint = '请求失败';
  if (r.status === 401 || r.status === 403) hint = 'API Key 无效或没有权限';
  else if (r.status === 402) hint = '账户余额不足，请先到这家 AI 服务的网站充值';
  else if (r.status === 404) hint = '接口地址或模型名称不对';
  else if (r.status === 429) hint = '请求太频繁，已自动重试多次仍失败。请等一分钟再点「重译」，或在设置里调低「每分钟最多请求数」';
  else if (r.status === 400) hint = '请求被拒绝（可能是该模型不支持图片输入）';
  else if (r.status >= 500) hint = 'AI 服务端出错，请稍后再试';
  return new Error(`${hint}（${r.status}）${detail ? '：' + detail : ''}`);
}

function contentToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && (p.text || '')) || '').join('');
  return '';
}

// 读取回复（兼容流式和非流式）
async function readCompletion(r) {
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    let j = await r.json();
    if (Array.isArray(j)) j = j[0];
    if (j && j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return contentToText(j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(p);
      } catch (e) {
        continue;
      }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      const d = j.choices && j.choices[0] && j.choices[0].delta;
      if (d) out += contentToText(d.content);
    }
  }
  return out;
}

// ---------- 提示词 ----------
function buildPrompt(cfg) {
  const target = (cfg.targetLang || '简体中文').trim();
  const skip = (cfg.skipLangs || '').trim();
  const extra = (cfg.extraPrompt || '').trim();
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

// ---------- 解析 AI 返回 ----------
function parseItems(text, width, height) {
  let t = String(text || '').trim();
  // 有些模型（如 Gemma）会先输出一段思考过程，去掉它，只保留后面的正式结果
  t = t.replace(/<(thought|think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
  const open = t.search(/<(thought|think|thinking|reasoning)>/i);
  if (open >= 0) {
    // 思考段没有结束标记：只看最后一个 JSON 数组
    t = t.slice(open);
  }
  t = t.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let data;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch (e) {
      return undefined;
    }
  };
  data = tryParse(t);
  if (data === undefined) {
    // 找出所有可能是结果数组开头的位置，从最后一个往前试（正式结果总在最后）
    const starts = [];
    const re = /\[\s*(\{|\])/g;
    let m;
    while ((m = re.exec(t))) starts.push(m.index);
    const b = t.lastIndexOf(']');
    for (let i = starts.length - 1; i >= 0 && data === undefined; i--) {
      const a = starts[i];
      if (b > a) data = tryParse(t.slice(a, b + 1));
    }
    if (data === undefined && starts.length) {
      // 输出被截断时：保留到最后一个完整的 }
      const a = starts[starts.length - 1];
      const c = t.lastIndexOf('}');
      if (c > a) data = tryParse(t.slice(a, c + 1) + ']');
      if (data === undefined && starts.length > 1) {
        const a0 = starts[0];
        if (c > a0) data = tryParse(t.slice(a0, c + 1) + ']');
      }
    }
  }
  if (data && !Array.isArray(data) && typeof data === 'object') {
    data = data.items || data.result || data.translations || Object.values(data).find(Array.isArray);
  }
  if (!Array.isArray(data)) {
    throw new Error('AI 返回的内容无法解析，可以重试或换一个模型。返回开头：' + t.slice(0, 80));
  }
  const clamp = (v) => Math.min(1000, Math.max(0, v));
  const items = [];
  for (const it of data) {
    if (!it || typeof it !== 'object') continue;
    const tr = String(it.text || it.translation || it.dst || '').trim();
    if (!tr) continue;
    const item = { text: tr, src: String(it.src || it.original || '').trim(), dark: !!it.dark, hasBox: false, x: 0, y: 0, w: 0, h: 0 };
    let b = it.box || it.box_2d || it.bbox;
    if (Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && isFinite(n))) {
      let [y0, x0, y1, x1] = b;
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
      y0 = clamp(y0);
      x0 = clamp(x0);
      y1 = clamp(y1);
      x1 = clamp(x1);
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

// ---------- 限速：把请求均匀排开，避免撞到免费额度的每分钟上限 ----------
let nextSlot = 0;
async function waitForSlot(cfg, signal) {
  const rpm = Number(cfg.rpm) || 0;
  if (rpm <= 0) return;
  const gap = 60000 / rpm;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await new Promise((res) => setTimeout(res, at - now));
  if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
}

// ---------- 调用 AI 翻译一张图 ----------
async function translateImage(msg, signal) {
  const cfg = await getCfg();
  checkConfigured(cfg, true);
  const body = {
    model: cfg.model.trim(),
    stream: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(cfg) },
          { type: 'image_url', image_url: { url: msg.dataUrl } }
        ]
      }
    ]
  };
  // Gemini 的新模型默认会先"思考"很久；翻译漫画不需要，调低可以明显加快
  const isGemini = /googleapis\.com/i.test(cfg.baseUrl || '');
  if (isGemini) body.reasoning_effort = 'low';
  // DeepSeek 默认开着"思考模式"，翻译漫画用不着，关掉更快也更省钱
  const isDeepSeek = /deepseek\.com/i.test(cfg.baseUrl || '');
  if (isDeepSeek) body.thinking = { type: 'disabled' };
  await waitForSlot(cfg, signal);
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, msg.timeoutMs || 120000);
  if (signal) signal.addEventListener('abort', () => ac.abort());
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  try {
    let r;
    for (let attempt = 0; ; attempt++) {
      r = await fetch(endpoint(cfg, '/chat/completions'), {
        method: 'POST',
        headers: authHeaders(cfg),
        body: JSON.stringify(body),
        signal: ac.signal
      });
      // 个别模型不接受上面这两个"加速"参数：去掉后重试一次
      if ((r.status === 400 || r.status === 422) && (body.reasoning_effort || body.thinking)) {
        delete body.reasoning_effort;
        delete body.thinking;
        continue;
      }
      // 请求太频繁（429）或服务端繁忙（5xx）时自动等一会儿再试，免费额度常见
      if (r.status === 429) {
        // 如果是"每天"的额度用完了，重试没有意义，直接告诉用户
        let t = '';
        try {
          t = await r.clone().text();
        } catch (e) {}
        if (/per\s*day|perday|daily/i.test(t)) {
          throw new Error('今天的免费额度已经用完了（每天下午四五点左右重置）。可以换一个模型继续用，或换成付费的 Key。');
        }
      }
      const busy = r.status === 429 || r.status === 500 || r.status === 502 || r.status === 503 || r.status === 504;
      if (busy && attempt < 3) {
        await sleep((r.status === 429 ? 7000 : 4000) * (attempt + 1));
        if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
        continue;
      }
      break;
    }
    if (!r.ok) {
      const err = await httpError(r);
      // DeepSeek 目前只有 deepseek-flash 能看图，填了别的模型就会在这里被拒绝
      if (isDeepSeek && (r.status === 400 || r.status === 422) && !/flash/i.test(body.model)) {
        err.message = '提示：DeepSeek 目前只有 deepseek-flash 这个模型能看图，请到设置里把模型改成它。\n' + err.message;
      }
      throw err;
    }
    const text = await readCompletion(r);
    return parseItems(text, msg.width, msg.height);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(timedOut ? '等了很久 AI 都没有回复。多半是这个模型现在太忙，请稍后再试，或换一个模型。' : '已取消');
    }
    if (e instanceof TypeError) throw new Error('连不上 AI 接口，请检查网络和接口地址。');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 翻译请求走长连接：内容脚本会定时发 ping，防止后台被浏览器休眠
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mgtl-translate') return;
  const ac = new AbortController();
  port.onDisconnect.addListener(() => ac.abort());
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'start') return;
    try {
      const items = await translateImage(msg, ac.signal);
      port.postMessage({ type: 'result', ok: true, items });
    } catch (e) {
      try {
        port.postMessage({ type: 'result', ok: false, error: String((e && e.message) || e) });
      } catch (e2) {}
    }
  });
});

// ---------- 普通消息 ----------
let lastCapture = 0;

const handlers = {
  // 跨域抓取图片（页面里直接读不到时使用）
  async 'mgtl-fetch-image'(msg) {
    const r = await fetch(msg.url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 30 * 1024 * 1024) throw new Error('图片太大');
    const type = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return { dataUrl: `data:${type};base64,${bufToBase64(buf)}` };
  },

  // 截取当前可见页面（最后的兜底办法）
  async 'mgtl-capture'(msg, sender) {
    const wait = 600 - (Date.now() - lastCapture);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCapture = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    return { dataUrl };
  },

  // 设置页：获取模型列表
  async 'mgtl-list-models'() {
    const cfg = await getCfg();
    checkConfigured(cfg, false);
    let r;
    try {
      r = await fetch(endpoint(cfg, '/models'), { headers: authHeaders(cfg) });
    } catch (e) {
      throw new Error('连不上 AI 接口，请检查网络和接口地址。');
    }
    if (!r.ok) throw await httpError(r);
    const j = await r.json();
    const list = (j.data || j.models || [])
      .map((m) => String((m && (m.id || m.name)) || '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort();
    return { models: list };
  },

  // 设置页：用一张测试图走完整流程
  async 'mgtl-test'(msg) {
    const items = await translateImage(msg);
    return { items };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return;
  h(msg, sender).then(
    (r) => sendResponse(Object.assign({ ok: true }, r)),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
  );
  return true;
});
