// App 模式检查：用假的原生桥（行为照着 Java 那边写）把 prelude.js + userscript.js 跑起来
const __ROOT = require('path').resolve(__dirname, '..'); // 仓库根目录
require('fs').mkdirSync(__ROOT + '/tests/shots', { recursive: true });
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const A = __ROOT + '/android-app/assets/';
const SHOTS = __ROOT + '/tests/shots';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const bundle = '(function(){\nif(window.__mgtlInjected)return;window.__mgtlInjected=1;\nvar __MGTL_TOKEN=' + JSON.stringify('tok123') + ';\n' + fs.readFileSync(A + 'prelude.js', 'utf8') + '\n' + fs.readFileSync(A + 'userscript.js', 'utf8') + '\n})();';
const AI_ITEMS = [
  { box: [80, 100, 240, 520], src: 'a', text: '你好！今天过得怎么样？', dark: false },
  { box: [600, 480, 760, 920], src: 'b', text: '我们走吧！', dark: true }
];
const reqs = [];
const FAKE = `
(() => {
  const _as = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { return _as.call(this, Object.assign({}, o, { mode: 'open' })); };
  const TOKEN = 'tok123';
  const st = { js: {}, baseUrl: '${BASE}', apiKey: '' };
  window.__fakeNative = st; window.__nativeLog = [];
  const hostVis = () => { const h = document.getElementById('mgtl-host'); return h ? getComputedStyle(h).visibility : 'none'; };
  window.MgtlNative = {
    getValue(t, k) { if (t !== TOKEN) return ''; if (k === 'cfg') { let o = {}; try { o = JSON.parse(st.js.cfg || '{}'); } catch (e) {} o.preset = 'custom'; o.baseUrl = st.baseUrl; o.apiKey = st.apiKey ? '@native' : ''; return JSON.stringify(o); } return st.js[k] || ''; },
    setValue(t, k, v) { if (t !== TOKEN) return; st.js[k] = v; },
    request(t, id, method, url, headersJson, body, responseType, timeoutMs) { if (t !== TOKEN) return; window.__nativeReq({ method, url, headersJson, body, responseType, timeoutMs, base: st.baseUrl, hasKey: !!st.apiKey }).then((r) => window.__mgtlCb(id, r)); },
    capture(t, id) { if (t !== TOKEN) return; window.__nativeLog.push(['capture', hostVis()]); window.__nativeCapture().then((b64) => window.__mgtlCb(id, { b64 })); },
    openKeySettings(t) { if (t !== TOKEN) return; window.__nativeLog.push(['openKeySettings']); }
  };
})();`;
let n = 0;
const ok = (m) => { n++; console.log('  ✓ ' + m); };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 这一段照着 Java 里 doRequest 的规则写：只放行发往 AI 接口的请求，以及下载图片的 GET
  await page.exposeFunction('__nativeReq', async (d) => {
    const u = new URL(d.url); const b = new URL(d.base);
    const toAi = u.origin === b.origin; const binary = d.responseType === 'arraybuffer';
    const h = JSON.parse(d.headersJson || '{}');
    const rec = { url: d.url, method: d.method, toAi, auth: h.Authorization || '', referer: h.Referer || '' };
    reqs.push(rec);
    if (!toAi && !(binary && d.method.toUpperCase() === 'GET')) return { error: 'not allowed' };
    if (toAi) {
      if (/\/models$/.test(d.url)) return { status: 200, text: JSON.stringify({ data: [{ id: 'models/gemini-3.5-flash-lite' }] }), headers: '' };
      const body = JSON.parse(d.body); rec.model = body.model; rec.thinking = body.thinking ? body.thinking.type : null; rec.effort = body.reasoning_effort || null;
      if (rec.auth !== 'Bearer @native' || !d.hasKey) return { status: 401, text: '{"error":{"message":"no key"}}', headers: '' };
      await new Promise((r) => setTimeout(r, 200));
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(AI_ITEMS) } }] }), headers: '' };
    }
    if (/page3\.png/.test(d.url)) return { error: 'java.io.IOException: not an image' }; // 模拟防盗链：下载到的不是图片
    const r = await fetch(d.url); const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, b64: buf.toString('base64'), headers: 'content-type: ' + (r.headers.get('content-type') || '') + '\r\n' };
  });
  await page.exposeFunction('__nativeCapture', async () => (await page.screenshot({ type: 'jpeg', quality: 92 })).toString('base64'));
  await page.addInitScript(FAKE);
  await page.goto('http://localhost:8801/test.html', { waitUntil: 'load' });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: bundle }); // App 会在页面加载的两个时机各注入一次，第二次必须什么都不做
  await page.waitForTimeout(300);

  const H = '#mgtl-host ';
  const q = (fn, arg) => page.evaluate(([src, a]) => { const host = document.getElementById('mgtl-host'); return new Function('root', 'host', 'arg', 'return (' + src + ')(root, host, arg)')(host && host.shadowRoot, host, a); }, [fn.toString(), arg]);
  const tapMenu = async (text) => { await page.locator(H + '.fab').tap(); await page.locator(H + '.menu.on').waitFor(); await page.locator(H + '.menu div', { hasText: text }).tap(); };
  const boxes = () => q((root) => Array.from(root.querySelectorAll('.box')).map((b) => { const r = b.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, dark: b.classList.contains('dark'), vis: r.width > 0 }; }));
  const rectOf = (id) => page.evaluate((i) => { const r = document.getElementById(i).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }, id);
  const waitBoxes = (k) => page.waitForFunction((x) => document.getElementById('mgtl-host').shadowRoot.querySelectorAll('.box').length >= x, k, { timeout: 15000 });
  const scrollTo = async (y) => { await page.evaluate((v) => window.scrollTo(0, v), y); await page.waitForTimeout(250); };
  const near = async (pts) => { const bs = (await boxes()).filter((b) => b.vis); for (const e of pts) assert.ok(bs.find((b) => Math.abs(b.cx - e.x) < 3 && Math.abs(b.cy - e.y) < 3 && b.dark === e.dark), 'no box near ' + JSON.stringify(e) + ' have ' + JSON.stringify(bs.map((b) => [Math.round(b.cx), Math.round(b.cy)]))); };
  const whole = (r) => [{ x: r.left + 0.31 * r.width, y: r.top + 0.16 * r.height, dark: false }, { x: r.left + 0.7 * r.width, y: r.top + 0.68 * r.height, dark: true }];
  const log = () => page.evaluate(() => window.__nativeLog);
  const absTop = (id) => page.evaluate((i) => document.getElementById(i).getBoundingClientRect().top + window.scrollY, id);

  assert.strictEqual(await page.locator(H + '.fab').count(), 1, 'exactly one button after double injection');
  ok('脚本在 App 模式下启动，重复注入不会出现两个按钮');

  // 1. 没有 Key：点翻译 → 打开 App 的原生设置，不在网页里要 Key
  await tapMenu('翻译屏幕上的图片');
  await page.waitForTimeout(300);
  assert.deepStrictEqual((await log()).map((x) => x[0]), ['openKeySettings']);
  assert.strictEqual(await q((root) => !!root.querySelector('.mask.on')), false);
  assert.strictEqual(reqs.length, 0);
  ok('没有 Key 时会让 App 弹出原生的设置窗口，不发任何请求');

  // 2. App 保存了 Key 之后通知网页
  await page.evaluate(() => { window.__fakeNative.apiKey = 'REAL-SECRET'; window.__mgtlCb('event', 'cfg'); });
  await page.waitForTimeout(200);
  await tapMenu('设置');
  await page.locator(H + '.mask.on').waitFor();
  assert.strictEqual(await page.locator(H + '.dlg input[type=password]').count(), 0, 'no key field in the page');
  assert.strictEqual(await page.locator(H + '.dlg input[type=url]').count(), 0);
  const state = await q((root) => root.querySelector('.dlg').textContent);
  assert.ok(/已设置。接口地址：https:\/\/generativelanguage/.test(state) && /在 App 里修改/.test(state));
  await page.locator(H + '.dlg input[type=number]').nth(0).fill('0');
  await page.locator(H + '.dlg .btn', { hasText: '测试' }).tap();
  await page.waitForFunction(() => /成功/.test(document.getElementById('mgtl-host').shadowRoot.querySelector('.res').textContent), null, { timeout: 15000 });
  const chat = reqs.filter((r) => /chat\/completions/.test(r.url));
  assert.strictEqual(chat[0].auth, 'Bearer @native');
  assert.strictEqual(chat[0].model, 'gemini-3.5-flash-lite');
  await page.screenshot({ path: SHOTS + '/app-01-settings.png' });
  await page.locator(H + '.dlg .btn', { hasText: '完成' }).tap();
  await page.waitForTimeout(300);
  const pageSide = await page.evaluate(() => JSON.stringify(window.__fakeNative.js) + document.documentElement.outerHTML + JSON.stringify(Object.keys(localStorage).map((k) => localStorage.getItem(k))));
  assert.ok(!pageSide.includes('REAL-SECRET'), 'the real key never reaches anything stored or rendered on the page side');
  ok('网页里的设置不出现 Key 输入框；请求只带占位符，真正的 Key 留在 App 一侧');

  // 3. 普通图片：本站图直接读，跨域图通过 App 下载（带 Referer）
  await tapMenu('翻译屏幕上的图片');
  await waitBoxes(4);
  await page.waitForTimeout(200);
  await near(whole(await rectOf('local')));
  await near(whole(await rectOf('p1')));
  const img = reqs.find((r) => /page1\.png/.test(r.url));
  assert.ok(img && !img.toAi && img.auth === '' && /^http:\/\/localhost:8801\//.test(img.referer), JSON.stringify(img));
  assert.strictEqual((await log()).filter((x) => x[0] === 'capture').length, 0);
  ok('读得到的图片不会动用截屏；跨域图片通过 App 下载，且不带 Key');

  // 4. 屏幕上的主要图片读不到内容：改为截屏翻译整个屏幕（截屏时我们自己的界面是隐藏的）
  const aiCalls = () => reqs.filter((r) => r.toAi && /chat\/completions/.test(r.url)).length;
  const hiddenCaps = async () => (await log()).filter((x) => x[0] === 'capture' && x[1] === 'hidden').length;
  const screenPts = [{ x: 0.31 * 390, y: 0.16 * 844 }, { x: 0.7 * 390, y: 0.68 * 844 }];
  const onlyScreen = async () => { const bs = (await boxes()).filter((b) => b.vis); return bs.length === 2 && screenPts.every((e) => bs.some((b) => Math.abs(b.cx - e.x) < 3 && Math.abs(b.cy - e.y) < 3)); };
  const until = async (fn, what, ms) => { const t0 = Date.now(); for (;;) { if (await fn()) return; if (Date.now() - t0 > (ms || 8000)) throw new Error('等不到：' + what); await page.waitForTimeout(80); } };
  const toastText = () => q((root) => { const t = root.querySelector('.toast'); return t.classList.contains('on') ? t.textContent : ''; });
  await tapMenu('清除本页译文');
  const p3 = await absTop('p3');
  await scrollTo(p3 - 100);
  await tapMenu('翻译屏幕上的图片');
  await until(onlyScreen, '整屏译文出现在屏幕对应的位置', 15000);
  assert.strictEqual(await hiddenCaps(), 1, '只为这一次翻译截了一次屏');
  assert.strictEqual(await q((root) => root.querySelectorAll('.badge.error').length), 0);
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('mgtl-host')).visibility), 'visible');
  await page.screenshot({ path: SHOTS + '/app-02-capture.png' });
  ok('屏幕上的主要图片读不到时，不再报错，而是截屏翻译整个屏幕；截屏时按钮和译文会先藏起来');

  // 5. 碰一下网页 → 译文撤掉；再点翻译 → 直接整屏，不再反复去下载那张读不到的图
  await page.touchscreen.tap(200, 500);
  await until(async () => (await boxes()).length === 0, '碰网页后译文撤掉');
  const c5 = aiCalls();
  const p3reqs = reqs.filter((r) => /page3\.png/.test(r.url)).length;
  await tapMenu('翻译屏幕上的图片');
  await until(onlyScreen, '再次整屏翻译', 15000);
  assert.strictEqual(aiCalls(), c5 + 1);
  assert.strictEqual(reqs.filter((r) => /page3\.png/.test(r.url)).length, p3reqs, 'must not re-download an image known to be unreadable');
  ok('已经知道读不到的图片不会再去下载，直接整屏翻译，只调用一次 AI');

  // 6. 自动翻译（整屏方式）：网页动了、停稳后自动翻译；译文显示着的时候不截屏、不闪、不重复调用 AI
  await tapMenu('自动翻译本网站：关');
  await until(async () => (await toastText()).includes('整屏方式'), '提示自动翻译用的是整屏方式');
  const c6 = aiCalls();
  await scrollTo(p3 - 40);
  await until(async () => aiCalls() === c6 + 1 && (await onlyScreen()), '滚动停下后自动翻译新的画面', 15000);
  const h6 = await hiddenCaps();
  const visLog = [];
  for (let i = 0; i < 35; i++) { visLog.push(await page.evaluate(() => getComputedStyle(document.getElementById('mgtl-host')).visibility)); await page.waitForTimeout(100); }
  assert.ok(visLog.every((v) => v === 'visible'), '3.5 秒内界面不应被藏起来（不闪）');
  assert.strictEqual(await hiddenCaps(), h6);
  assert.strictEqual(aiCalls(), c6 + 1);
  assert.strictEqual(await onlyScreen(), true);
  ok('自动翻译（整屏方式）：滚动停下后自动翻译一次；之后 3.5 秒内不截屏、不闪、不重复调用 AI');
  await scrollTo(p3 - 100); // 回到刚才翻译过的画面
  await until(onlyScreen, '回到看过的画面，译文直接恢复', 15000);
  await page.waitForTimeout(600);
  assert.strictEqual(aiCalls(), c6 + 1, '看过的画面不应再调用 AI');
  assert.strictEqual(await hiddenCaps(), h6);
  assert.strictEqual(await q((root) => root.querySelectorAll('.badge.error').length), 0);
  ok('回到刚才看过的画面：直接用上次的译文，不再调用 AI');

  // 7. App 里把接口换成 DeepSeek（Java 那边会同时把模型改成 deepseek-flash，这里照着模拟）
  await tapMenu('清除本页译文');
  await scrollTo(0);
  await page.evaluate(() => {
    const st = window.__fakeNative;
    st.baseUrl = 'https://api.deepseek.com';
    const o = JSON.parse(st.js.cfg || '{}'); o.model = 'deepseek-flash'; o.rpm = 0; st.js.cfg = JSON.stringify(o);
    window.__mgtlCb('event', 'cfg');
  });
  await page.waitForTimeout(300);
  const nDs = reqs.length;
  await tapMenu('翻译屏幕上的图片');
  await waitBoxes(2);
  await page.waitForTimeout(600);
  const ds = reqs.slice(nDs).filter((r) => /chat\/completions/.test(r.url));
  assert.ok(ds.length >= 1 && ds.every((r) => r.url === 'https://api.deepseek.com/chat/completions' && r.toAi && r.model === 'deepseek-flash' && r.thinking === 'disabled' && r.effort === null && r.auth === 'Bearer @native'), JSON.stringify(ds));
  await near(whole(await rectOf('local')));
  await tapMenu('设置');
  await page.locator(H + '.mask.on').waitFor();
  assert.ok(/已设置。接口地址：https:\/\/api\.deepseek\.com/.test(await q((root) => root.querySelector('.dlg').textContent)));
  assert.strictEqual(await q((root) => root.querySelectorAll('.dlg .row2 input')[0].value), 'deepseek-flash');
  await page.screenshot({ path: SHOTS + '/app-03-deepseek.png' });
  await page.locator(H + '.dlg .btn', { hasText: '完成' }).tap();
  ok('App 里换成 DeepSeek 后，请求发往 DeepSeek、模型是 deepseek-flash、思考模式已关闭');

  assert.deepStrictEqual(errors, []);
  ok('全程没有脚本报错');
  console.log('APP MODE: ALL ' + n + ' CHECKS PASSED');
  await browser.close();
})().catch((e) => { console.error('APP MODE FAILED:', e.stack.split('\n').slice(0, 6).join('\n')); process.exit(1); });
