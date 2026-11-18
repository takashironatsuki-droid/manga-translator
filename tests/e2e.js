// 用手机尺寸的无头浏览器把脚本实际跑一遍（AI 接口用假数据代替）
const __ROOT = require('path').resolve(__dirname, '..'); // 仓库根目录
require('fs').mkdirSync(__ROOT + '/tests/shots', { recursive: true });
const { chromium } = require('playwright');
const assert = require('assert');
const SHOTS = __ROOT + '/tests/shots';
const US = __ROOT + '/userscript/manga-translator.user.js';
const PAGE = 'http://localhost:8801/test.html';

const calls = [];
let mode = 'ok';
const AI_ITEMS = [
  { box: [80, 100, 240, 520], src: '안녕하세요! 오늘 어때요?', text: '你好！今天过得怎么样？我刚刚从很远的地方回来，有好多话想跟你说，你现在有空吗？', dark: false },
  { box: [600, 480, 760, 920], src: '가자!', text: '我们走吧！', dark: true }
];

async function gmNode(d) {
  const rec = { t: Date.now(), url: d.url, method: d.method, auth: (d.headers && d.headers.Authorization) || '', effort: null };
  calls.push(rec);
  if (/\/chat\/completions$/.test(d.url)) {
    const body = JSON.parse(d.data);
    rec.effort = body.reasoning_effort || null;
    rec.thinking = body.thinking ? body.thinking.type : null;
    rec.model = body.model;
    const img = body.messages[0].content[1].image_url.url;
    if (!/^data:image\/jpeg;base64,/.test(img)) return { status: 400, text: '{"error":{"message":"no image"}}', headers: '' };
    rec.imgBytes = Math.round((img.length * 3) / 4);
    await new Promise((r) => setTimeout(r, mode === 'slow' ? 1800 : 250));
    if (mode === 'daily') return { status: 429, text: JSON.stringify({ error: { message: 'Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }), headers: '' };
    if (mode === 'reject_effort' && (body.reasoning_effort || body.thinking)) return { status: 400, text: '{"error":{"message":"Unknown name reasoning_effort"}}', headers: '' };
    const content = mode === 'thought' ? '<thought>Shape is [{"box":[1,2,3,4],"text":"x"}] ok</thought>\n```json\n' + JSON.stringify(AI_ITEMS) + '\n```' : JSON.stringify(AI_ITEMS);
    return { status: 200, text: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), headers: 'content-type: application/json\r\n' };
  }
  if (/\/models$/.test(d.url)) return { status: 200, text: JSON.stringify({ data: [{ id: 'models/gemini-3.5-flash-lite' }, { id: 'models/gemma-4-31b-it' }] }), headers: '' };
  try {
    const r = await fetch(d.url);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, b64: buf.toString('base64'), headers: 'content-type: ' + (r.headers.get('content-type') || '') + '\r\n' };
  } catch (e) {
    return { error: String(e) };
  }
}

const STUB = `
  { const _as = Element.prototype.attachShadow; Element.prototype.attachShadow = function (o) { return _as.call(this, Object.assign({}, o, { mode: 'open' })); }; }
  window.GM_getValue = (k, d) => { const v = localStorage.getItem('gm_' + k); return v == null ? d : v; };
  window.GM_setValue = (k, v) => localStorage.setItem('gm_' + k, v);
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = (d) => {
    window.__gmNode({ method: d.method, url: d.url, headers: d.headers, data: d.data, responseType: d.responseType }).then((r) => {
      if (r.error) { d.onerror && d.onerror({}); return; }
      let response = r.text;
      if (d.responseType === 'arraybuffer') { const bin = atob(r.b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); response = a.buffer; }
      d.onload && d.onload({ status: r.status, responseText: d.responseType ? undefined : r.text, response, responseHeaders: r.headers });
    });
  };
`;

let passed = 0;
const ok = (name) => {
  passed++;
  console.log('  ✓ ' + name);
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/CORS|net::ERR_FAILED|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
  });
  await page.exposeFunction('__gmNode', gmNode);
  await page.addInitScript(STUB);

  const H = '#mgtl-host ';
  const load = async () => {
    await page.goto(PAGE, { waitUntil: 'load' });
    await page.addScriptTag({ path: US });
    await page.waitForTimeout(300);
  };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const tapMenu = async (text) => {
    await page.locator(H + '.fab').tap();
    await page.locator(H + '.menu.on').waitFor();
    await page.locator(H + '.menu div', { hasText: text }).tap();
  };
  const q = (fn, arg) =>
    page.evaluate(
      ([src, a]) => {
        const host = document.getElementById('mgtl-host');
        return new Function('root', 'host', 'arg', 'return (' + src + ')(root, host, arg)')(host && host.shadowRoot, host, a);
      },
      [fn.toString(), arg]
    );
  const boxes = () =>
    q((root) =>
      Array.from(root.querySelectorAll('.box')).map((b) => {
        const r = b.getBoundingClientRect();
        const s = b.firstElementChild;
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, font: parseFloat(b.style.fontSize), minH: parseFloat(b.style.minHeight), spanH: s.offsetHeight, text: s.textContent, dark: b.classList.contains('dark'), vis: r.width > 0 };
      })
    );
  const rectOf = (id) =>
    page.evaluate((i) => {
      const r = document.getElementById(i).getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }, id);
  const waitBoxes = (n) => page.waitForFunction((k) => document.getElementById('mgtl-host').shadowRoot.querySelectorAll('.box').length >= k, n, { timeout: 20000 });
  const scrollTo = async (y) => {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(250);
  };
  // 检查某张图上的译文框是否对在预期位置（图里每一段有两个气泡）
  const aligned = async (id, segs, which) => {
    const r = await rectOf(id);
    const bs = (await boxes()).filter((b) => b.vis);
    for (let i = 0; i < segs; i++) {
      if (which && !which.includes(i)) continue;
      const exp = [
        { x: r.left + 0.31 * r.width, y: r.top + ((i + 0.16) / segs) * r.height, dark: false },
        { x: r.left + 0.7 * r.width, y: r.top + ((i + 0.68) / segs) * r.height, dark: true }
      ];
      for (const e of exp) {
        const hit = bs.find((b) => Math.abs(b.cx - e.x) < 2.5 && Math.abs(b.cy - e.y) < 2.5 && b.dark === e.dark);
        assert.ok(hit, `no box at expected spot for #${id} seg ${i} (${e.x.toFixed(1)},${e.y.toFixed(1)}); have ${JSON.stringify(bs.map((b) => [b.cx.toFixed(1), b.cy.toFixed(1)]))}`);
      }
    }
  };
  const chatCalls = () => calls.filter((c) => /chat\/completions/.test(c.url));

  // ---- 1. 悬浮按钮 ----
  await load();
  const fabBox = await page.locator(H + '.fab').boundingBox();
  assert.ok(fabBox && fabBox.x > 300 && fabBox.x + fabBox.width <= 390 && fabBox.y > 400 && fabBox.y < 800, 'fab position ' + JSON.stringify(fabBox));
  assert.strictEqual(fabBox.width, 46);
  await shot('01-fab');
  ok('悬浮按钮出现在屏幕右侧');

  // ---- 2. 菜单 ----
  await page.locator(H + '.fab').tap();
  await page.locator(H + '.menu.on').waitFor();
  const mb = await page.locator(H + '.menu').boundingBox();
  assert.ok(mb.x >= 0 && mb.x + mb.width <= 390 && mb.y >= 0 && mb.y + mb.height <= 844, 'menu inside viewport ' + JSON.stringify(mb));
  const labels = await page.locator(H + '.menu div').allTextContents();
  assert.deepStrictEqual(labels, ['翻译屏幕上的图片', '自动翻译本网站：关（点击开启）', '设置', '在这个网站隐藏按钮']);
  await shot('02-menu');
  ok('点按钮弹出菜单，菜单完整显示在屏幕内');

  // ---- 3. 没配置时点翻译 → 打开设置 ----
  await page.locator(H + '.menu div', { hasText: '翻译屏幕上的图片' }).tap();
  await page.locator(H + '.mask.on').waitFor();
  assert.strictEqual(await q((root) => root.querySelector('.toast').classList.contains('on')), true);
  assert.strictEqual(chatCalls().length, 0);
  await shot('03-settings');
  ok('没填 Key 时不会发请求，而是打开设置');

  // ---- 4. 填设置、获取模型、测试 ----
  await page.locator(H + '.dlg input[type=password]').fill('test-key-123');
  await page.locator(H + '.dlg input[type=number]').nth(0).fill('0');
  await page.locator(H + '.dlg .btn', { hasText: '获取列表' }).tap();
  await page.locator(H + '.dlg .res.ok').waitFor();
  const opts = await page.locator(H + '.dlg select').nth(1).locator('option').allTextContents();
  assert.deepStrictEqual(opts.slice(1), ['gemini-3.5-flash-lite', 'gemma-4-31b-it']);
  await page.locator(H + '.dlg .btn', { hasText: '测试' }).tap();
  await page.waitForFunction(() => /成功/.test(document.getElementById('mgtl-host').shadowRoot.querySelector('.res').textContent), null, { timeout: 15000 });
  const resText = await page.locator(H + '.dlg .res').textContent();
  assert.ok(/你好/.test(resText) && /位置信息也正常/.test(resText), resText);
  const c0 = chatCalls()[0];
  assert.strictEqual(c0.auth, 'Bearer test-key-123');
  assert.strictEqual(c0.model, 'gemini-3.5-flash-lite');
  assert.strictEqual(c0.effort, 'low');
  await page.locator(H + '.dlg .res').scrollIntoViewIfNeeded();
  await shot('04-settings-test-ok');

  // ---- 4b. 换成 DeepSeek：地址、模型、限速自动填好；请求里关掉思考模式 ----
  const fieldVals = () => q((root) => ({ url: root.querySelector('.dlg input[type=url]').value, model: root.querySelectorAll('.dlg .row2 input')[0].value, rpm: root.querySelectorAll('.dlg input[type=number]')[0].value }));
  await page.locator(H + '.dlg select').nth(0).selectOption('deepseek');
  assert.deepStrictEqual(await fieldVals(), { url: 'https://api.deepseek.com', model: 'deepseek-flash', rpm: '0' });
  await shot('04b-deepseek');
  const nDs = chatCalls().length;
  await page.locator(H + '.dlg .btn', { hasText: '测试' }).tap();
  await page.waitForFunction((k) => true, 0);
  const tDs = Date.now();
  while (chatCalls().length <= nDs && Date.now() - tDs < 10000) await page.waitForTimeout(100);
  await page.waitForFunction(() => /成功/.test(document.getElementById('mgtl-host').shadowRoot.querySelector('.res').textContent), null, { timeout: 15000 });
  const ds = chatCalls()[nDs];
  assert.strictEqual(ds.url, 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(ds.model, 'deepseek-flash');
  assert.strictEqual(ds.thinking, 'disabled');
  assert.strictEqual(ds.effort, null);
  assert.strictEqual(ds.auth, 'Bearer test-key-123');
  // 服务器不认这个参数时：去掉后重试，仍然成功
  mode = 'reject_effort';
  const nRej = chatCalls().length;
  await page.locator(H + '.dlg .btn', { hasText: '测试' }).tap();
  const tRej = Date.now();
  while (chatCalls().length < nRej + 2 && Date.now() - tRej < 10000) await page.waitForTimeout(100);
  await page.waitForFunction(() => /成功/.test(document.getElementById('mgtl-host').shadowRoot.querySelector('.res').textContent), null, { timeout: 15000 });
  assert.deepStrictEqual(chatCalls().slice(nRej).map((c) => c.thinking), ['disabled', null]);
  mode = 'ok';
  await page.locator(H + '.dlg select').nth(0).selectOption('openai');
  assert.deepStrictEqual(await fieldVals(), { url: 'https://api.openai.com/v1', model: '', rpm: '0' });
  await page.locator(H + '.dlg select').nth(0).selectOption('gemini');
  assert.deepStrictEqual(await fieldVals(), { url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite', rpm: '8' });
  await page.locator(H + '.dlg input[type=number]').nth(0).fill('0');
  ok('选 DeepSeek 会自动填好地址、模型和限速；请求里关掉了思考模式，服务器不认时能自动退回');
  await page.locator(H + '.dlg .btn', { hasText: '完成' }).tap();
  await page.waitForTimeout(200);
  assert.strictEqual(await q((root) => root.querySelector('.mask').classList.contains('on')), false);
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('gm_cfg')));
  assert.strictEqual(saved.apiKey, 'test-key-123');
  assert.strictEqual(saved.rpm, 0);
  ok('设置能保存；获取模型列表、测试都正常；请求带上了 Key 和模型');

  // ---- 5. 翻译屏幕上的图片（本站图 + 跨域图） ----
  const before = calls.length;
  const chat5 = chatCalls().length;
  await tapMenu('翻译屏幕上的图片');
  await waitBoxes(4);
  await page.waitForTimeout(200);
  await aligned('local', 1);
  await aligned('p1', 1);
  const dl = calls.slice(before).filter((c) => c.method === 'GET').map((c) => c.url);
  assert.deepStrictEqual(dl, ['http://127.0.0.1:8802/page1.png'], 'only the cross-origin image should need the GM download: ' + dl);
  assert.strictEqual(chatCalls().length - chat5, 2);
  await shot('05-overlay');
  ok('本站图片直接读取，跨域图片通过脚本管理器下载；译文框对在气泡位置上');

  // ---- 6. 滚动后译文跟着图片走 ----
  await scrollTo(300);
  await aligned('local', 1);
  await aligned('p1', 1);
  ok('滚动后译文仍然对齐');

  // ---- 7. 看原图 / 显示译文 ----
  await tapMenu('看原图');
  assert.strictEqual((await boxes()).length, 0);
  await tapMenu('显示译文');
  assert.strictEqual((await boxes()).length, 4);
  ok('可以暂时隐藏译文看原图，再切回来');

  // ---- 8. 自动翻译 ----
  const chat8 = chatCalls().length;
  await tapMenu('自动翻译本网站：关');
  await page.waitForFunction(() => document.getElementById('mgtl-host').shadowRoot.querySelector('.fab').classList.contains('auto'));
  // p2 和长条图在屏幕下方两屏以内，应当被自动翻译（长条图切成 4 段）
  await page.waitForFunction(() => document.getElementById('mgtl-host').shadowRoot.querySelectorAll('.layer').length >= 4, null, { timeout: 15000 });
  await page.waitForFunction((n) => window.__chat >= n, 0, { timeout: 1 }).catch(() => {});
  const t0 = Date.now();
  while (chatCalls().length < chat8 + 5 && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  assert.strictEqual(chatCalls().length - chat8, 5, 'p2 = 1 call, strip = 4 calls');
  await page.waitForTimeout(600);
  await scrollTo(1232);
  await waitBoxes(6);
  await aligned('p2', 1);
  const all1 = (await boxes()).filter((b) => b.vis);
  ok('开启自动翻译后，屏幕下方的图片不用点就开始翻译');

  // ---- 9. 屏幕外翻译完成的图，滚动到时字号也是量过的 ----
  const p1r = await rectOf('p1');
  const p2r = await rectOf('p2');
  await scrollTo(700);
  const mixed = (await boxes()).filter((b) => b.vis);
  const fontsAt = async (id) => {
    const r = await rectOf(id);
    return (await boxes()).filter((b) => b.vis && b.cy > r.top && b.cy < r.top + r.height).map((b) => b.font).sort();
  };
  const f1 = await fontsAt('p1');
  const f2 = await fontsAt('p2');
  assert.ok(f1.length === 2 && f2.length === 2, 'both visible: ' + JSON.stringify([f1, f2]));
  assert.deepStrictEqual(f2, f1, 'off-screen-completed image must get the same fitted font sizes');
  for (const b of mixed) assert.ok(b.spanH <= b.minH - 4 + 0.6 || b.font === 8, 'text fits its box: ' + JSON.stringify(b));
  assert.ok(mixed.every((b) => b.font >= 8 && b.font <= 24.4), 'font range ' + JSON.stringify(mixed.map((b) => b.font)));
  assert.ok(f1[0] < 24 && f1[1] === 24, 'long sentence shrunk, short one at full size: ' + JSON.stringify(f1));
  ok('译文字号自动适配气泡（包括在屏幕外翻译完的图）');

  // ---- 10. 长条图：4 段各自对齐 ----
  const sr = await page.evaluate(() => document.getElementById('strip').getBoundingClientRect().top + window.scrollY);
  for (let i = 0; i < 4; i++) {
    await scrollTo(sr + i * 609);
    await aligned('strip', 4, [i]);
  }
  await shot('06-strip');
  ok('长条图切成 4 段翻译，每段译文都对在自己的位置');

  // ---- 11. 再往下：p3 和画布自动翻译；小图不处理 ----
  await scrollTo(sr + 2437);
  await page.waitForFunction(() => document.getElementById('mgtl-host').shadowRoot.querySelectorAll('.layer').length >= 6, null, { timeout: 15000 });
  await scrollTo(sr + 2437 + 600);
  await page.waitForTimeout(1500);
  await aligned('p3', 1).catch(async () => {
    await scrollTo(sr + 2451);
    await aligned('p3', 1);
  });
  await page.evaluate(() => document.getElementById('cv').scrollIntoView());
  await page.waitForTimeout(1200);
  await aligned('cv', 1);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  assert.strictEqual(await q((root) => root.querySelectorAll('.layer').length), 6, 'small image must not get a layer');
  ok('画布（canvas）里的图也能翻译；小图不会被处理');

  // ---- 12. 「编号 + 底部列表」模式 ----
  await tapMenu('设置');
  await page.locator(H + '.mask.on').waitFor();
  await page.locator(H + '.dlg select').nth(3).selectOption('list');
  await page.locator(H + '.dlg .btn', { hasText: '完成' }).tap();
  await scrollTo(1232);
  await page.waitForFunction(() => document.getElementById('mgtl-host').shadowRoot.querySelector('.sheet').classList.contains('on'), null, { timeout: 5000 });
  const sheetInfo = await q((root) => ({ rows: Array.from(root.querySelectorAll('.sheet .row')).map((r) => r.textContent), nums: root.querySelectorAll('.num').length, boxes: root.querySelectorAll('.box').length, hd: root.querySelector('.sheet .hd').textContent }));
  assert.strictEqual(sheetInfo.boxes, 0);
  assert.ok(sheetInfo.nums >= 2, 'markers ' + sheetInfo.nums);
  assert.deepStrictEqual(sheetInfo.rows, ['1' + AI_ITEMS[0].text, '2我们走吧！']);
  await shot('07-list-mode');
  await page.locator(H + '.sheet .hd').tap();
  assert.strictEqual(await q((root) => root.querySelector('.sheet').classList.contains('min')), true);
  await page.locator(H + '.sheet .hd').tap();
  // 长条图里只列出屏幕上的那几句
  await scrollTo(sr + 609);
  await page.waitForTimeout(400);
  const stripRows = await q((root) => Array.from(root.querySelectorAll('.sheet .row b')).map((b) => b.textContent));
  assert.ok(stripRows.length >= 2 && stripRows.length <= 5 && stripRows.includes('3') && stripRows.includes('4'), 'strip sheet rows ' + stripRows);
  ok('列表模式：图上标编号，屏幕底部只列出当前屏幕上的那几句，可收起');

  // 切回覆盖模式
  await tapMenu('设置');
  await page.locator(H + '.dlg select').nth(3).selectOption('overlay');
  await page.locator(H + '.dlg .btn', { hasText: '完成' }).tap();
  await page.waitForTimeout(500);
  assert.strictEqual(await q((root) => root.querySelector('.sheet').classList.contains('on')), false, 'sheet must hide when leaving list mode');
  assert.strictEqual(await q((root) => root.querySelectorAll('.num').length), 0);
  ok('切回覆盖模式后，底部列表和编号都消失');

  // ---- 13. 当天额度用完 → 红色提示，点提示重试 ----
  await scrollTo(0);
  await tapMenu('清除本页译文');
  await page.waitForTimeout(400);
  assert.strictEqual(await q((root) => root.querySelectorAll('.layer').length), 0);
  assert.strictEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('gm_cfg'))).autoHosts.length, 0, 'clear turns auto off');
  mode = 'daily';
  const nDaily = chatCalls().length;
  await tapMenu('翻译屏幕上的图片');
  await page.locator(H + '.badge.error').first().waitFor({ timeout: 10000 });
  const errText = await page.locator(H + '.badge.error').first().textContent();
  assert.ok(/今天的免费额度已经用完了/.test(errText), errText);
  await page.waitForTimeout(600);
  assert.strictEqual(chatCalls().length - nDaily, 2, 'daily quota must not be retried');
  await shot('08-error');
  mode = 'ok';
  await page.locator(H + '.badge.error').first().tap();
  await waitBoxes(2);
  ok('额度用完时显示说明且不白白重试；点红色提示可以重试');

  // ---- 14. 模型不认 reasoning_effort / 模型先输出思考过程 ----
  await tapMenu('清除本页译文');
  mode = 'reject_effort';
  await tapMenu('翻译屏幕上的图片');
  await waitBoxes(4);
  await tapMenu('清除本页译文');
  mode = 'thought';
  await tapMenu('翻译屏幕上的图片');
  await waitBoxes(4);
  await aligned('local', 1);
  mode = 'ok';
  ok('不支持加速参数的模型、先输出思考过程的模型都能正常读出结果');

  // ---- 14b. 点了翻译后马上滚走，翻译在图片离开屏幕时完成，再滚回来 ----
  await tapMenu('清除本页译文');
  mode = 'slow';
  await tapMenu('翻译屏幕上的图片');
  await page.waitForTimeout(300);
  await scrollTo(2600);
  await page.waitForTimeout(2600);
  mode = 'ok';
  await scrollTo(0);
  await waitBoxes(4);
  await aligned('local', 1);
  const back = (await boxes()).filter((b) => b.vis);
  for (const b of back) assert.ok(b.spanH <= b.minH - 4 + 0.6 || b.font === 8, 'text fits after scroll-away: ' + JSON.stringify(b));
  assert.deepStrictEqual(back.filter((b) => b.cy < 620).map((b) => b.font).sort(), f1, 'same fitted sizes as an image translated on screen');
  ok('翻译还没完成就滚走，回来后译文大小和位置仍然正确');

  // ---- 15. 限速 ----
  await tapMenu('设置');
  await page.locator(H + '.dlg input[type=number]').nth(0).fill('120');
  await page.locator(H + '.dlg .btn', { hasText: '完成' }).tap();
  await page.waitForTimeout(700);
  await tapMenu('清除本页译文');
  const nRate = chatCalls().length;
  await tapMenu('翻译屏幕上的图片');
  await waitBoxes(4);
  const ts = chatCalls().slice(nRate).map((c) => c.t);
  assert.strictEqual(ts.length, 2);
  assert.ok(ts[1] - ts[0] >= 430, 'requests spaced by rate limit: ' + (ts[1] - ts[0]));
  ok('限速生效：两次请求之间按设定的间隔排开');

  // ---- 16. 点我们的界面不会触发网页自己的点击 ----
  assert.strictEqual(await page.evaluate(() => window.pageClicks), 0);
  ok('点按钮和菜单不会触发网页自己的点击事件（不会误翻页）');

  // ---- 17. 拖动按钮 ----
  const cdp = await context.newCDPSession(page);
  const fb = await page.locator(H + '.fab').boundingBox();
  const sx = fb.x + 23;
  const sy = fb.y + 23;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx - i * 35, y: sy - i * 40 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  const fb2 = await page.locator(H + '.fab').boundingBox();
  assert.ok(Math.abs(fb2.x - (fb.x - 280)) < 6 && Math.abs(fb2.y - (fb.y - 320)) < 6, 'fab moved ' + JSON.stringify([fb, fb2]));
  assert.strictEqual(await q((root) => root.querySelector('.menu').classList.contains('on')), false, 'drag must not open the menu');
  ok('按钮可以拖到别的位置，拖动时不会误开菜单');

  // ---- 18. 刷新后：设置、按钮位置、自动翻译都还在 ----
  await tapMenu('自动翻译本网站：关');
  await page.waitForTimeout(400);
  const nReload = chatCalls().length;
  await load();
  const fb3 = await page.locator(H + '.fab').boundingBox();
  assert.ok(Math.abs(fb3.x - fb2.x) < 3 && Math.abs(fb3.y - fb2.y) < 3, 'fab position persisted ' + JSON.stringify([fb2, fb3]));
  await waitBoxes(4);
  assert.ok(chatCalls().length > nReload);
  assert.strictEqual(await q((root) => root.querySelector('.fab').classList.contains('auto')), true);
  ok('刷新页面后设置都保留，开了自动的网站会自己开始翻译');

  // ---- 19. 在本网站隐藏 ----
  await tapMenu('在这个网站隐藏按钮');
  await page.waitForTimeout(300);
  assert.strictEqual(await q((root) => getComputedStyle(root.querySelector('.fab')).display), 'none');
  await shot('09-hide-toast');
  await page.waitForTimeout(5400);
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('mgtl-host')).display), 'none');
  await load();
  assert.strictEqual(await page.evaluate(() => !!document.getElementById('mgtl-host')), false);
  const nHidden = chatCalls().length;
  await page.waitForTimeout(1500);
  assert.strictEqual(chatCalls().length, nHidden);
  ok('隐藏后这个网站不再出现按钮，也不再发任何请求');

  assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join('\n'));
  ok('全程没有脚本报错');

  const sizes = chatCalls().map((c) => c.imgBytes).filter(Boolean);
  console.log(`ALL ${passed} CHECKS PASSED; chat calls=${chatCalls().length}; image upload sizes ${Math.min(...sizes)}–${Math.max(...sizes)} bytes`);
  await browser.close();
})().catch((e) => {
  console.error('E2E FAILED:', e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e);
  process.exit(1);
});
