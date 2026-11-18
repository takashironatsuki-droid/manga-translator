# 漫画图片翻译（AI）

用 AI 视觉模型把网页上的漫画图片翻译成你想要的语言，译文直接盖在图片的原文位置上。
同一套翻译逻辑做成了三种形式：

| 形式 | 文件夹 | 当前版本 | 用在哪里 |
| --- | --- | --- | --- |
| Chrome 插件 | `chrome-extension/` | 1.8.0 | 电脑上的 Chrome / Edge |
| 浏览器脚本 | `userscript/` | 2.4.0 | 手机或电脑浏览器（需要 Tampermonkey、Violentmonkey 等脚本管理器） |
| 安卓 App | `android-app/` | 1.3.0 | 安卓手机（自带一个简单的浏览器，不需要装别的东西） |

翻译由你自己的 API Key 调用 AI 完成，每翻译一张图（或一屏）调用一次。本项目不带任何 Key，也没有自己的服务器。

## 支持的 AI 服务

任何兼容 OpenAI `/chat/completions` 格式、并且**能看图**的模型都可以。内置了这些选项：

- **Google Gemini**：有免费额度（只对没开通结算的项目有效），但每分钟、每天的次数有限。
- **DeepSeek**：没有免费额度，价格便宜。只有 `deepseek-flash` 这个模型能看图。
- **OpenAI、OpenRouter、自定义接口**（包括本地的 Ollama）。

额度、价格和模型名称以各家官网为准，它们会变。

## 功能

- 点一下翻译当前屏幕上的图片；也可以按网站开启自动翻译，滚动或翻页后自动翻译新的图片。
- 译文两种显示方式：直接盖在原文上，或者在图上标编号、译文单独列出来。
- 长条图（韩漫）自动切成几段分别翻译。
- 可以设置"不需要翻译的语言"，比如看得懂日语就只翻英语和韩语。
- 限速和自动重试，尽量避免撞到免费额度的每分钟上限。
- 安卓 App：遇到读不到内容的图片（受保护的阅读器），改为截屏翻译整个屏幕；翻回看过的页面不会重复调用 AI。
- 安卓 App：API Key 只保存在 App 里，网页里的脚本读不到它。

## 怎么用

### Chrome 插件

1. 下载本仓库，记住 `chrome-extension` 文件夹的位置（装好后不要移动或删除它）。
2. Chrome 打开 `chrome://extensions`，打开右上角的「开发者模式」。
3. 点「加载已解压的扩展程序」，选择 `chrome-extension` 文件夹（里面直接能看到 `manifest.json`）。
4. 在弹出的设置页选一家 AI 服务，粘贴 Key，点「测试」，看到绿色的「成功」就可以用了。
5. 打开漫画网页，鼠标移到图片上点「译」。

更详细的说明见 `chrome-extension/安装和使用说明.txt`。

### 浏览器脚本

1. 浏览器装一个脚本管理器（Tampermonkey、Violentmonkey，iOS 上是 Userscripts）。
2. 用它安装 `userscript/manga-translator.user.js`。
3. 打开漫画网页，点屏幕右侧悬浮的「译」→「设置」，填好 Key 后点「测试」。

### 安卓 App

1. 把做好的安装包（`manga-translator-x.y.z.apk`，在本仓库的 Releases 里，或者自己打包）传到手机上安装。
2. 打开 App，点右上角「菜单」→「AI 设置」，选一家服务并粘贴 Key。
3. 在地址栏输入漫画网站的地址，点悬浮的「译」。

## 自己打包安卓 App

App 不用 Android Studio 和 Gradle，直接用命令行工具打包，只支持 Windows：

1. 新建一个工作文件夹。脚本里写的是 `D:\manga-app-build`，想换位置就改两个脚本开头的 `$B`。
2. 把本仓库的 `android-app` 文件夹复制进去，改名为 `project`。
3. 在工作文件夹里新建 `dl` 文件夹，然后运行 `project\fetch-tools.ps1`。它会下载 JDK 17、Android build-tools 34 和 android.jar，并核对校验值，约 300 MB，解压到 `tools`，不会安装进系统。
4. 运行 `powershell -NoProfile -ExecutionPolicy Bypass -File D:\manga-app-build\project\build.ps1`。

第一次打包会在 `keystore` 文件夹里生成签名密钥。**这个密钥和它的密码不要上传、不要弄丢**：以后的新版本要用同一个密钥签名，才能直接覆盖安装。

`android-app/assets/userscript.js` 和 `userscript/manga-translator.user.js` 是同一份文件，改了其中一个要把另一个也换掉。

## 检查脚本

`tests/` 里是开发时用的自动检查，用无头浏览器加一个假的 AI 接口把三种形式实际跑一遍，说明见 `tests/README.md`。

## 已知的限制

- 译文位置准不准取决于模型。盖歪了就把显示方式改成"图上标编号"。
- 大图在送给模型前会被缩小，很小很密的字可能认错或漏掉。
- 安卓 App 的整屏翻译只翻当前屏幕上看得见的内容，翻页后需要重新翻译（开着自动翻译时会自动做）。
- 安卓 App 自带的浏览器很简单，没有广告过滤、多标签页等功能。
- 检查脚本里的 AI 接口是模拟的，没有覆盖各家真实服务器的所有返回情况。

## 说明

这是个人使用的小工具，请只用来阅读你有权阅读的内容，并遵守各网站的使用条款。

## 许可证

[MIT](LICENSE)
