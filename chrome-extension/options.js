const $ = (id) => document.getElementById(id);

// model / rpm：切换到这家服务时自动填好的模型和每分钟请求数（没写就不动）
const PRESETS = {
  gemini: {
    name: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    rpm: 8,
    hint: '在 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> 申请 Key。'
  },
  deepseek: {
    name: 'DeepSeek',
    url: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    rpm: 0,
    hint:
      '在 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">DeepSeek 开放平台</a> 申请 Key（没有免费额度，需要先充值，但价格很便宜）。' +
      '模型已经自动填好，请保持 deepseek-flash 不要改：DeepSeek 目前只有它能看图。'
  },
  openai: {
    name: 'OpenAI',
    url: 'https://api.openai.com/v1',
    hint: '在 <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">OpenAI 平台</a> 申请 Key（需要先充值）。'
  },
  claude: {
    name: 'Claude',
    url: 'https://api.anthropic.com/v1',
    hint: '在 <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Claude Console</a> 申请 Key（需要先充值，和 claude.ai 的聊天订阅是分开的）。'
  },
  openrouter: {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1',
    hint: '在 <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">OpenRouter</a> 申请 Key。'
  },
  custom: {
    name: '自定义接口',
    url: '',
    hint: '填写任何兼容 OpenAI 格式的接口地址。本地 Ollama 一般是 http://localhost:11434/v1 ，可以不填 Key。'
  }
};

const TARGETS = ['简体中文', '繁體中文', '日本語', 'English', '한국어'];
let saveTimer = null;
let savedTimer = null;
// 每家 AI 服务各记一份「接口地址 / Key / 模型 / 每分钟请求数」，
// 这样在几家之间来回切换时不用重新粘贴 Key，也不会把这一家的 Key 发给另一家
let profiles = {};
let curPreset = 'gemini';

const clampRpm = (v) => Math.min(600, Math.max(0, Math.round(Number(v) || 0)));

function hostOf(u) {
  try {
    return new URL(String(u || '').trim()).host.toLowerCase();
  } catch (e) {
    return '';
  }
}

function snapshotProfile() {
  return {
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    rpm: clampRpm($('rpm').value)
  };
}

function collect() {
  const custom = $('targetSel').value === '__custom';
  return {
    preset: $('preset').value,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    targetLang: custom ? $('targetCustom').value.trim() || '简体中文' : $('targetSel').value,
    skipLangs: $('skipLangs').value.trim(),
    displayMode: $('displayMode').value,
    extraPrompt: $('extraPrompt').value.trim(),
    hoverButton: $('hoverButton').checked,
    autoAfterClick: $('autoAfterClick').checked,
    rpm: clampRpm($('rpm').value),
    minSize: Math.min(1000, Math.max(60, Number($('minSize').value) || 180)),
    profiles
  };
}

async function saveNow() {
  clearTimeout(saveTimer);
  await chrome.storage.local.set(collect());
  $('saved').classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('on'), 1200);
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function show(kind, text) {
  const el = $('result');
  el.className = kind;
  el.textContent = text;
}

function applyPresetHint() {
  $('keyHint').innerHTML = PRESETS[$('preset').value].hint;
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
  return { dataUrl: c.toDataURL('image/jpeg', 0.92), width: c.width, height: c.height };
}

// 测试走长连接并定时发 ping，避免等待时插件后台被浏览器休眠
function runTest() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: 'mgtl-translate' });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
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
      resolve(msg);
    });
    port.onDisconnect.addListener(() => {
      clearInterval(ping);
      if (!done) resolve({ ok: false, error: '与插件后台的连接中断，请再点一次「测试」' });
    });
    port.postMessage(Object.assign({ type: 'start', timeoutMs: 60000 }, makeTestImage()));
  });
}

async function init() {
  const cfg = await chrome.storage.local.get(MGTL_DEFAULTS);
  $('preset').value = PRESETS[cfg.preset] ? cfg.preset : 'custom';
  $('baseUrl').value = cfg.baseUrl;
  $('apiKey').value = cfg.apiKey;
  $('model').value = cfg.model;
  if (TARGETS.includes(cfg.targetLang)) {
    $('targetSel').value = cfg.targetLang;
  } else {
    $('targetSel').value = '__custom';
    $('targetCustom').value = cfg.targetLang;
    $('targetCustom').style.display = '';
  }
  $('skipLangs').value = cfg.skipLangs;
  $('displayMode').value = cfg.displayMode;
  $('extraPrompt').value = cfg.extraPrompt;
  $('hoverButton').checked = !!cfg.hoverButton;
  $('autoAfterClick').checked = !!cfg.autoAfterClick;
  $('minSize').value = cfg.minSize;
  $('rpm').value = cfg.rpm;
  curPreset = $('preset').value;
  const saved = (await chrome.storage.local.get({ profiles: {} })).profiles;
  profiles = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  applyPresetHint();

  $('preset').addEventListener('change', async () => {
    const next = $('preset').value;
    if (next === curPreset) return;
    const prevName = PRESETS[curPreset].name;
    const hadKey = !!$('apiKey').value.trim();
    // 先把当前这家的设置记下来，再换成另一家的
    profiles[curPreset] = snapshotProfile();
    const p = PRESETS[next];
    let s = profiles[next];
    let reused = false;
    if (!s && p.url) {
      // 之前在别的选项下（比如「自定义」）填过同一家服务的地址：是同一家，Key 可以直接沿用
      const host = hostOf(p.url);
      const same = Object.values(profiles).find((q) => q && q.apiKey && hostOf(q.baseUrl) === host);
      if (same) {
        s = { apiKey: same.apiKey };
        reused = true;
      }
    }
    s = s || {};
    delete profiles[next];
    $('baseUrl').value = s.baseUrl || p.url;
    $('apiKey').value = s.apiKey || '';
    $('model').value = s.model || p.model || '';
    if (s.rpm != null) $('rpm').value = s.rpm;
    else if (p.rpm != null) $('rpm').value = p.rpm;
    curPreset = next;
    $('modelSel').style.display = 'none';
    applyPresetHint();
    await saveNow();
    const kept = hadKey ? `原来「${prevName}」的 Key 和模型已经记住，切换回去会自动恢复。` : '';
    if (reused) {
      show('info', `已切换到「${p.name}」，沿用了你之前填过的这家服务的 Key。可以直接点「测试」。`);
    } else if (s.apiKey) {
      show('info', `已切换到「${p.name}」，之前保存的 Key 和模型已经恢复。${kept}`);
    } else if (next === 'custom') {
      show('info', `已切换到「${p.name}」，请填写接口地址、Key 和模型，然后点「测试」。${kept}`);
    } else {
      show('info', `已切换到「${p.name}」，请粘贴它的 Key，然后点「测试」。${kept}`);
    }
  });

  $('targetSel').addEventListener('change', () => {
    $('targetCustom').style.display = $('targetSel').value === '__custom' ? '' : 'none';
  });

  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.id === 'modelSel' || el.id === 'preset') continue;
    el.addEventListener('input', saveSoon);
    el.addEventListener('change', saveSoon);
  }

  $('modelSel').addEventListener('change', () => {
    if ($('modelSel').value) {
      $('model').value = $('modelSel').value;
      saveSoon();
    }
  });

  $('listBtn').addEventListener('click', async () => {
    await saveNow();
    $('listBtn').disabled = true;
    show('info', '正在获取模型列表…');
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'mgtl-list-models' });
    } catch (e) {
      res = { ok: false, error: String(e.message || e) };
    }
    $('listBtn').disabled = false;
    if (!res || !res.ok) {
      show('err', '获取失败：' + ((res && res.error) || '未知错误'));
      return;
    }
    if (!res.models.length) {
      show('err', '接口没有返回任何模型，请手动填写模型名。');
      return;
    }
    const sel = $('modelSel');
    sel.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = `请选择模型（共 ${res.models.length} 个）`;
    sel.appendChild(first);
    for (const m of res.models) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    }
    sel.style.display = '';
    if (res.models.includes($('model').value)) sel.value = $('model').value;
    show('ok', `Key 有效，找到 ${res.models.length} 个模型。请在上面的下拉框里选一个能看图的模型，然后点「测试」。`);
  });

  $('testBtn').addEventListener('click', async () => {
    await saveNow();
    $('testBtn').disabled = true;
    const t0 = Date.now();
    const tick = () => show('info', `正在发送一张测试图片给 AI，已等待 ${Math.round((Date.now() - t0) / 1000)} 秒…（最多等 60 秒）`);
    tick();
    const ticker = setInterval(tick, 1000);
    const res = await runTest();
    clearInterval(ticker);
    $('testBtn').disabled = false;
    if (!res || !res.ok) {
      show('err', '测试失败：' + ((res && res.error) || '未知错误'));
      return;
    }
    if (!res.items.length) {
      show('err', 'AI 有回复，但没有识别出测试图里的文字。这个模型可能不擅长看图，建议换一个模型。');
      return;
    }
    const it = res.items[0];
    show(
      'ok',
      `成功！AI 读到了「${it.src || '（未返回原文）'}」，翻译为「${it.text}」。\n` +
        (it.hasBox ? '位置信息也正常。' : '注意：这个模型没有返回文字位置，建议把显示方式改成「编号 + 列表」，或换一个模型。') +
        '\n现在打开任意漫画网页，把鼠标移到图片上点「译」即可。'
    );
  });
}

init();
