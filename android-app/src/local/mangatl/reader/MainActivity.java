package local.mangatl.reader;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.PixelCopy;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 漫画翻译：一个带翻译功能的简易浏览器。
 *
 * 结构：
 *  - 上面一条地址栏，下面一个 WebView 显示网页。
 *  - 每个网页加载后，把 assets 里的 prelude.js + userscript.js 注入进去，
 *    由它们在网页里画出「译」按钮、调用 AI、显示译文。
 *  - 网页脚本做不到的事（保存设置、跨域请求、截屏）通过下面的 Bridge 交给 App 来做。
 *  - API Key 只保存在 App 里：网页脚本拿到的只是一个占位符，真正的 Key 在发请求时由 App 填上，
 *    并且只会发给"AI 设置"里填的那个接口地址。
 */
public class MainActivity extends Activity {
    static final String HOME = "file:///android_asset/start.html";
    static final String DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
    static final String KEY_MARK = "@native";

    private SharedPreferences prefs;
    private LinearLayout root;
    private WebView web;
    private EditText urlBox;
    private ProgressBar bar;
    private String injectJs = "";
    private volatile String userAgent = "";
    private final String token = newToken();
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final Handler ui = new Handler(Looper.getMainLooper());

    // ------------------------------------------------------------------ 启动

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences("mgtl", MODE_PRIVATE);
        installCrashCatcher();
        try {
            getWindow().setStatusBarColor(0xFFE8590C);
        } catch (Throwable ignored) {
        }
        buildUi();
        injectJs = buildInjectJs();
        setupWeb();

        // 总是先打开自带的起始页（上次看的网址放在链接里，点一下就能继续），
        // 这样即使某个网页有问题，也不会一打开 App 就卡在那个网页上。
        String last = prefs.getString("lastUrl", "");
        String home = HOME;
        if (last.startsWith("http")) {
            try {
                home = HOME + "#" + URLEncoder.encode(last, "UTF-8");
            } catch (Exception ignored) {
            }
        }
        web.loadUrl(home);

        showLastCrashIfAny();
        if (prefs.getString("apiKey", "").isEmpty() && !prefs.getBoolean("keyAsked", false)) {
            prefs.edit().putBoolean("keyAsked", true).apply();
            ui.postDelayed(this::showKeyDialog, 700);
        }
    }

    private static String newToken() {
        byte[] b = new byte[18];
        new SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x & 0xff));
        return sb.toString();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    private String readAsset(String name) throws IOException {
        try (InputStream in = getAssets().open(name)) {
            return new String(readAll(in, 4 * 1024 * 1024), StandardCharsets.UTF_8);
        }
    }

    /** 把桥接脚本和翻译脚本包在一个函数里，这样它们用到的变量不会暴露给网页自己的脚本。 */
    private String buildInjectJs() {
        try {
            return "(function(){\nif(window.__mgtlInjected)return;window.__mgtlInjected=1;\nvar __MGTL_TOKEN="
                    + JSONObject.quote(token) + ";\n"
                    + readAsset("prelude.js") + "\n" + readAsset("userscript.js") + "\n})();";
        } catch (IOException e) {
            return "";
        }
    }

    // ------------------------------------------------------------------ 界面

    private void buildUi() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(0xFFFFFFFF);

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(2), dp(2), dp(2), dp(2));

        Button back = barButton("←", 22);
        back.setOnClickListener(v -> {
            if (web.canGoBack()) web.goBack();
        });

        urlBox = new EditText(this);
        urlBox.setSingleLine(true);
        urlBox.setHint("输入网址或要搜索的内容");
        urlBox.setTextSize(15);
        urlBox.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlBox.setImeOptions(EditorInfo.IME_ACTION_GO);
        urlBox.setSelectAllOnFocus(true);
        urlBox.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                go(urlBox.getText().toString());
                return true;
            }
            return false;
        });

        Button menu = barButton("菜单", 15);
        menu.setOnClickListener(this::showMenu);

        top.addView(back, new LinearLayout.LayoutParams(dp(46), dp(46)));
        top.addView(urlBox, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(menu, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(46)));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.INVISIBLE);

        web = new WebView(this);
        web.setBackgroundColor(0xFFFFFFFF);

        root.addView(top, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
    }

    private Button barButton(String text, int sp) {
        Button b = new Button(this, null, android.R.attr.borderlessButtonStyle);
        b.setText(text);
        b.setTextSize(sp);
        b.setAllCaps(false);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(10), 0, dp(10), 0);
        return b;
    }

    private void showMenu(View anchor) {
        PopupMenu m = new PopupMenu(this, anchor);
        m.getMenu().add(0, 1, 0, "AI 设置（接口地址和 Key）");
        m.getMenu().add(0, 2, 0, "刷新");
        m.getMenu().add(0, 3, 0, "收藏本页");
        m.getMenu().add(0, 4, 0, "收藏夹");
        m.getMenu().add(0, 5, 0, "起始页和使用说明");
        m.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1:
                    showKeyDialog();
                    break;
                case 2:
                    web.reload();
                    break;
                case 3:
                    addBookmark();
                    break;
                case 4:
                    showBookmarks();
                    break;
                case 5:
                    web.loadUrl(HOME);
                    break;
                default:
                    break;
            }
            return true;
        });
        m.show();
    }

    private void hideKeyboard() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(urlBox.getWindowToken(), 0);
        } catch (Throwable ignored) {
        }
    }

    private void go(String text) {
        String t = text == null ? "" : text.trim();
        if (t.isEmpty()) return;
        String url;
        if (t.startsWith("http://") || t.startsWith("https://")) {
            url = t;
        } else if (t.contains(".") && !t.contains(" ")) {
            url = "https://" + t;
        } else {
            try {
                url = "https://www.google.com/search?q=" + URLEncoder.encode(t, "UTF-8");
            } catch (Exception e) {
                return;
            }
        }
        hideKeyboard();
        urlBox.clearFocus();
        web.loadUrl(url);
        web.requestFocus();
    }

    private void showUrl(String url) {
        if (urlBox.hasFocus()) return;
        urlBox.setText(url == null || !url.startsWith("http") ? "" : url);
    }

    // ------------------------------------------------------------------ 网页

    private void setupWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(true); // 配合下面的 onCreateWindow 拦截弹窗
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // 去掉 "; wv" 标记，让网站把它当成普通的手机浏览器
        String ua = s.getUserAgentString();
        if (ua != null) {
            ua = ua.replace("; wv", "");
            s.setUserAgentString(ua);
            userAgent = ua;
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "MgtlNative");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String u = req.getUrl().toString();
                // 只在 App 里打开普通网页；想跳去别的 App 或应用商店的链接（多半是广告）一律不处理
                return !(u.startsWith("http://") || u.startsWith("https://") || u.startsWith("file:///android_asset/"));
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                showUrl(url);
                bar.setProgress(5);
                bar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageCommitVisible(WebView v, String url) {
                inject(url);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                inject(url);
                bar.setVisibility(View.INVISIBLE);
            }

            @Override
            public void doUpdateVisitedHistory(WebView v, String url, boolean isReload) {
                showUrl(url);
                if (url != null && url.startsWith("http")) prefs.edit().putString("lastUrl", url).apply();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                bar.setProgress(p);
                bar.setVisibility(p >= 100 ? View.INVISIBLE : View.VISIBLE);
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                // 网页想开新窗口：不开。如果是你亲手点了一个"在新窗口打开"的链接，就在当前页面打开它；
                // 脚本自己弹出来的窗口（基本都是广告）直接丢掉。
                if (isUserGesture) {
                    Message m = new Handler(Looper.getMainLooper(), msg -> {
                        String href = msg.getData().getString("url");
                        if (href != null && (href.startsWith("http://") || href.startsWith("https://"))) web.loadUrl(href);
                        return true;
                    }).obtainMessage();
                    view.requestFocusNodeHref(m);
                }
                return false;
            }
        });
    }

    private void inject(String url) {
        if (url == null || injectJs.isEmpty()) return;
        if (!(url.startsWith("http://") || url.startsWith("https://"))) return;
        web.evaluateJavascript(injectJs, null);
    }

    /** 通知网页里的脚本：App 这边有东西变了（目前只有 "cfg"：设置变了）。 */
    private void notifyJs(String what) {
        web.evaluateJavascript("window.__mgtlCb&&window.__mgtlCb('event'," + JSONObject.quote(what) + ");", null);
    }

    /** 把一次请求的结果送回网页里的脚本。 */
    private void callback(final String id, final JSONObject out) {
        final String js = "window.__mgtlCb&&window.__mgtlCb(" + JSONObject.quote(id) + "," + out.toString() + ");";
        ui.post(() -> {
            try {
                web.evaluateJavascript(js, null);
            } catch (Throwable ignored) {
            }
        });
    }

    private static void put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Exception ignored) {
        }
    }

    // ------------------------------------------------------------------ 给网页脚本用的接口

    final class Bridge {
        @JavascriptInterface
        public String getValue(String t, String key) {
            if (!token.equals(t) || key == null) return "";
            if ("cfg".equals(key)) return cfgForJs();
            return prefs.getString("js_" + key, "");
        }

        @JavascriptInterface
        public void setValue(String t, String key, String val) {
            if (!token.equals(t) || key == null || val == null || val.length() > 300000) return;
            prefs.edit().putString("js_" + key, val).apply();
        }

        @JavascriptInterface
        public void request(String t, final String id, final String method, final String url, final String headersJson,
                            final String body, final String responseType, final int timeoutMs) {
            if (!token.equals(t) || id == null) return;
            pool.execute(() -> {
                JSONObject out = new JSONObject();
                try {
                    doRequest(out, method, url, headersJson, body, responseType, timeoutMs);
                } catch (SocketTimeoutException e) {
                    out = new JSONObject();
                    put(out, "error", "timeout");
                } catch (Throwable e) {
                    out = new JSONObject();
                    put(out, "error", String.valueOf(e));
                }
                callback(id, out);
            });
        }

        @JavascriptInterface
        public void capture(String t, final String id) {
            if (!token.equals(t) || id == null) return;
            ui.post(() -> captureWeb(id));
        }

        @JavascriptInterface
        public void openKeySettings(String t) {
            if (!token.equals(t)) return;
            ui.post(MainActivity.this::showKeyDialog);
        }
    }

    /** 网页脚本读到的设置：接口地址用 App 里保存的，Key 换成占位符。 */
    private String cfgForJs() {
        JSONObject o;
        try {
            o = new JSONObject(prefs.getString("js_cfg", "{}"));
        } catch (Exception e) {
            o = new JSONObject();
        }
        put(o, "preset", "custom");
        put(o, "baseUrl", prefs.getString("baseUrl", DEFAULT_BASE));
        put(o, "apiKey", prefs.getString("apiKey", "").isEmpty() ? "" : KEY_MARK);
        return o.toString();
    }

    /** 认识的接口：返回 {推荐的模型, 每分钟最多请求数}；不认识的返回 null。 */
    private static String[] suggestFor(String base) {
        String host;
        try {
            host = new URL(base).getHost().toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return null;
        }
        if (host.equals("api.deepseek.com")) return new String[]{"deepseek-flash", "0"}; // DeepSeek 目前只有这个模型能看图
        if (host.equals("generativelanguage.googleapis.com")) return new String[]{"gemini-3.5-flash-lite", "8"};
        return null;
    }

    private static int portOf(URL u) {
        return u.getPort() != -1 ? u.getPort() : u.getDefaultPort();
    }

    private static boolean sameOrigin(URL u, String base) {
        try {
            URL b = new URL(base);
            return u.getProtocol().equalsIgnoreCase(b.getProtocol()) && u.getHost().equalsIgnoreCase(b.getHost()) && portOf(u) == portOf(b);
        } catch (Exception e) {
            return false;
        }
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
            if (bos.size() > max) throw new IOException("response too large");
        }
        return bos.toByteArray();
    }

    private static boolean looksLikeImage(byte[] b, String contentType) {
        if (contentType != null && contentType.toLowerCase(Locale.ROOT).startsWith("image/")) return true;
        if (b.length < 12) return false;
        int b0 = b[0] & 0xff, b1 = b[1] & 0xff, b2 = b[2] & 0xff, b3 = b[3] & 0xff;
        if (b0 == 0xff && b1 == 0xd8) return true; // JPEG
        if (b0 == 0x89 && b1 == 0x50 && b2 == 0x4e && b3 == 0x47) return true; // PNG
        if (b0 == 0x47 && b1 == 0x49 && b2 == 0x46) return true; // GIF
        if (b0 == 0x52 && b1 == 0x49 && b2 == 0x46 && b3 == 0x46 && b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) return true; // WEBP
        return b[4] == 0x66 && b[5] == 0x74 && b[6] == 0x79 && b[7] == 0x70; // AVIF/HEIF 一类
    }

    /**
     * 替网页脚本发请求。只做两件事：
     *  1. 发往"AI 设置"里那个接口地址的请求（这时才会带上真正的 Key）；
     *  2. 下载图片（只带 Referer，不带 Key，也不带网站的登录信息；拿到的不是图片就丢掉）。
     * 其他请求一律拒绝，免得网页借这个通道去访问别的东西。
     */
    private void doRequest(JSONObject out, String method, String url, String headersJson, String body, String responseType, int timeoutMs) throws Exception {
        URL u = new URL(url);
        String proto = u.getProtocol();
        if (!"https".equals(proto) && !"http".equals(proto)) throw new IOException("unsupported url");
        String m = method == null ? "GET" : method.toUpperCase(Locale.ROOT);
        boolean toAi = sameOrigin(u, prefs.getString("baseUrl", DEFAULT_BASE));
        boolean binary = "arraybuffer".equals(responseType);
        if (!toAi && !(binary && "GET".equals(m))) throw new IOException("request not allowed");

        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        try {
            int to = Math.max(5000, Math.min(timeoutMs, 180000));
            c.setConnectTimeout(Math.min(to, 20000));
            c.setReadTimeout(to);
            c.setRequestMethod(m);
            c.setInstanceFollowRedirects(!toAi); // 带 Key 的请求不跟随跳转，避免 Key 被带到别的地址
            if (!userAgent.isEmpty()) c.setRequestProperty("User-Agent", userAgent);

            JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
            for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                String k = it.next();
                String v = h.optString(k, "");
                if ("authorization".equalsIgnoreCase(k)) {
                    String key = prefs.getString("apiKey", "");
                    if (!toAi || key.isEmpty()) continue;
                    v = "Bearer " + key;
                } else if (!toAi && !"referer".equalsIgnoreCase(k)) {
                    continue;
                }
                c.setRequestProperty(k, v);
            }

            if (body != null && !body.isEmpty() && !"GET".equals(m)) {
                byte[] data = body.getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(data.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(data);
                }
            }

            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] bytes = in == null ? new byte[0] : readAll(in, binary ? 12 * 1024 * 1024 : 8 * 1024 * 1024);
            String ct = c.getContentType();
            out.put("status", status);
            out.put("headers", "content-type: " + (ct == null ? "" : ct) + "\r\n");
            if (binary) {
                if (!toAi && !looksLikeImage(bytes, ct)) throw new IOException("not an image");
                out.put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            } else {
                out.put("text", new String(bytes, StandardCharsets.UTF_8));
            }
        } finally {
            c.disconnect();
        }
    }

    // ------------------------------------------------------------------ 截屏（读不到内容的图片用）

    private void captureWeb(final String id) {
        final int w = web.getWidth();
        final int h = web.getHeight();
        if (w <= 0 || h <= 0) {
            JSONObject out = new JSONObject();
            put(out, "error", "view not ready");
            callback(id, out);
            return;
        }
        final Bitmap bmp;
        try {
            bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        } catch (Throwable e) {
            JSONObject out = new JSONObject();
            put(out, "error", String.valueOf(e));
            callback(id, out);
            return;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                int[] loc = new int[2];
                web.getLocationInWindow(loc);
                Rect src = new Rect(loc[0], loc[1], loc[0] + w, loc[1] + h);
                PixelCopy.request(getWindow(), src, bmp, result -> {
                    if (result == PixelCopy.SUCCESS) sendBitmap(id, bmp);
                    else softwareCapture(id, bmp);
                }, ui);
                return;
            } catch (Throwable ignored) {
            }
        }
        softwareCapture(id, bmp);
    }

    /** 老系统或上面的方式失败时的备用办法：让界面自己把内容画到一张图上。 */
    private void softwareCapture(String id, Bitmap bmp) {
        try {
            Bitmap full = Bitmap.createBitmap(root.getWidth(), root.getHeight(), Bitmap.Config.ARGB_8888);
            root.draw(new Canvas(full));
            new Canvas(bmp).drawBitmap(full, -web.getLeft(), -web.getTop(), null);
            full.recycle();
            sendBitmap(id, bmp);
        } catch (Throwable e) {
            JSONObject out = new JSONObject();
            put(out, "error", String.valueOf(e));
            callback(id, out);
        }
    }

    private void sendBitmap(final String id, final Bitmap bmp) {
        pool.execute(() -> {
            JSONObject out = new JSONObject();
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, 92, bos);
                put(out, "b64", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            } catch (Throwable e) {
                out = new JSONObject();
                put(out, "error", String.valueOf(e));
            }
            try {
                bmp.recycle();
            } catch (Throwable ignored) {
            }
            callback(id, out);
        });
    }

    // ------------------------------------------------------------------ AI 设置（接口地址和 Key）

    private TextView label(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(14);
        t.setTextColor(0xFF222222);
        t.setPadding(0, dp(12), 0, dp(2));
        return t;
    }

    private Button presetButton(String name, final String url, final EditText target) {
        Button b = new Button(this, null, android.R.attr.borderlessButtonStyle);
        b.setText(name);
        b.setAllCaps(false);
        b.setTextSize(13);
        b.setOnClickListener(v -> target.setText(url));
        return b;
    }

    private void showKeyDialog() {
        if (isFinishing()) return;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(22), dp(4), dp(22), 0);

        final String oldBase = prefs.getString("baseUrl", DEFAULT_BASE);
        final boolean had = !prefs.getString("apiKey", "").isEmpty();

        final EditText base = new EditText(this);
        base.setSingleLine(true);
        base.setTextSize(14);
        base.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        base.setText(oldBase);

        LinearLayout presets = new LinearLayout(this);
        presets.setOrientation(LinearLayout.VERTICAL);
        LinearLayout row1 = new LinearLayout(this);
        row1.setOrientation(LinearLayout.HORIZONTAL);
        row1.addView(presetButton("Gemini", DEFAULT_BASE, base));
        row1.addView(presetButton("DeepSeek", "https://api.deepseek.com", base));
        LinearLayout row2 = new LinearLayout(this);
        row2.setOrientation(LinearLayout.HORIZONTAL);
        row2.addView(presetButton("OpenAI", "https://api.openai.com/v1", base));
        row2.addView(presetButton("OpenRouter", "https://openrouter.ai/api/v1", base));
        presets.addView(row1);
        presets.addView(row2);

        final EditText key = new EditText(this);
        key.setSingleLine(true);
        key.setTextSize(14);
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        key.setHint(had ? "已保存。留空表示不修改" : "粘贴你的 Key");

        TextView note = new TextView(this);
        note.setTextSize(13);
        note.setTextColor(0xFF777777);
        note.setPadding(0, dp(12), 0, 0);
        note.setText("Gemini 的 Key 在 aistudio.google.com/apikey 申请，DeepSeek 的在 platform.deepseek.com 申请。\nKey 只保存在这个 App 里，网页读不到它；它只会发给上面填的接口地址。\n模型在网页上的「译」→「设置」里选。");

        box.addView(label("接口地址（点下面的名字可以直接填好）"));
        box.addView(presets);
        box.addView(base);
        box.addView(label("API Key"));
        box.addView(key);
        box.addView(note);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);

        new AlertDialog.Builder(this)
                .setTitle("AI 设置")
                .setView(scroll)
                .setNegativeButton("取消", null)
                .setPositiveButton("保存", (d, which) -> {
                    String b = base.getText().toString().trim().replaceAll("/+$", "");
                    String k = key.getText().toString().trim();
                    if (!(b.startsWith("http://") || b.startsWith("https://"))) {
                        toast("接口地址要以 https:// 开头，没有保存");
                        return;
                    }
                    SharedPreferences.Editor e = prefs.edit();
                    boolean movedHost;
                    try {
                        movedHost = !sameOrigin(new URL(b), oldBase);
                    } catch (Exception ex) {
                        toast("接口地址格式不对，没有保存");
                        return;
                    }
                    e.putString("baseUrl", b);
                    String[] sug = movedHost ? suggestFor(b) : null;
                    if (movedHost) {
                        // 换了一家接口：原来的模型名不能用了。认识的接口直接填好推荐的模型和限速，不认识的清空，让你自己选
                        try {
                            JSONObject o = new JSONObject(prefs.getString("js_cfg", "{}"));
                            o.put("model", sug == null ? "" : sug[0]);
                            if (sug != null) o.put("rpm", Integer.parseInt(sug[1]));
                            e.putString("js_cfg", o.toString());
                        } catch (Exception ignored) {
                        }
                    }
                    boolean keyCleared = false;
                    if (!k.isEmpty()) {
                        e.putString("apiKey", k);
                    } else if (movedHost && had) {
                        // 换了一家接口却没填新 Key：把旧 Key 清掉，免得把它发给另一家
                        e.remove("apiKey");
                        keyCleared = true;
                    }
                    e.apply();
                    notifyJs("cfg");
                    if (keyCleared) toast("接口地址换了，旧的 Key 已清除，请重新填写新的 Key");
                    else if (sug != null) toast("已保存，模型已设为 " + sug[0] + "。接下来在网页上点「译」→「设置」→「测试」");
                    else if (movedHost) toast("已保存。请在网页上点「译」→「设置」里填写模型，再点「测试」");
                    else if (!k.isEmpty()) toast("已保存。接下来在网页上点「译」→「设置」→「测试」");
                })
                .show();
    }

    // ------------------------------------------------------------------ 收藏夹

    private void addBookmark() {
        String u = web.getUrl();
        if (u == null || !u.startsWith("http")) {
            toast("这个页面不能收藏");
            return;
        }
        try {
            JSONArray a = new JSONArray(prefs.getString("bookmarks", "[]"));
            for (int i = 0; i < a.length(); i++) {
                if (u.equals(a.getJSONObject(i).optString("u"))) {
                    toast("已经在收藏夹里了");
                    return;
                }
            }
            String t = web.getTitle();
            JSONObject o = new JSONObject();
            o.put("t", t == null || t.trim().isEmpty() ? u : t.trim());
            o.put("u", u);
            a.put(o);
            prefs.edit().putString("bookmarks", a.toString()).apply();
            toast("已收藏");
        } catch (Exception e) {
            toast("收藏失败");
        }
    }

    private void showBookmarks() {
        final JSONArray a;
        try {
            a = new JSONArray(prefs.getString("bookmarks", "[]"));
        } catch (Exception e) {
            return;
        }
        if (a.length() == 0) {
            toast("收藏夹是空的。打开一个网页后，点「菜单」→「收藏本页」");
            return;
        }
        final String[] names = new String[a.length()];
        for (int i = 0; i < names.length; i++) {
            JSONObject o = a.optJSONObject(i);
            names[i] = o == null ? "" : o.optString("t");
        }
        final AlertDialog dlg = new AlertDialog.Builder(this)
                .setTitle("收藏夹（长按可删除）")
                .setItems(names, (d, i) -> {
                    JSONObject o = a.optJSONObject(i);
                    if (o != null) web.loadUrl(o.optString("u"));
                })
                .setNegativeButton("关闭", null)
                .create();
        dlg.show();
        dlg.getListView().setOnItemLongClickListener((parent, v, pos, rowId) -> {
            a.remove(pos);
            prefs.edit().putString("bookmarks", a.toString()).apply();
            dlg.dismiss();
            toast("已删除");
            return true;
        });
    }

    // ------------------------------------------------------------------ 出错时留下记录，方便排查

    private void installCrashCatcher() {
        final Thread.UncaughtExceptionHandler old = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, ex) -> {
            try {
                StringWriter sw = new StringWriter();
                ex.printStackTrace(new PrintWriter(sw));
                String text = "Android " + Build.VERSION.RELEASE + " (" + Build.VERSION.SDK_INT + ") " + Build.MANUFACTURER + " " + Build.MODEL + "\n" + sw;
                prefs.edit().putString("lastCrash", text.length() > 6000 ? text.substring(0, 6000) : text).commit();
            } catch (Throwable ignored) {
            }
            if (old != null) old.uncaughtException(thread, ex);
        });
    }

    private void showLastCrashIfAny() {
        final String crash = prefs.getString("lastCrash", "");
        if (crash.isEmpty()) return;
        prefs.edit().remove("lastCrash").apply();
        TextView tv = new TextView(this);
        tv.setText(crash);
        tv.setTextSize(11);
        tv.setTextIsSelectable(true);
        tv.setPadding(dp(18), dp(8), dp(18), 0);
        ScrollView sv = new ScrollView(this);
        sv.addView(tv);
        new AlertDialog.Builder(this)
                .setTitle("上次 App 意外退出了")
                .setMessage("把下面的内容截图或复制，发给写这个 App 的人，方便修复。")
                .setView(sv)
                .setPositiveButton("复制", (d, w) -> {
                    try {
                        ClipboardManager cb = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cb != null) cb.setPrimaryClip(ClipData.newPlainText("crash", crash));
                        toast("已复制");
                    } catch (Throwable ignored) {
                    }
                })
                .setNegativeButton("关闭", null)
                .show();
    }

    // ------------------------------------------------------------------ 生命周期

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        try {
            web.onPause();
            CookieManager.getInstance().flush();
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        try {
            web.onResume();
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onDestroy() {
        try {
            pool.shutdownNow();
            root.removeView(web);
            web.destroy();
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }
}
