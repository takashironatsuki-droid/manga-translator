const $ = (id) => document.getElementById(id);

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// 给当前页面发指令；如果页面里还没有加载插件脚本（比如安装前就打开的页面），先注入一次
async function ask(msg) {
  const tab = await activeTab();
  if (!tab || tab.id == null) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['defaults.js', 'content.js']
      });
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e2) {
      return null;
    }
  }
}

async function refresh() {
  const res = await ask({ type: 'mgtl-count' });
  if (!res) {
    $('status').textContent = '这个页面不能使用插件（浏览器内部页面或应用商店页面）。';
    $('all').disabled = true;
    $('clear').disabled = true;
    return;
  }
  $('status').textContent = res.count > 0 ? `本页找到 ${res.count} 张还没翻译的图片` : '本页没有找到待翻译的图片（图片还没加载的话，往下滚动后再试）';
  $('all').textContent = res.count > 0 ? `翻译本页所有图片（${res.count} 张）` : '翻译本页所有图片';
  $('all').disabled = res.count === 0;
}

(async () => {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  const cfg = await chrome.storage.local.get(MGTL_DEFAULTS);
  const isLocal = /localhost|127\.0\.0\.1/.test(cfg.baseUrl || '');
  const ready = !!cfg.model && (!!cfg.apiKey || isLocal);
  if (!ready) $('warn').style.display = 'block';
  $('hover').checked = !!cfg.hoverButton;

  $('hover').addEventListener('change', () => chrome.storage.local.set({ hoverButton: $('hover').checked }));
  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('all').addEventListener('click', async () => {
    if (!ready) {
      chrome.runtime.openOptionsPage();
      return;
    }
    $('all').disabled = true;
    const res = await ask({ type: 'mgtl-translate-all' });
    $('status').textContent = res && res.count ? `已开始翻译 ${res.count} 张图片，可以关掉这个小窗口。` : '没有找到待翻译的图片。';
  });
  $('clear').addEventListener('click', async () => {
    await ask({ type: 'mgtl-clear' });
    refresh();
  });

  const a = await ask({ type: 'mgtl-auto-get' });
  if (a) $('auto').checked = !!a.on;
  else $('auto').disabled = true;
  $('auto').addEventListener('change', async () => {
    if ($('auto').checked && !ready) {
      $('auto').checked = false;
      chrome.runtime.openOptionsPage();
      return;
    }
    await ask({ type: 'mgtl-auto-set', on: $('auto').checked });
  });

  refresh();
})();
