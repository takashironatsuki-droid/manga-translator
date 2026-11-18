// 所有脚本共用的默认设置
globalThis.MGTL_DEFAULTS = {
  preset: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: '',
  model: '',
  targetLang: '简体中文',
  skipLangs: '',
  displayMode: 'overlay', // overlay = 覆盖在图上；list = 编号 + 侧边列表
  hoverButton: true,
  minSize: 180,
  extraPrompt: '',
  rpm: 8, // 每分钟最多发给 AI 的请求数，0 = 不限制
  autoAfterClick: true, // 点过一次「译」后，在该网站自动翻译后面的图片
  autoHosts: [] // 已开启自动翻译的网站
};
