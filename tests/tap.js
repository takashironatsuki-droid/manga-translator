// 真实条件下的点按检查（App 模式）：
const __ROOT = require('path').resolve(__dirname, '..'); // 仓库根目录
require('fs').mkdirSync(__ROOT + '/tests/shots', { recursive: true });
//  - 界面所在的 shadow DOM 保持「closed」，和手机上一模一样（以前的检查把它改成了 open，漏掉了问题）
//  - 所有操作都是按屏幕坐标发出的真实触摸，不直接调用页面里的函数
// 用法：node tap.js [脚本路径]   环境变量 EXPECT_BROKEN=1 表示预期旧版会失败（用来复现问题）
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const A = __ROOT + '/android-app/assets/';
const US = process.argv[2] || A + 'userscript.js';
const ONLY = process.env.ONLY || '';
const SHOTS = __ROOT + '/tests/shots';
const BASE = 'https://api.deepseek.com';
const bundle = '(function(){\nif(window.__mgtlInjected)return;window.__mgtlInjected=1;\nvar __MGTL_TOKEN=' + JSON.stringify('tok123') + ';\n' + fs.readFileSync(A + 'prelude.js', 'utf8') + '\n' + fs.readFileSync(US, 'utf8') + '\n})();';
const AI_ITEMS = [
  { box: [80, 100, 240, 520], src: 'a', text: '你好！今天过得怎么样？', dark: false },
  { box: [600, 480, 760, 920], src: 'b', text: '我们走吧！', dark: true }
];
const FAKE = (configured) => `
(() => {
  // 只把 shadow root 记下来给检查脚本量坐标用，不改变它的 closed 模式
  const _as = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { const r = _as.call(this, o); if (this.id === 'mgtl-host') { window.__mgtlRoot = r; window.__mgtlMode = o && o.mode; } return r; };
  const TOKEN = 'tok123';
  const st = { js: ${configured ? "{ cfg: JSON.stringify({ model: 'deepseek-flash', rpm: 0 }) }" : '{}'}, baseUrl: '${BASE}', apiKey: ${configured ? "'REAL-SECRET'" : "''"} };
  window.__fakeNative = st; window.__nativeLog = [];
  window.MgtlNative = {
    getValue(t, k) { if (t !== TOKEN) return ''; if (k === 'cfg') { let o = {}; try { o = JSON.parse(st.js.cfg || '{}'); } catch (e) {} o.preset = 'custom'; o.baseUrl = st.baseUrl; o.apiKey = st.apiKey ? '@native' : ''; return JSON.stringify(o); } return st.js[k] || ''; },
    setValue(t, k, v) { if (t !== TOKEN) return; st.js[k] = v; },
    request(t, id, method, url, headersJson, body, responseType, timeoutMs) { if (t !== TOKEN) return; window.__nativeReq({ method, url, headersJson, body, responseType, base: st.baseUrl, hasKey: !!st.apiKey }).then((r) => window.__mgtlCb(id, r)); },
    capture(t, id) { if (t !== TOKEN) return; window.__nativeLog.push(['capture', getComputedStyle(document.getElementById('mgtl-host')).visibility, performance.now()]); window.__nativeCapture().then((b64) => window.__mgtlCb(id, { b64 })); },
    openKeySettings(t) { if (t !== TOKEN) return; window.__nativeLog.push(['openKeySettings']); }
  };
})();`;

let n = 0;
const ok = (m) => { n++; console.log('  ✓ ' + m); };

async function open(browser, url, configured) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  const reqs = [];
  const ctl = { delay: 150, empty: false };
  page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('__nativeReq', async (d) => {
    const u = new URL(d.url); const b = new URL(d.base);
    const toAi = u.origin === b.origin; const binary = d.responseType === 'arraybuffer';
    reqs.push({ url: d.url, toAi });
    if (!toAi && !(binary && d.method.toUpperCase() === 'GET')) return { error: 'not allowed' };
    if (toAi) {
      await new Promise((r) => setTimeout(r, ctl.delay));
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify(ctl.empty ? [] : AI_ITEMS) } }] }), headers: '' };
    }
    const r = await fetch(d.url); const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, b64: buf.toString('base64'), headers: 'content-type: ' + (r.headers.get('content-type') || '') + '\r\n' };
  });
  await page.exposeFunction('__nativeCapture', async () => (await page.screenshot({ type: 'jpeg', quality: 92 })).toString('base64'));
  await page.addInitScript(FAKE(configured));
  await page.goto(url, { waitUntil: 'load' });
  await page.addScriptTag({ content: bundle });
  await page.waitForTimeout(400);

  // 在 shadow root 里找一个看得见的元素，返回它中心点的屏幕坐标
  const find = (sel, text) => page.evaluate(([s, t]) => {
    const root = window.__mgtlRoot;
    if (!root) return null;
    for (const el of root.querySelectorAll(s)) {
      if (t && !el.textContent.includes(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || getComputedStyle(el).display === 'none') continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent };
    }
    return null;
  }, [sel, text || '']);
  const tap = async (sel, text) => {
    const p = await find(sel, text);
    assert.ok(p, `屏幕上找不到「${text || sel}」`);
    await page.touchscreen.tap(p.x, p.y);
    return p;
  };
  const menuOn = () => page.evaluate(() => window.__mgtlRoot.querySelector('.menu').classList.contains('on'));
  const toast = () => page.evaluate(() => { const t = window.__mgtlRoot.querySelector('.toast'); return t.classList.contains('on') ? t.textContent : ''; });
  const openMenu = async () => {
    if (await menuOn()) return;
    await tap('.fab');
    await page.waitForTimeout(120);
    assert.strictEqual(await menuOn(), true, '点「译」后菜单应该打开');
  };
  const tapMenu = async (text) => { await openMenu(); await tap('.menu div', text); };
  const boxCount = () => page.evaluate(() => Array.from(window.__mgtlRoot.querySelectorAll('.box')).filter((b) => b.getBoundingClientRect().width > 0).length);
  const waitFor = async (fn, what, ms) => { const t0 = Date.now(); for (;;) { if (await fn()) return; if (Date.now() - t0 > (ms || 6000)) throw new Error('等不到：' + what); await page.waitForTimeout(60); } };
  const log = () => page.evaluate(() => window.__nativeLog.map((x) => x[0]));
  const boxes = () => page.evaluate(() => Array.from(window.__mgtlRoot.querySelectorAll('.box')).map((b) => { const r = b.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width }; }).filter((b) => b.w > 0));
  const hostVisAtCapture = () => page.evaluate(() => window.__nativeLog.filter((x) => x[0] === 'capture').map((x) => x[1]));
  return { context, page, errors, reqs, ctl, find, tap, menuOn, toast, openMenu, tapMenu, boxCount, boxes, hostVisAtCapture, waitFor, log };
}

async function scenario(browser, url, label) {
  console.log(label);
  // ---- 还没填 Key ----
  let s = await open(browser, url, false);
  assert.deepStrictEqual(await s.page.evaluate(() => [window.__mgtlMode, document.getElementById('mgtl-host').shadowRoot]), ['closed', null]);
  ok('界面在 closed 的 shadow DOM 里（和手机上一致）');
  await s.tapMenu('翻译屏幕上的图片');
  await s.waitFor(async () => (await s.log()).includes('openKeySettings'), '点「翻译屏幕上的图片」后弹出 Key 设置');
  assert.strictEqual(await s.menuOn(), false);
  assert.ok((await s.toast()).includes('先填好'), await s.toast());
  ok('没填 Key：点「翻译屏幕上的图片」有反应（提示先填 Key，并让 App 弹出设置窗口）');
  await s.context.close();

  // ---- 已经填好 Key ----
  s = await open(browser, url, true);
  await s.tapMenu('翻译屏幕上的图片');
  await s.waitFor(async () => (await s.toast()).includes('开始翻译'), '出现「开始翻译 N 张图片」');
  await s.waitFor(async () => (await s.boxCount()) >= 2, '译文出现在图片上', 15000);
  assert.strictEqual(await s.menuOn(), false);
  assert.ok(s.reqs.some((r) => r.toAi));
  await s.page.screenshot({ path: `${SHOTS}/tap-${label.includes('接管') ? 'hostile' : 'normal'}-translated.png` });
  ok('点「翻译屏幕上的图片」：开始翻译，译文盖到图片上');

  await s.openMenu();
  assert.ok(await s.find('.menu div', '看原图'), '有译文后菜单里应出现「看原图」');
  await s.tap('.menu div', '看原图');
  await s.waitFor(async () => (await s.boxCount()) === 0, '译文被隐藏');
  await s.tapMenu('显示译文');
  await s.waitFor(async () => (await s.boxCount()) >= 2, '译文重新显示');
  ok('「看原图 / 显示译文」可以来回切换');

  await s.tapMenu('自动翻译本网站');
  await s.waitFor(async () => (await s.toast()).includes('已开启'), '出现「已开启」提示');
  await s.openMenu();
  assert.ok(await s.find('.menu div', '自动翻译本网站：开'), '菜单应显示「自动翻译本网站：开」');
  ok('点「自动翻译本网站」：真的开启了，菜单显示变成「开」');

  // 菜单开着时再点一下「译」→ 收起
  await s.tap('.fab');
  await s.page.waitForTimeout(150);
  assert.strictEqual(await s.menuOn(), false);
  // 菜单开着时点网页别处 → 收起
  await s.openMenu();
  await s.page.touchscreen.tap(60, 60);
  await s.page.waitForTimeout(150);
  assert.strictEqual(await s.menuOn(), false);
  ok('菜单开着时，再点「译」或点网页别处都会收起');

  await s.tapMenu('设置');
  await s.waitFor(async () => !!(await s.find('.mask.on .dlg')), '设置面板打开');
  await s.page.waitForTimeout(500); // 如果有"幽灵点击"落到面板上，这段时间内会表现出来
  assert.ok(await s.find('.mask.on .dlg'), '设置面板应保持打开');
  await s.tap('.dlg .btn', '完成');
  await s.waitFor(async () => !(await s.find('.mask.on .dlg')), '设置面板关闭');
  ok('点「设置」打开设置面板，点「完成」关闭');

  await s.tapMenu('清除本页译文');
  await s.waitFor(async () => (await s.boxCount()) === 0, '译文被清除');
  ok('点「清除本页译文」：译文消失');

  await s.tapMenu('在这个网站隐藏按钮');
  await s.waitFor(async () => (await s.page.evaluate(() => getComputedStyle(document.getElementById('mgtl-host')).display)) === 'none', '按钮被隐藏');
  ok('点「在这个网站隐藏按钮」：按钮消失');
  assert.deepStrictEqual(s.errors, []);
  await s.context.close();
}

// 找不到图片元素的阅读器：整屏截图翻译
async function screenScenario(browser) {
  console.log('【漫画不是普通图片的阅读器（脚本找不到图片元素）】');
  let s = await open(browser, 'http://localhost:8801/tiles.html', true);
  const VW = 390, VH = 844;
  const expectAt = [{ x: 0.31 * VW, y: 0.16 * VH }, { x: 0.7 * VW, y: 0.68 * VH }];
  const aligned = async () => { const bs = await s.boxes(); return bs.length === 2 && expectAt.every((e) => bs.some((b) => Math.abs(b.cx - e.x) < 3 && Math.abs(b.cy - e.y) < 3)); };

  await s.tapMenu('翻译屏幕上的图片');
  await s.waitFor(async () => (await s.toast()).includes('整个屏幕'), '提示改为整屏翻译');
  await s.waitFor(aligned, '整屏译文出现在屏幕的对应位置', 15000);
  assert.deepStrictEqual(await s.hostVisAtCapture(), ['hidden']);
  await s.page.screenshot({ path: `${SHOTS}/tap-screen-mode.png` });
  ok('找不到图片时自动改为截屏翻译整个屏幕，译文盖在屏幕上对应的位置；截屏时我们自己的按钮是藏起来的');

  await s.openMenu();
  assert.strictEqual(await s.boxCount(), 2);
  await s.tap('.fab');
  await s.page.waitForTimeout(200);
  assert.strictEqual(await s.boxCount(), 2);
  ok('点我们自己的按钮和菜单，不会把整屏译文弄没');

  await s.page.touchscreen.tap(60, 400);
  await s.waitFor(async () => (await s.boxCount()) === 0, '碰网页后译文撤掉');
  ok('碰一下网页（翻页）后，整屏译文自动撤掉，不会盖在下一页上');

  await s.tapMenu('翻译整个屏幕');
  await s.waitFor(aligned, '菜单里的「翻译整个屏幕」生效', 15000);
  await s.page.evaluate(() => window.scrollTo(0, 300));
  await s.waitFor(async () => (await s.boxCount()) === 0, '滚动后译文撤掉');
  await s.page.evaluate(() => window.scrollTo(0, 0));
  ok('菜单里的「翻译整个屏幕」可用；网页一滚动译文就撤掉');

  s.ctl.delay = 1500;
  await s.tapMenu('翻译整个屏幕');
  await s.page.waitForTimeout(700);
  await s.page.touchscreen.tap(60, 400);
  await s.waitFor(async () => (await s.toast()).includes('已取消'), '翻译途中碰网页会提示已取消');
  await s.page.waitForTimeout(1800);
  assert.strictEqual(await s.boxCount(), 0);
  s.ctl.delay = 150;
  ok('翻译途中翻了页：这次结果作废并提示，不会把旧译文盖到新页面上');
  assert.deepStrictEqual(s.errors, []);
  await s.context.close();

  // 普通网页上：按图片翻译和整屏翻译不会叠在一起
  s = await open(browser, 'http://localhost:8801/test.html', true);
  await s.tapMenu('翻译屏幕上的图片');
  await s.waitFor(async () => (await s.boxCount()) >= 2, '按图片翻译', 15000);
  assert.deepStrictEqual(await s.hostVisAtCapture(), []);
  await s.tapMenu('翻译整个屏幕');
  await s.waitFor(aligned, '只剩整屏的两条译文', 15000);
  await s.tapMenu('翻译屏幕上的图片');
  await s.waitFor(async () => (await s.toast()).includes('开始翻译'), '重新按图片翻译');
  await s.waitFor(async () => { const bs = await s.boxes(); return bs.length >= 2 && !(await aligned()); }, '整屏译文被按图片的译文取代', 15000);
  ok('普通网页上读得到图片时不截屏；两种翻译方式互相取代，不会叠在一起');
  assert.deepStrictEqual(s.errors, []);
  await s.context.close();
}

// 翻页式、图片读不到的阅读器 + 自动翻译（整屏方式）
async function autoScenario(browser) {
  console.log('【翻页式阅读器，图片读不到内容：自动翻译（整屏方式）】');
  const VW = 390, VH = 844;
  const expectAt = [{ x: 0.31 * VW, y: 0.16 * VH }, { x: 0.7 * VW, y: 0.68 * VH }];
  let s = await open(browser, 'http://localhost:8801/reader.html', true);
  const aligned = async () => { const bs = await s.boxes(); return bs.length === 2 && expectAt.every((e) => bs.some((b) => Math.abs(b.cx - e.x) < 3 && Math.abs(b.cy - e.y) < 3)); };
  const ai = () => s.reqs.filter((r) => r.toAi).length;
  const caps = () => s.page.evaluate(() => window.__nativeLog.filter((x) => x[0] === 'capture').map((x) => ({ vis: x[1], t: x[2] })));
  const hostVisible = () => s.page.evaluate(() => getComputedStyle(document.getElementById('mgtl-host')).visibility === 'visible');
  const watchNoBlink = async (ms) => { for (let t = 0; t < ms; t += 50) { assert.strictEqual(await hostVisible(), true, '界面被藏起来了一下（闪）'); await s.page.waitForTimeout(50); } };

  await s.tapMenu('自动翻译本网站');
  await s.waitFor(aligned, '开启自动后，读不到的页面自动整屏翻译', 15000);
  assert.strictEqual(ai(), 1);
  assert.strictEqual((await caps()).filter((c) => c.vis === 'hidden').length, 1);
  assert.strictEqual(await s.page.evaluate(() => window.__mgtlRoot.querySelectorAll('.badge.error').length), 0);
  ok('开启自动翻译：发现图片读不到，自动改用整屏方式翻译当前这一页（没有报错气泡）');

  const c0 = (await caps()).length;
  await watchNoBlink(4000);
  assert.strictEqual(ai(), 1);
  assert.strictEqual((await caps()).length, c0);
  assert.strictEqual(await aligned(), true);
  ok('译文显示着的 4 秒里：界面一次都没有闪，没有再截屏，也没有重复调用 AI');

  // 翻页：点一下网页，新图片 0.35 秒后才画出来
  await s.page.touchscreen.tap(150, 300);
  await s.waitFor(async () => (await s.boxCount()) === 0, '翻页时旧译文马上撤掉');
  await s.waitFor(async () => ai() === 2 && (await aligned()), '翻页后自动翻译新的一页', 15000);
  const drawn = await s.page.evaluate(() => window.drawnAt);
  const lastHidden = (await caps()).filter((c) => c.vis === 'hidden').pop();
  assert.ok(lastHidden.t > drawn, '用来翻译的截屏必须是新一页画出来之后拍的');
  assert.strictEqual((await caps()).filter((c) => c.vis === 'hidden').length, 2);
  ok('翻页后：旧译文立刻撤掉，等新一页画出来、画面停稳后才截屏翻译（每页只藏一次界面、只调用一次 AI）');

  // 翻回第 1 页（看过的画面）
  await s.page.touchscreen.tap(150, 300);
  await s.waitFor(async () => (await s.boxCount()) === 0, '翻页时旧译文撤掉');
  await s.waitFor(aligned, '看过的页面，译文直接恢复', 15000);
  await s.page.waitForTimeout(800);
  assert.strictEqual(ai(), 2);
  ok('回到看过的那一页：直接恢复上次的译文，不再调用 AI');

  // 点我们自己的按钮不算"碰了网页"
  await s.openMenu();
  await s.tap('.fab');
  await s.page.waitForTimeout(1500);
  assert.strictEqual(await aligned(), true);
  assert.strictEqual(ai(), 2);
  ok('点「译」按钮和菜单不会触发重新翻译');

  // 关掉自动后翻页：不再自动翻译
  await s.tapMenu('自动翻译本网站');
  await s.waitFor(async () => (await s.toast()).includes('已关闭'), '关闭自动翻译');
  await s.page.touchscreen.tap(150, 300);
  await s.page.waitForTimeout(3000);
  assert.strictEqual(await s.boxCount(), 0);
  assert.strictEqual(ai(), 2);
  // 这时手动点「翻译屏幕上的图片」：直接整屏翻译
  await s.tapMenu('翻译屏幕上的图片');
  await s.waitFor(async () => ai() === 3 && (await aligned()), '手动翻译读不到的页面', 15000);
  assert.strictEqual(await s.page.evaluate(() => window.__mgtlRoot.querySelectorAll('.badge.error').length), 0);
  ok('关掉自动后翻页不再自动翻译；手动点「翻译屏幕上的图片」直接整屏翻译，不报「请滚动到屏幕中间」的错');
  assert.deepStrictEqual(s.errors, []);
  await s.context.close();

  // 没开自动、第一次手动翻译读不到的页面
  s = await open(browser, 'http://localhost:8801/reader.html', true);
  await s.tapMenu('翻译屏幕上的图片');
  await s.waitFor(async () => (await s.toast()).includes('读不到'), '提示图片读不到、改为整屏');
  await s.waitFor(async () => { const bs = await s.boxes(); return bs.length === 2 && expectAt.every((e) => bs.some((b) => Math.abs(b.cx - e.x) < 3 && Math.abs(b.cy - e.y) < 3)); }, '整屏译文', 15000);
  assert.strictEqual(s.reqs.filter((r) => r.toAi).length, 1);
  ok('没开自动时，手动翻译读不到的页面：自动改为整屏翻译，只调用一次 AI');
  assert.deepStrictEqual(s.errors, []);
  await s.context.close();

  console.log('【画面一直在动、又没有文字的页面：不会无休止地花额度】');
  s = await open(browser, 'http://localhost:8801/anim.html', true);
  s.ctl.empty = true;
  const ai2 = () => s.reqs.filter((r) => r.toAi).length;
  await s.tapMenu('自动翻译本网站');
  await s.waitFor(async () => ai2() >= 3, '自动翻译用完 3 次机会', 45000);
  await s.page.waitForTimeout(12000);
  assert.strictEqual(ai2(), 3, '没人碰网页时最多自动翻译 3 次');
  const capN = await s.page.evaluate(() => window.__nativeLog.length);
  await s.page.waitForTimeout(3000);
  assert.strictEqual(await s.page.evaluate(() => window.__nativeLog.length), capN, '停下之后不应再截屏');
  ok('画面一直在变又翻不出文字时：最多自动试 3 次就停，之后不再调用 AI、也不再截屏');
  await s.page.touchscreen.tap(150, 300);
  await s.waitFor(async () => ai2() >= 4, '碰一下网页后恢复自动翻译', 20000);
  ok('你再碰一下网页，自动翻译才会重新开始');
  assert.deepStrictEqual(s.errors, []);
  await s.context.close();
}

// 读得到内容的翻页式阅读器：同一块画布反复重画
async function canvasScenario(browser) {
  console.log('【翻页式阅读器，图片读得到（同一块画布反复重画）】');
  let s = await open(browser, 'http://localhost:8801/reader2.html', true);
  const ai = () => s.reqs.filter((r) => r.toAi).length;
  const capN = () => s.page.evaluate(() => window.__nativeLog.filter((x) => x[0] === 'capture').length);
  const onCanvas = async () => {
    const r = await s.page.evaluate(() => { const b = document.getElementById('cv').getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; });
    const want = [{ x: r.l + 0.31 * r.w, y: r.t + 0.16 * r.h }, { x: r.l + 0.7 * r.w, y: r.t + 0.68 * r.h }];
    const bs = await s.boxes();
    return bs.length === 2 && want.every((e) => bs.some((b) => Math.abs(b.cx - e.x) < 3 && Math.abs(b.cy - e.y) < 3));
  };
  await s.tapMenu('自动翻译本网站');
  await s.waitFor(onCanvas, '自动翻译画布上的这一页', 15000);
  await s.page.waitForTimeout(3000);
  assert.strictEqual(ai(), 1);
  assert.strictEqual(await capN(), 0);
  ok('图片读得到时按图片翻译：不截屏，译文盖在图片上，停着不动时不重复调用 AI');
  await s.page.touchscreen.tap(150, 300);
  await s.waitFor(async () => (await s.boxCount()) === 0, '翻页后旧译文撤掉', 4000);
  await s.waitFor(async () => ai() === 2 && (await onCanvas()), '翻页后自动翻译新的一页', 15000);
  await s.page.waitForTimeout(2500);
  assert.strictEqual(ai(), 2);
  assert.strictEqual(await capN(), 0);
  ok('翻页（画布重画）后：旧译文自动撤掉，新的一页自动翻译一次');
  assert.deepStrictEqual(s.errors, []);
  await s.context.close();

  console.log('【画布内容自己不停在变：不会无休止地花额度（按图片方式）】');
  s = await open(browser, 'http://localhost:8801/anim2.html', true);
  const ai2 = () => s.reqs.filter((r) => r.toAi).length;
  await s.tapMenu('自动翻译本网站');
  await s.page.waitForTimeout(32000);
  const n1 = ai2();
  assert.ok(n1 >= 2 && n1 <= 13, '没人碰网页时自动翻译应在 12 次左右停下，实际 ' + n1);
  await s.page.waitForTimeout(6000);
  assert.strictEqual(ai2(), n1, '停下之后不应再调用 AI');
  ok(`网页自己不停换内容时：自动翻译了 ${n1} 次就停下，不会一直重复花额度`);
  assert.deepStrictEqual(s.errors, []);
  await s.context.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  let failed = null;
  try {
    console.log('脚本：' + US);
    if (!ONLY || ONLY === 'tap') await scenario(browser, 'http://localhost:8801/test.html', '【普通网页】');
    if (!ONLY || ONLY === 'tap') await scenario(browser, 'http://localhost:8801/hostile.html', '【阅读器接管了触摸手势的网页（浏览器不再产生 click）】');
    if (!process.env.EXPECT_BROKEN && (!ONLY || ONLY === 'screen')) await screenScenario(browser);
    if (!process.env.EXPECT_BROKEN && (!ONLY || ONLY === 'auto')) await autoScenario(browser);
    if (!process.env.EXPECT_BROKEN && (!ONLY || ONLY === 'canvas')) await canvasScenario(browser);
  } catch (e) {
    failed = e;
  } finally {
    await browser.close();
  }
  if (process.env.EXPECT_BROKEN) {
    if (!failed) { console.log('预期旧版会失败，但它通过了 —— 说明没有复现出问题'); process.exit(1); }
    console.log('  ✗ ' + failed.message.split('\n')[0]);
    console.log(`REPRODUCED（旧版在第 ${n + 1} 项失败）`);
    return;
  }
  if (failed) { console.error('TAP FAILED:', failed); process.exit(1); }
  console.log(`TAP ALL ${n} CHECKS PASSED`);
})();
