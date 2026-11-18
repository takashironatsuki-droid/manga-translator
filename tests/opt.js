// 桌面插件设置页检查：真实浏览器里打开 options.html，用假的 chrome 接口，存储放在 Node 这边（刷新页面后还在）
const __ROOT = require('path').resolve(__dirname, '..'); // 仓库根目录
require('fs').mkdirSync(__ROOT + '/tests/shots', { recursive: true });
const { chromium } = require('playwright');
const assert = require('assert');
const DIR = __ROOT + '/chrome-extension/';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DS_URL = 'https://api.deepseek.com';

const STUB = `
  (() => {
    const c = {
      storage: { local: {
        get: async (d) => Object.assign({}, d, JSON.parse(await window.__storeGet(Object.keys(d || {})))),
        set: async (o) => { await window.__storeSet(JSON.stringify(o)); }
      } },
      runtime: {
        sendMessage: async (m) => JSON.parse(await window.__bgMsg(JSON.stringify(m))),
        connect: () => {
          const ml = [];
          return {
            onMessage: { addListener: (f) => ml.push(f) }, onDisconnect: { addListener: () => {} }, disconnect: () => {},
            postMessage: (m) => { if (m.type === 'start') window.__bgTest().then((s) => ml.forEach((f) => f(JSON.parse(s)))); }
          };
        }
      }
    };
    Object.defineProperty(window, 'chrome', { value: c, configurable: true, writable: true });
  })();
`;

let n = 0;
const ok = (name) => console.log(`ok ${++n} - ${name}`);

async function open(browser, initial) {
  const store = Object.assign({}, initial);
  const sets = []; // 每一次写入存储后的完整快照
  const tests = []; // 每一次点「测试」时后台会读到的设置
  const page = await (await browser.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('__storeGet', async (keys) => JSON.stringify(Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))));
  await page.exposeFunction('__storeSet', async (s) => {
    Object.assign(store, JSON.parse(s));
    sets.push(JSON.parse(JSON.stringify(store)));
  });
  await page.exposeFunction('__bgMsg', async (s) => {
    const m = JSON.parse(s);
    if (m.type === 'mgtl-list-models') return JSON.stringify({ ok: true, models: ['deepseek-flash', 'deepseek-v4-pro'] });
    return JSON.stringify({ ok: false, error: 'unsupported in test' });
  });
  await page.exposeFunction('__bgTest', async () => {
    tests.push(JSON.parse(JSON.stringify(store)));
    return JSON.stringify({ type: 'result', ok: true, items: [{ text: '你好，最近好吗？', src: 'Bonjour, ça va ?', hasBox: true, dark: false, x: 0.1, y: 0.2, w: 0.8, h: 0.5 }] });
  });
  await page.addInitScript(STUB);
  await page.goto('file://' + DIR + 'options.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('keyHint').innerHTML.length > 0);
  const fields = () => page.evaluate(() => ({
    preset: document.getElementById('preset').value,
    baseUrl: document.getElementById('baseUrl').value,
    apiKey: document.getElementById('apiKey').value,
    model: document.getElementById('model').value,
    rpm: document.getElementById('rpm').value,
    hint: document.getElementById('keyHint').innerHTML,
    result: document.getElementById('result').textContent,
    resultKind: document.getElementById('result').className
  }));
  const pick = async (v) => {
    const before = sets.length;
    await page.selectOption('#preset', v);
    await page.waitForFunction((x) => document.getElementById('result').textContent.includes('已切换到'), null, { timeout: 5000 });
    for (let i = 0; i < 50 && sets.length === before; i++) await page.waitForTimeout(20);
    assert.ok(sets.length > before, '切换后应立即保存');
  };
  const typeInto = async (id, v) => {
    const before = sets.length;
    await page.fill('#' + id, v);
    for (let i = 0; i < 100 && sets.length === before; i++) await page.waitForTimeout(20);
    assert.ok(sets.length > before, '输入后应自动保存');
  };
  return { page, store, sets, tests, errors, fields, pick, typeInto };
}

// Key 绝不能和别家的接口地址配在一起被保存（否则点「测试」就会把它发给别家）
function assertNoCrossLeak(snaps, pairs) {
  for (const s of snaps) {
    for (const [key, host] of pairs) {
      if (s.apiKey === key) assert.ok(String(s.baseUrl).includes(host), `Key ${key} 被配到了 ${s.baseUrl}`);
    }
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    // ===== 场景一：老用户（已经在用 Gemini）升级后改用 DeepSeek =====
    const a = await open(browser, { preset: 'gemini', baseUrl: GEMINI_URL, apiKey: 'G-KEY', model: 'gemini-3.5-flash-lite', rpm: 8, targetLang: '简体中文', skipLangs: '日语', autoHosts: ['example.com'] });
    let f = await a.fields();
    assert.deepStrictEqual([f.preset, f.baseUrl, f.apiKey, f.model, f.rpm], ['gemini', GEMINI_URL, 'G-KEY', 'gemini-3.5-flash-lite', '8']);
    const opts = await a.page.evaluate(() => Array.from(document.querySelectorAll('#preset option')).map((o) => o.value));
    assert.deepStrictEqual(opts, ['gemini', 'deepseek', 'openai', 'claude', 'openrouter', 'custom']);
    ok('升级后原来的 Gemini 设置原样显示，下拉框里多了 DeepSeek');

    await a.pick('deepseek');
    f = await a.fields();
    assert.deepStrictEqual([f.preset, f.baseUrl, f.apiKey, f.model, f.rpm], ['deepseek', DS_URL, '', 'deepseek-flash', '0']);
    assert.ok(f.hint.includes('platform.deepseek.com/api_keys'));
    assert.ok(f.result.includes('DeepSeek') && f.result.includes('Google Gemini') && f.result.includes('已经记住'), f.result);
    assert.strictEqual(a.store.preset, 'deepseek');
    assert.strictEqual(a.store.baseUrl, DS_URL);
    assert.strictEqual(a.store.apiKey, '');
    assert.strictEqual(a.store.model, 'deepseek-flash');
    assert.strictEqual(a.store.rpm, 0);
    assert.deepStrictEqual(a.store.profiles.gemini, { baseUrl: GEMINI_URL, apiKey: 'G-KEY', model: 'gemini-3.5-flash-lite', rpm: 8 });
    assert.strictEqual(a.store.skipLangs, '日语');
    assert.deepStrictEqual(a.store.autoHosts, ['example.com']);
    ok('选 DeepSeek：地址、模型、限速自动填好，Key 留空，Gemini 的设置被记住，其他设置不变');

    await a.typeInto('apiKey', 'D-KEY');
    assert.strictEqual(a.store.apiKey, 'D-KEY');
    await a.page.click('#testBtn');
    await a.page.waitForFunction(() => document.getElementById('result').className === 'ok', null, { timeout: 5000 });
    f = await a.fields();
    assert.ok(f.result.startsWith('成功'), f.result);
    assert.strictEqual(a.tests.length, 1);
    assert.deepStrictEqual([a.tests[0].baseUrl, a.tests[0].apiKey, a.tests[0].model, a.tests[0].rpm], [DS_URL, 'D-KEY', 'deepseek-flash', 0]);
    ok('粘贴 DeepSeek 的 Key 后点「测试」，后台读到的是 DeepSeek 的地址 + DeepSeek 的 Key');

    await a.page.click('#listBtn');
    await a.page.waitForFunction(() => document.getElementById('modelSel').style.display !== 'none', null, { timeout: 5000 });
    f = await a.fields();
    assert.strictEqual(f.model, 'deepseek-flash');
    assert.strictEqual(await a.page.evaluate(() => document.getElementById('modelSel').value), 'deepseek-flash');
    ok('「获取模型列表」不会改掉已经填好的 deepseek-flash');

    await a.pick('gemini');
    f = await a.fields();
    assert.deepStrictEqual([f.preset, f.baseUrl, f.apiKey, f.model, f.rpm], ['gemini', GEMINI_URL, 'G-KEY', 'gemini-3.5-flash-lite', '8']);
    assert.ok(f.result.includes('已经恢复'), f.result);
    assert.deepStrictEqual(a.store.profiles.deepseek, { baseUrl: DS_URL, apiKey: 'D-KEY', model: 'deepseek-flash', rpm: 0 });
    assert.ok(!('gemini' in a.store.profiles));
    assert.deepStrictEqual([a.store.baseUrl, a.store.apiKey, a.store.model, a.store.rpm], [GEMINI_URL, 'G-KEY', 'gemini-3.5-flash-lite', 8]);
    ok('切回 Gemini：原来的 Key、模型、限速自动恢复');

    await a.pick('deepseek');
    f = await a.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey, f.model, f.rpm], [DS_URL, 'D-KEY', 'deepseek-flash', '0']);
    ok('再切到 DeepSeek：它的 Key 也自动恢复');

    // 刷新设置页（相当于关掉再打开）
    await a.page.reload({ waitUntil: 'load' });
    await a.page.waitForFunction(() => document.getElementById('keyHint').innerHTML.length > 0);
    f = await a.fields();
    assert.deepStrictEqual([f.preset, f.baseUrl, f.apiKey, f.model, f.rpm], ['deepseek', DS_URL, 'D-KEY', 'deepseek-flash', '0']);
    await a.pick('gemini');
    f = await a.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey, f.model, f.rpm], [GEMINI_URL, 'G-KEY', 'gemini-3.5-flash-lite', '8']);
    ok('关掉设置页再打开，两家的设置都还在');

    // 换到一个从没用过的服务：Key 清空，不会带着别家的 Key 过去
    await a.pick('openai');
    f = await a.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey, f.model], ['https://api.openai.com/v1', '', '']);
    await a.pick('custom');
    f = await a.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey, f.model], ['', '', '']);
    await a.typeInto('baseUrl', 'http://localhost:11434/v1');
    await a.typeInto('model', 'llava');
    await a.pick('deepseek');
    await a.pick('custom');
    f = await a.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey, f.model], ['http://localhost:11434/v1', '', 'llava']);
    ok('没用过的服务 Key 是空的；「自定义」的地址和模型也会被记住');

    assertNoCrossLeak(a.sets.concat(a.tests), [['G-KEY', 'googleapis.com'], ['D-KEY', 'deepseek.com']]);
    ok(`整个过程 ${a.sets.length} 次保存里，没有一次把这家的 Key 配到另一家的地址上`);
    assert.deepStrictEqual(a.errors, []);
    await a.page.context().close();

    // ===== 场景二：全新安装，直接选 DeepSeek =====
    const b = await open(browser, {});
    f = await b.fields();
    assert.deepStrictEqual([f.preset, f.baseUrl, f.apiKey, f.model, f.rpm], ['gemini', GEMINI_URL, '', '', '8']);
    await b.pick('deepseek');
    f = await b.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey, f.model, f.rpm], [DS_URL, '', 'deepseek-flash', '0']);
    assert.ok(!f.result.includes('已经记住'), f.result); // 之前没填过 Key，就不说"已记住"
    await b.pick('gemini');
    f = await b.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey, f.model, f.rpm], [GEMINI_URL, '', '', '8']);
    ok('全新安装：选 DeepSeek 自动填好；换回 Gemini 时限速回到 8');
    assert.deepStrictEqual(b.errors, []);
    await b.page.context().close();

    // ===== 场景三：之前按我说的用「自定义」填了 DeepSeek 地址的人，升级后照常能用 =====
    const c = await open(browser, { preset: 'custom', baseUrl: DS_URL, apiKey: 'D-KEY', model: 'deepseek-flash', rpm: 8, profiles: ['坏数据'] });
    f = await c.fields();
    assert.deepStrictEqual([f.preset, f.baseUrl, f.apiKey, f.model, f.rpm], ['custom', DS_URL, 'D-KEY', 'deepseek-flash', '8']);
    await c.pick('deepseek');
    f = await c.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey, f.model, f.rpm], [DS_URL, 'D-KEY', 'deepseek-flash', '0']);
    assert.ok(f.result.includes('沿用'), f.result);
    assert.ok(!Array.isArray(c.store.profiles) && c.store.profiles.custom.apiKey === 'D-KEY');
    ok('旧的「自定义 + DeepSeek 地址」设置能正常打开；改选 DeepSeek 时沿用同一家的 Key；存储里的异常数据不会让页面出错');
    // 但换到另一家（地址不同）时，Key 不会跟过去
    await c.pick('gemini');
    f = await c.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey], [GEMINI_URL, '']);
    await c.pick('openrouter');
    f = await c.fields();
    assert.deepStrictEqual([f.baseUrl, f.apiKey], ['https://openrouter.ai/api/v1', '']);
    assertNoCrossLeak(c.sets, [['D-KEY', 'deepseek.com']]);
    ok('同一个 Key 只会用在同一家的地址上，不会跟到别家');
    assert.deepStrictEqual(c.errors, []);
    await c.page.context().close();

    console.log(`OPT ALL ${n} CHECKS PASSED`);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('OPT FAILED:', e);
  process.exit(1);
});
