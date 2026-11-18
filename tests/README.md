# 检查脚本

开发时用的自动检查。AI 接口是模拟的，不需要真实的 Key，也不会产生费用。

需要：Node.js、Playwright（`npm i playwright`）、Python 3、Chrome。Chrome 不在 `/usr/bin/google-chrome` 时，用环境变量 `CHROME` 指定路径。

```bash
cd tests
bash run.sh unit.js bg.js opt.js real.js ext.js appmode.js e2e.js tap.js
```

| 脚本 | 检查什么 |
| --- | --- |
| `unit.js` | 提示词、返回结果解析、限速等纯逻辑 |
| `bg.js` | Chrome 插件后台脚本实际发出的请求（各家服务的参数、报错提示） |
| `opt.js` | Chrome 插件设置页（切换服务、每家的 Key 分开记） |
| `real.js` | 把插件真的装进 Chrome，从设置页到网页翻译走一遍 |
| `ext.js` | Chrome 插件在网页里的显示（译文位置、字号） |
| `e2e.js` | 浏览器脚本在手机尺寸页面上的完整流程 |
| `appmode.js` | 安卓 App 里的脚本（用一个照着 Java 行为写的假原生接口） |
| `tap.js` | 用真实的触摸、和手机一致的条件检查按钮、菜单、整屏翻译和自动翻译 |

`site/` 和 `img/` 是测试用的网页和图片，`gen.py` 用来生成这些图片。
安卓 App 的原生部分（Java）没有自动检查，只能在真机上试。
