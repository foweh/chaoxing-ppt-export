// 自测：在 Node 里用假 DOM 加载油猴脚本，用保存的页面快照验证解析逻辑。
// 用法（仓库根目录）：node test/test_userscript.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, '超星课程PPT批量导出.user.js'), 'utf8');
const html = fs.readFileSync(path.join(root, '学生学习页面_files', 'cards.html'), 'utf8');

const noopEl = () => ({
  appendChild() {}, append() {}, setAttribute() {}, addEventListener() {},
  classList: { toggle() {}, add() {} }, style: {}, querySelector: () => null, textContent: '',
});
const document = {
  scripts: [],
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => noopEl(),
  body: { appendChild() {} },
  head: { appendChild() {} },
};
const window = { __CXPPT_DEBUG__: true };
const location = {
  search: '?chapterId=1&courseId=100000001&clazzid=200000002&cpi=300000003',
  origin: 'https://mooc1.chaoxing.com',
  protocol: 'https:',
};
const localStorage = { getItem: () => null, setItem() {} };

const ctx = {
  window, document, location, localStorage,
  navigator: {}, console,
  setInterval: () => 0, clearInterval: () => {}, setTimeout,
  fetch: () => Promise.reject(new Error('no net')),
  URL, URLSearchParams, Blob: function () {}, JSON, Promise, RegExp,
  Math, Date, String, Number, Array, Set, Map, Object,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);

const api = ctx.window.__cxpptInternals;
if (!api) { console.error('FAIL: 没拿到内部函数'); process.exit(1); }

// 1. 解析 cards.html 里的 PPT 附件
const map = new Map();
api.collectAttachments(html, map);
const list = [...map.values()];
console.log('解析到附件数:', list.length);
list.forEach((a) => console.log(' -', a.objectid, '|', a.name, '|', a.ext, '| isPpt=', a.isPpt, '| size=', a.size));

// 2. 校验关键字段
const ppt = list.find((a) => a.objectid && /^[0-9a-f]{32}$/.test(a.objectid));
if (!ppt) { console.error('FAIL: 没解析出 objectid'); process.exit(1); }
if (!ppt.isPpt) { console.error('FAIL: 未识别为 PPT'); process.exit(1); }
if (!/\.pptx?$|\.ppsx?$/i.test(ppt.name)) { console.error('FAIL: 文件名不对 ->', ppt.name); process.exit(1); }

// 3. 校验 status 返回解析（类 JS 对象，键不带引号）
const statusText = '{status:"success",download:"http://p.ananas.chaoxing.com/star3/origin/abc.pptx?x=1",filename:"第2讲.pptx",length:710673}';
console.log('status ->', api.pickField(statusText, 'status'), '|', api.pickField(statusText, 'download'), '|', api.pickField(statusText, 'filename'));
if (api.pickField(statusText, 'status') !== 'success') { console.error('FAIL: status 解析'); process.exit(1); }
if (api.pickField(statusText, 'download') !== 'http://p.ananas.chaoxing.com/star3/origin/abc.pptx?x=1') { console.error('FAIL: download 解析'); process.exit(1); }

// 3b. 线上真实返回（key 带引号、没有 status 字段）—— 这就是导致“全部失败”的那条
const real = '{"download":"http://d0.cldisk.com/download/00000000000000000000000000000001?at_=1700000000000&ak=ak&ad=ad","length":710673,"filename":"第10讲.pptx"}';
const realDl = api.pickField(real, 'download');
console.log('real download ->', realDl);
if (realDl !== 'http://d0.cldisk.com/download/00000000000000000000000000000001?at_=1700000000000&ak=ak&ad=ad') {
  console.error('FAIL: 带引号 key 的 download 解析'); process.exit(1);
}
if (api.pickField(real, 'filename') !== '第10讲.pptx') { console.error('FAIL: 带引号 key 的 filename 解析'); process.exit(1); }

// 4. 校验 cardsUrl
api.st.params = { courseId: '100000001', clazzId: '200000002', cpi: '300000003' };
console.log('cardsUrl ->', api.cardsUrl('/mooc-ans', '1273611702', 0));

// 5. 校验直链归一化 + 文件名
console.log('normalizeUrl ->', api.normalizeUrl('//d0.cldisk.com/download/x?y=1'), '|', api.normalizeUrl('/ananas/status/x'));
if (api.normalizeUrl('//d0.cldisk.com/a') !== 'https://d0.cldisk.com/a') { console.error('FAIL: // 归一化'); process.exit(1); }
const fname = api.buildFileName({ sbar: '1.2', title: '算法及其分析' }, { name: '第2讲(1).pptx', ext: '.pptx' }, '');
console.log('fileName ->', fname);
if (!fname.endsWith('.pptx') || fname.includes('/')) { console.error('FAIL: 文件名'); process.exit(1); }

// 6. 校验签名时间解析
const at = api.atTime('http://d0.cldisk.com/download/x?at_=1700000000000&ak=ak&ad=ad');
console.log('atTime ->', at, new Date(at).toISOString());
if (at !== 1700000000000) { console.error('FAIL: at_ 解析'); process.exit(1); }

console.log('ALL OK');
