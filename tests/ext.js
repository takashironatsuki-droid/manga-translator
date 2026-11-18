// 桌面插件的内容脚本检查：用假的 chrome 接口把 content.js 跑起来
const __ROOT = require('path').resolve(__dirname, '..'); // 仓库根目录
require('fs').mkdirSync(__ROOT + '/tests/shots', { recursive: true });
const { chromium } = require('playwright');
const assert = require('assert');
const DIR = __ROOT + '/chrome-extension/';
let slow = false;
const LONG = '你好！今天过得怎么样？我刚刚从很远的地方回来，有好多话想跟你说，你现在有空吗？';
const ITEMS = [
  { x: 0.1, y: 0.08, w: 0.42, h: 0.16, text: LONG, src: '', dark: false, hasBox: true },
  { x: 0.48, y: 0.6, w: 0.44, h: 0.16, text: '我们走吧！', src: '', dark: true, hasBox: true }
];
const STUB = `
  (() => {
    const stored = {}; const changeL = []; let onMsg = null;
    const c = {
      storage: {
        local: {
          get: async (d) => Object.assign({}, d, stored),
          set: async (o) => { const ch = {}; for (const k in o) { stored[k] = o[k]; ch[k] = { newValue: o[k] }; } changeL.forEach((f) => f(ch, 'local')); }
        },
        onChanged: { addListener: (f) => changeL.push(f) }
      },
      runtime: {
        sendMessage: async (m) => window.__extMsg(m),
        onMessage: { addListener: (f) => { window.__onMsg = f; } },
        connect: () => {
          const ml = [];
          return {
            onMessage: { addListener: (f) => ml.push(f) }, onDisconnect: { addListener: () => {} }, disconnect: () => {},
            postMessage: (m) => { if (m.type === 'start') window.__extTranslate(m.width, m.height).then((items) => ml.forEach((f) => f({ type: 'result', ok: true, items }))); }
          };
        }
      }
    };
    Object.defineProperty(window, 'chrome', { value: c, configurable: true, writable: true });
  })();
`;
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 500, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('__extTranslate', async () => { await new Promise((r) => setTimeout(r, slow ? 1800 : 200)); return ITEMS; });
  await page.exposeFunction('__extMsg', async (m) => {
    if (m.type === 'mgtl-fetch-image') { const r = await fetch(m.url); const b = Buffer.from(await r.arrayBuffer()); return { ok: true, dataUrl: 'data:image/png;base64,' + b.toString('base64') }; }
    return { ok: false, error: 'unsupported in test' };
  });
  await page.addInitScript(STUB);
  await page.goto('http://localhost:8801/test.html', { waitUntil: 'load' });
  await page.addScriptTag({ path: DIR + 'defaults.js' });
  await page.addScriptTag({ path: DIR + 'content.js' });
  const boxes = () => page.evaluate(() => Array.from(document.getElementById('mgtl-host').shadowRoot.querySelectorAll('.box')).map((b) => { const r = b.getBoundingClientRect(); const s = b.firstElementChild; return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, font: parseFloat(b.style.fontSize), minH: parseFloat(b.style.minHeight), spanH: s.offsetHeight, vis: r.width > 0 }; }));
  const rectOf = (id) => page.evaluate((i) => { const r = document.getElementById(i).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; }, id);
  const fitOk = (b) => b.spanH <= b.minH - 4 + 0.6 || b.font === 8;
  const onLocal = async () => { const r = await rectOf('local'); return (await boxes()).filter((b) => b.vis && b.cy > r.top && b.cy < r.top + r.height); };

  // 1. 鼠标移到图上 → 点「译」→ 译文对齐、字号合适
  const r0 = await rectOf('local');
  await page.mouse.move(r0.left + 200, r0.top + 300);
  await page.locator('#mgtl-host .btns.on').waitFor({ timeout: 5000 });
  await page.locator('#mgtl-host .btns button').first().click();
  await page.waitForFunction(() => document.getElementById('mgtl-host').shadowRoot.querySelectorAll('.box').length >= 2, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  let bs = await onLocal();
  assert.strictEqual(bs.length, 2);
  const a = bs.find((b) => Math.abs(b.cx - (r0.left + 0.31 * r0.width)) < 2.5 && Math.abs(b.cy - (r0.top + 0.16 * r0.height)) < 2.5);
  assert.ok(a, 'box A aligned');
  assert.ok(bs.every(fitOk), 'baseline fit ' + JSON.stringify(bs));
  const goodFont = a.font;
  assert.ok(goodFont < 31, 'long text should be shrunk below the max font, got ' + goodFont);
  console.log('  ✓ 点「译」后译文对齐，长句字号自动缩小到 ' + goodFont + 'px');

  // 2. 翻译进行中就滚走，在屏幕外完成，再滚回来
  slow = true;
  await page.evaluate(() => window.__onMsg({ type: 'mgtl-clear' }, {}, () => {}));
  await page.waitForTimeout(1300); // 自动模式会重新开始翻译屏幕上的图（此时图在屏幕上）
  await page.evaluate(() => window.scrollTo(0, 3000));
  await page.waitForTimeout(3200);
  slow = false;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  bs = await onLocal();
  assert.strictEqual(bs.length, 2, 'boxes present after coming back: ' + JSON.stringify(bs));
  const bad = bs.filter((b) => !fitOk(b));
  if (bad.length) { console.log('  ✗ 滚回来后字号不对（文字撑出了气泡）：' + JSON.stringify(bad.map((b) => ({ font: b.font, textHeight: b.spanH, boxHeight: b.minH })))); process.exitCode = 2; }
  else { assert.ok(bs.some((b) => b.font === goodFont)); console.log('  ✓ 翻译没完成就滚走，回来后字号仍然正确（' + bs.map((b) => b.font).join(', ') + 'px）'); }
  assert.deepStrictEqual(errors, []);
  await browser.close();
})().catch((e) => { console.error('EXT TEST FAILED:', e.stack.split('\n').slice(0, 5).join('\n')); process.exit(1); });
