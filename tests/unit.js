const __ROOT = require('path').resolve(__dirname, '..'); // 仓库根目录
require('fs').mkdirSync(__ROOT + '/tests/shots', { recursive: true });
const m = require(__ROOT + '/userscript/manga-translator.user.js');
const assert = require('assert');
// parseItems
let a = m.parseItems('```json\n[{"box":[100,200,300,400],"src":"a","text":"甲","dark":true},{"box":[10,10,5,5],"text":""}]\n```',800,1200);
assert.deepStrictEqual(a.map(x=>[x.text,x.hasBox,x.x,x.y,x.w,x.h,x.dark]), [['甲',true,0.2,0.1,0.2,0.2,true]]);
a = m.parseItems('<thought>plan: [{"box":[1,2,3,4],"text":"draft"}] hmm</thought>\n[{"box":[100,100,300,900],"text":"你好"}]');
assert.deepStrictEqual(a.map(x=>x.text), ['你好']);
a = m.parseItems('<thought>* Task: OCR [{ not json }]\nFinal:\n[{"box":[100,100,300,900],"text":"未闭合"}]');
assert.deepStrictEqual(a.map(x=>x.text), ['未闭合']);
a = m.parseItems('[{"box":[120,240,600,480],"text":"千分比"},{"box":[0.1,0.2,0.3,0.4],"text":"小数"},{"box":[1200,400,1800,1600],"text":"像素"}]',1600,2400);
assert.deepStrictEqual(a.map(x=>[x.text,+x.x.toFixed(3),+x.y.toFixed(3)]), [['千分比',0.24,0.12],['小数',0.2,0.1],['像素',0.25,0.5]]);
assert.deepStrictEqual(m.parseItems('[]'), []);
assert.strictEqual(m.parseItems('{"items":[{"text":"x"}]}')[0].hasBox, false);
assert.deepStrictEqual(m.parseItems('[{"box":[1,2,30,40],"text":"a"},{"box":[1,2,30,40],"text":"b"},{"box":[1,2').map(x=>x.text), ['a','b']);
assert.throws(()=>m.parseItems(''), /没有返回任何内容/);
assert.throws(()=>m.parseItems('sorry, I cannot help'), /无法解析/);
// completionText
assert.strictEqual(m.completionText(JSON.stringify({choices:[{message:{content:'[]'}}]})), '[]');
assert.strictEqual(m.completionText(JSON.stringify({choices:[{message:{content:[{type:'text',text:'[1'},{type:'text',text:']'}]}}]})), '[1]');
assert.throws(()=>m.completionText('<html>'), /不是有效数据/);
assert.throws(()=>m.completionText(JSON.stringify([{error:{message:'boom'}}])), /boom/);
// errors
assert.ok(/Key 无效/.test(m.describeHttpError(401,'{"error":{"message":"bad key"}}')));
assert.ok(/bad key/.test(m.describeHttpError(401,'{"error":{"message":"bad key"}}')));
assert.ok(/连不上/.test(m.describeHttpError(0,'')));
assert.ok(/服务端出错/.test(m.describeHttpError(503,'[{"error":{"message":"busy"}}]')));
// sniff
assert.strictEqual(m.sniffMime([0xff,0xd8,0xff]), 'image/jpeg');
assert.strictEqual(m.sniffMime([0x89,0x50,0x4e,0x47]), 'image/png');
assert.strictEqual(m.sniffMime([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50]), 'image/webp');
assert.strictEqual(m.sniffMime([1,2,3],'text/html'), 'image/jpeg');
assert.strictEqual(m.sniffMime([1,2,3],'image/bmp'), 'image/bmp');
// hosts
assert.deepStrictEqual(m.parseHostList('https://A.com/path\n b.org , a.com\n\n'), ['a.com','b.org']);
// prompt
const p = m.buildPrompt({targetLang:'简体中文',skipLangs:'日语',extraPrompt:'保留人名'});
assert.ok(p.includes('简体中文') && p.includes('日语') && p.includes('保留人名'));
// limiter
(async()=>{ const lim=m.limiter(2); let act=0,max=0; await Promise.all([1,2,3,4,5].map(()=>lim(async()=>{act++;max=Math.max(max,act);await new Promise(r=>setTimeout(r,20));act--;}))); assert.strictEqual(max,2); console.log('UNIT_OK'); })();
