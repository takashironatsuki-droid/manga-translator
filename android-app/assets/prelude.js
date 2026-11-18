// App 和网页脚本之间的桥：把脚本需要的"保存设置""跨域请求""截屏"接到 App 的原生功能上。
// 这段代码和 userscript.js 会被 App 包在同一个函数里注入网页，__MGTL_TOKEN 由 App 提供。
var __mgtlApp = (function () {
  var N = window.MgtlNative;
  if (!N) return null;
  var T = __MGTL_TOKEN;
  var cbs = {};
  var seq = 0;
  var app = { onNativeEvent: null };

  // App 处理完请求后，会调用这个函数把结果送回来
  window.__mgtlCb = function (id, res) {
    if (id === 'event') {
      try {
        if (app.onNativeEvent) app.onNativeEvent(res);
      } catch (e) {}
      return;
    }
    var f = cbs[id];
    if (!f) return;
    delete cbs[id];
    try {
      f(res || {});
    } catch (e) {}
  };

  app.getValue = function (k, d) {
    try {
      var v = N.getValue(T, String(k));
      return v === null || v === undefined || v === '' ? d : v;
    } catch (e) {
      return d;
    }
  };

  app.setValue = function (k, v) {
    try {
      N.setValue(T, String(k), String(v));
    } catch (e) {}
  };

  app.request = function (d) {
    var id = 'r' + ++seq;
    var timeout = Number(d.timeout) || 60000;
    var timer = setTimeout(function () {
      if (!cbs[id]) return;
      delete cbs[id];
      if (d.ontimeout) d.ontimeout({});
    }, timeout + 5000);
    cbs[id] = function (r) {
      clearTimeout(timer);
      if (r.error === 'timeout') {
        if (d.ontimeout) d.ontimeout({});
        return;
      }
      if (r.error) {
        if (d.onerror) d.onerror({ error: r.error });
        return;
      }
      var out = { status: r.status, responseHeaders: r.headers || '', responseText: r.text || '', response: r.text || '' };
      if (d.responseType === 'arraybuffer') {
        var bin = atob(r.b64 || '');
        var a = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        out.response = a.buffer;
        out.responseText = undefined;
      }
      if (d.onload) d.onload(out);
    };
    try {
      N.request(T, id, String(d.method || 'GET'), String(d.url), JSON.stringify(d.headers || {}), d.data == null ? '' : String(d.data), String(d.responseType || ''), Math.round(timeout));
    } catch (e) {
      clearTimeout(timer);
      delete cbs[id];
      if (d.onerror) d.onerror({});
    }
  };

  // 截取 App 里网页区域当前显示的画面，返回 JPEG 的 base64
  app.capture = function () {
    return new Promise(function (resolve, reject) {
      var id = 'c' + ++seq;
      var timer = setTimeout(function () {
        if (!cbs[id]) return;
        delete cbs[id];
        reject(new Error('截屏超时'));
      }, 8000);
      cbs[id] = function (r) {
        clearTimeout(timer);
        if (r && r.b64) resolve(r.b64);
        else reject(new Error('截屏失败' + (r && r.error ? '：' + r.error : '')));
      };
      try {
        N.capture(T, id);
      } catch (e) {
        clearTimeout(timer);
        delete cbs[id];
        reject(new Error('截屏失败'));
      }
    });
  };

  app.openKeySettings = function () {
    try {
      N.openKeySettings(T);
    } catch (e) {}
  };

  return app;
})();
var GM_getValue = __mgtlApp ? __mgtlApp.getValue : undefined;
var GM_setValue = __mgtlApp ? __mgtlApp.setValue : undefined;
var GM_xmlhttpRequest = __mgtlApp ? __mgtlApp.request : undefined;
