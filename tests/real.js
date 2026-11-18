// 把插件真的装进 Chrome 里跑一遍：真实的设置页、真实的后台脚本、真实的 chrome.storage。
const __ROOT = require('path').resolve(__dirname, '..'); // 仓库根目录
require('fs').mkdirSync(__ROOT + '/tests/shots', { recursive: true });
// 只有 DeepSeek 的服务器是假的：把 api.deepseek.com 指到本机的模拟服务器，记录插件实际发出的请求。
const { chromium } = require('playwright');
const assert = require('assert');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EXT = __ROOT + '/chrome-extension';
const PORT = 8443;
const ITEMS = [
  { box: [80, 100, 240, 520], src: 'Bonjour, ça va ?', text: '你好，最近好吗？', dark: false },
  { box: [600, 480, 760, 920], src: 'On y va !', text: '我们走吧！', dark: true }
];

let n = 0;
const ok = (name) => console.log(`ok ${++n} - ${name}`);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgtl-real-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tmp + '/k.pem', '-out', tmp + '/c.pem', '-days', '2', '-subj', '/CN=api.deepseek.com', '-addext', 'subjectAltName=DNS:api.deepseek.com'], { stdio: 'ignore' });
  const reqs = [];
  let mode = 'ok';
  const server = https.createServer({ key: fs.readFileSync(tmp + '/k.pem'), cert: fs.readFileSync(tmp + '/c.pem') }, (req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch (e) {}
      reqs.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization, body });
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }, { id: 'deepseek-v4-pro', object: 'model' }] }));
        return;
      }
      if (req.url !== '/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      if (mode === 'nobalance') {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'unknown_error' } }));
        return;
      }
      const text = JSON.stringify(ITEMS);
      const d = (delta) => 'data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] }) + '\n\n';
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      res.write(': keep-alive\n\n');
      res.write(d({ role: 'assistant', content: '' }));
      const third = Math.ceil(text.length / 3);
      setTimeout(() => res.write(d({ content: text.slice(0, third) })), 60);
      setTimeout(() => res.write(d({ content: text.slice(third, third * 2) })), 120);
      setTimeout(() => {
        res.write(d({ content: text.slice(third * 2) }));
        res.end('data: [DONE]\n\n');
      }, 180);
    });
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const ctx = await chromium.launchPersistentContext(tmp + '/profile', {
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    viewport: { width: 1000, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${PORT}`, '--ignore-certificate-errors', '--no-proxy-server']
  });
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const id = new URL(sw.url()).host;
    const version = await sw.evaluate(() => chrome.runtime.getManifest().version);
    assert.strictEqual(version, '1.8.0');
    ok(`插件在 Chrome 里加载成功（版本 ${version}，后台脚本已启动）`);

    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('keyHint').innerHTML.length > 0);
    const val = (i) => page.evaluate((x) => document.getElementById(x).value, i);
    const waitResult = async (kind) => {
      try {
        await page.waitForFunction((k) => document.getElementById('result').className === k, kind, { timeout: 30000 });
      } catch (e) {
        const now = await page.evaluate(() => document.getElementById('result').className + ' | ' + document.getElementById('result').textContent);
        throw new Error(`等待结果「${kind}」超时，页面上显示的是：${now}；服务器收到 ${reqs.length} 个请求`);
      }
      return page.evaluate(() => document.getElementById('result').textContent);
    };

    // 先像老用户一样填一个 Gemini 的 Key
    await page.fill('#apiKey', 'GEMINI-KEY-MUST-NOT-LEAK');
    await page.fill('#model', 'gemini-3.5-flash-lite');
    await page.waitForTimeout(500);

    await page.selectOption('#preset', 'deepseek');
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('已切换到'));
    assert.deepStrictEqual([await val('baseUrl'), await val('apiKey'), await val('model'), await val('rpm')], ['https://api.deepseek.com', '', 'deepseek-flash', '0']);
    ok('设置页选 DeepSeek：地址、模型、限速自动填好，Key 留空');

    // 没填 Key 就点测试：应该提示去填 Key，并且不发任何请求
    await page.click('#testBtn');
    let text = await waitResult('err');
    assert.ok(text.includes('API Key'), text);
    assert.strictEqual(reqs.length, 0);
    ok('没填 Key 时点「测试」只提示填 Key，不会发出请求');

    await page.fill('#apiKey', 'sk-e2e-deepseek');
    await page.click('#testBtn');
    text = await waitResult('ok');
    assert.ok(text.startsWith('成功') && text.includes('你好，最近好吗？') && text.includes('位置信息也正常'), text);
    assert.strictEqual(reqs.length, 1);
    let r = reqs[0];
    assert.strictEqual(r.method, 'POST');
    assert.strictEqual(r.url, '/chat/completions');
    assert.strictEqual(r.host, 'api.deepseek.com');
    assert.strictEqual(r.auth, 'Bearer sk-e2e-deepseek');
    assert.strictEqual(r.body.model, 'deepseek-flash');
    assert.deepStrictEqual(r.body.thinking, { type: 'disabled' });
    assert.ok(!('reasoning_effort' in r.body));
    assert.strictEqual(r.body.stream, true);
    assert.ok(/^data:image\/jpeg;base64,/.test(r.body.messages[0].content[1].image_url.url));
    ok('点「测试」：真实后台向 api.deepseek.com/chat/completions 发出请求（Key 正确、deepseek-flash、已关闭思考、带图片），并显示成功');

    await page.click('#listBtn');
    text = await waitResult('ok');
    assert.ok(text.includes('找到 2 个模型'), text);
    assert.strictEqual(await val('model'), 'deepseek-flash');
    ok('「获取模型列表」可用，且不会改掉 deepseek-flash');

    mode = 'nobalance';
    await page.click('#testBtn');
    text = await waitResult('err');
    assert.ok(text.includes('余额不足') && text.includes('402'), text);
    mode = 'ok';
    ok('余额不足时显示中文提示');

    // 在真实网页上用插件翻译一张图
    const before = reqs.length;
    const manga = await ctx.newPage();
    manga.on('pageerror', (e) => errors.push(e.message));
    await manga.setViewportSize({ width: 500, height: 800 });
    await manga.goto('http://localhost:8801/test.html', { waitUntil: 'load' });
    const box = await manga.evaluate(() => {
      const r = document.getElementById('local').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await manga.mouse.move(box.x + box.w / 2, box.y + Math.min(box.h, 600) / 2);
    await manga.locator('#mgtl-host .btns.on').waitFor({ timeout: 10000 });
    await manga.locator('#mgtl-host .btns button').first().click();
    await manga.waitForFunction(() => document.getElementById('mgtl-host').shadowRoot.querySelectorAll('.box').length >= 2, null, { timeout: 30000 });
    const shown = await manga.evaluate(() => Array.from(document.getElementById('mgtl-host').shadowRoot.querySelectorAll('.box')).map((b) => b.textContent.trim()));
    assert.ok(shown.includes('你好，最近好吗？') && shown.includes('我们走吧！'), JSON.stringify(shown));
    const chat = reqs.slice(before).filter((q) => q.url === '/chat/completions');
    assert.ok(chat.length >= 1);
    for (const q of chat) {
      assert.strictEqual(q.host, 'api.deepseek.com');
      assert.strictEqual(q.auth, 'Bearer sk-e2e-deepseek');
      assert.deepStrictEqual(q.body.thinking, { type: 'disabled' });
    }
    ok(`在网页上点「译」：译文盖到了图片上（这张图发了 ${chat.length} 次请求，都带着关闭思考的参数）`);

    // 换回 Gemini，Key 要回来
    await page.bringToFront();
    await page.selectOption('#preset', 'gemini');
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('已切换到「Google Gemini」'));
    assert.deepStrictEqual([await val('apiKey'), await val('model'), await val('rpm')], ['GEMINI-KEY-MUST-NOT-LEAK', 'gemini-3.5-flash-lite', '8']);
    const stored = await sw.evaluate(() => chrome.storage.local.get(null));
    assert.strictEqual(stored.apiKey, 'GEMINI-KEY-MUST-NOT-LEAK');
    assert.ok(/googleapis\.com/.test(stored.baseUrl));
    assert.strictEqual(stored.profiles.deepseek.apiKey, 'sk-e2e-deepseek');
    ok('换回 Gemini：原来的 Key、模型、限速都恢复了，DeepSeek 的 Key 也被记住');

    for (const q of reqs) assert.ok(!String(q.auth || '').includes('GEMINI'), 'Gemini 的 Key 被发给了 DeepSeek');
    ok(`模拟的 DeepSeek 服务器一共收到 ${reqs.length} 个请求，没有一个带着 Gemini 的 Key`);
    assert.deepStrictEqual(errors, []);
    console.log(`REAL ALL ${n} CHECKS PASSED`);
  } finally {
    await ctx.close();
    server.close();
  }
})().catch((e) => {
  console.error('REAL FAILED:', e);
  process.exit(1);
});
