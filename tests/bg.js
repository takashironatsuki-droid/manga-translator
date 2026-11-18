// 桌面插件后台脚本检查：用假的 chrome / fetch 把 background.js 跑起来，看它实际发出的请求
const __ROOT = require('path').resolve(__dirname, '..'); // 仓库根目录
require('fs').mkdirSync(__ROOT + '/tests/shots', { recursive: true });
const vm = require('vm');
const fs = require('fs');
const assert = require('assert');
const DIR = __ROOT + '/chrome-extension/';

const ITEMS_JSON = '[{"box":[100,100,300,500],"src":"Bonjour","text":"你好","dark":false}]';

function sse(chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

// 模拟 DeepSeek 的流式回复：带 keep-alive 注释行，正文被拆成几段
function okStream() {
  const half = Math.floor(ITEMS_JSON.length / 2);
  const d = (delta) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n';
  return sse([': keep-alive\n\n', d({ role: 'assistant', content: '' }), d({ content: ITEMS_JSON.slice(0, half) }), ': keep-alive\n\n', d({ content: ITEMS_JSON.slice(half) }), 'data: [DONE]\n\n']);
}

const errRes = (status, message) => new Response(JSON.stringify({ error: { message, type: 'x' } }), { status, headers: { 'content-type': 'application/json' } });

function makeEnv(cfg, responder) {
  const calls = [];
  const listeners = { message: [] };
  const sandbox = {
    console, setTimeout, clearTimeout, TextDecoder, TextEncoder, AbortController, DOMException, btoa, atob, Uint8Array, Response,
    fetch: async (url, init) => {
      const call = { url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      return responder(call, calls.length);
    },
    importScripts: (f) => vm.runInContext(fs.readFileSync(DIR + f, 'utf8'), ctx, { filename: f }),
    chrome: {
      storage: { local: { get: async (d) => Object.assign({}, d, cfg) } },
      runtime: { onInstalled: { addListener() {} }, onConnect: { addListener() {} }, onMessage: { addListener: (f) => listeners.message.push(f) }, openOptionsPage() {} },
      contextMenus: { removeAll() {}, create() {}, onClicked: { addListener() {} } },
      tabs: {}
    }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(DIR + 'background.js', 'utf8'), ctx, { filename: 'background.js' });
  const send = (msg) => new Promise((resolve) => listeners.message[0](msg, {}, resolve));
  const translate = () => send({ type: 'mgtl-test', dataUrl: 'data:image/jpeg;base64,AAAA', width: 480, height: 240, timeoutMs: 20000 });
  return { calls, send, translate };
}

const DS = { preset: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds-test', model: 'deepseek-flash', rpm: 0 };
const GM = { preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'AIza-test', model: 'gemini-3.5-flash-lite', rpm: 0 };
const OA = { preset: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-oa', model: 'gpt-x', rpm: 0 };

let n = 0;
const ok = (name) => console.log(`ok ${++n} - ${name}`);

(async () => {
  // 1. DeepSeek：地址、Key、模型、关闭思考、流式结果解析
  {
    const e = makeEnv(DS, () => okStream());
    const r = await e.translate();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(e.calls.length, 1);
    const c = e.calls[0];
    assert.strictEqual(c.url, 'https://api.deepseek.com/chat/completions');
    assert.strictEqual(c.method, 'POST');
    assert.strictEqual(c.headers.Authorization, 'Bearer sk-ds-test');
    assert.strictEqual(c.body.model, 'deepseek-flash');
    assert.deepStrictEqual(c.body.thinking, { type: 'disabled' });
    assert.ok(!('reasoning_effort' in c.body));
    assert.strictEqual(c.body.stream, true);
    assert.strictEqual(c.body.messages[0].content[1].type, 'image_url');
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].text, '你好');
    assert.strictEqual(r.items[0].hasBox, true);
    ok('DeepSeek 请求带 thinking:disabled，流式回复（含 keep-alive 行）解析正常');
  }
  // 2. 接口地址写成 /v1 结尾也可以
  {
    const e = makeEnv(Object.assign({}, DS, { baseUrl: 'https://api.deepseek.com/v1/' }), () => okStream());
    const r = await e.translate();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(e.calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
    assert.deepStrictEqual(e.calls[0].body.thinking, { type: 'disabled' });
    ok('DeepSeek 地址带 /v1 时同样生效');
  }
  // 3. Gemini 不受影响：仍然是 reasoning_effort，没有 thinking
  {
    const e = makeEnv(GM, () => okStream());
    const r = await e.translate();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(e.calls[0].body.reasoning_effort, 'low');
    assert.ok(!('thinking' in e.calls[0].body));
    ok('Gemini 的请求和以前一样');
  }
  // 4. 其他服务两个参数都不带
  {
    const e = makeEnv(OA, () => okStream());
    const r = await e.translate();
    assert.strictEqual(r.ok, true);
    assert.ok(!('thinking' in e.calls[0].body) && !('reasoning_effort' in e.calls[0].body));
    ok('OpenAI 等其他服务不带额外参数');
  }
  // 5/6. 服务器不接受 thinking 参数（400 或 422）时，去掉后自动重试一次
  for (const code of [400, 422]) {
    const e = makeEnv(DS, (c, i) => (i === 1 ? errRes(code, 'unknown parameter: thinking') : okStream()));
    const r = await e.translate();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(e.calls.length, 2);
    assert.ok('thinking' in e.calls[0].body);
    assert.ok(!('thinking' in e.calls[1].body));
    ok(`thinking 参数被拒绝（${code}）时去掉后重试成功`);
  }
  // 7. 填了不能看图的模型：只重试一次，并给出明确提示
  {
    const e = makeEnv(Object.assign({}, DS, { model: 'deepseek-v4-pro' }), () => errRes(400, 'This model does not support image input'));
    const r = await e.translate();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(e.calls.length, 2);
    assert.ok(/deepseek-flash/.test(r.error), r.error);
    assert.ok(/400/.test(r.error) && /does not support image input/.test(r.error), r.error);
    ok('DeepSeek 选错模型时提示改成 deepseek-flash');
  }
  // 8. deepseek-flash 本身返回 400 时，不显示"换模型"的提示
  {
    const e = makeEnv(DS, () => errRes(400, 'bad request'));
    const r = await e.translate();
    assert.strictEqual(r.ok, false);
    assert.ok(!/请到设置里把模型改成它/.test(r.error), r.error);
    ok('模型正确时不会误报"换模型"');
  }
  // 9. 余额不足
  {
    const e = makeEnv(DS, () => errRes(402, 'Insufficient Balance'));
    const r = await e.translate();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(e.calls.length, 1);
    assert.ok(/余额不足/.test(r.error) && /402/.test(r.error) && /Insufficient Balance/.test(r.error), r.error);
    ok('余额不足（402）有中文提示');
  }
  // 10. Key 不对
  {
    const e = makeEnv(DS, () => errRes(401, 'Authentication Fails'));
    const r = await e.translate();
    assert.strictEqual(r.ok, false);
    assert.ok(/API Key 无效/.test(r.error), r.error);
    ok('Key 无效（401）有中文提示');
  }
  // 11. rpm = 0 时不排队
  {
    const e = makeEnv(DS, () => okStream());
    const t0 = Date.now();
    await Promise.all([e.translate(), e.translate(), e.translate()]);
    assert.ok(Date.now() - t0 < 1500, 'took ' + (Date.now() - t0));
    assert.strictEqual(e.calls.length, 3);
    ok('rpm 为 0 时三张图同时发出，不排队');
  }
  // 12. 获取模型列表
  {
    const e = makeEnv(DS, () => new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await e.send({ type: 'mgtl-list-models' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(e.calls[0].url, 'https://api.deepseek.com/models');
    assert.strictEqual(e.calls[0].headers.Authorization, 'Bearer sk-ds-test');
    assert.deepStrictEqual(Array.from(r.models), ['deepseek-flash', 'deepseek-v4-pro']);
    ok('「获取模型列表」对 DeepSeek 可用');
  }
  // 13. 非流式回复也能读（有的服务会忽略 stream）
  {
    const e = makeEnv(DS, () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ITEMS_JSON, reasoning_content: 'x' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await e.translate();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.items[0].text, '你好');
    ok('非流式回复也能解析');
  }
  console.log(`BG ALL ${n} CHECKS PASSED`);
})().catch((e) => {
  console.error('BG FAILED:', e);
  process.exit(1);
});
