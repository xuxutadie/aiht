import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/artworks.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');

const answers = {
  competition_name: '创作实践赛', competition_theme: '城市里的温情', requirements: '关注人与科技', task_understanding: '描绘科技帮助人们的场景',
  theme: '人机共生', reason: '关心老年人的生活', message: 'AI帮助人们生活', message_detail: '人与机器彼此关心',
  subject: '老人和机器人', scene: '敬老院', action: '机器人为老人推轮椅', details: '温暖的阳光和微笑',
  ratio: '16:9', style: '动漫', subject_framing: '全身', scene_distance: '中景', style_reason: '亲切明快，便于展现环境',
  innovation_type: '新的组合', innovation: '科技与养老融合', innovation_visible: '机器人为老人服务',
  custom_prompt: '不应复制的提示词', phone: '不应复制的电话', name: '不应复制的姓名',
};
const original = { id: 'art-1', title: '人机共生', answers, plan: { answers: { theme: '新草稿里的主题' } }, phone: '作品外部的电话' };

// 使用实际模板及编辑器代码，模拟 DOM、确认对话框和保存边界。
class FormNode {
  constructor(tag, attrs, children) {
    this.tag = tag; this.attrs = attrs; this.children = []; this.handlers = {};
    this.value = attrs.value ?? ''; this.disabled = Boolean(attrs.disabled);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) this.addEventListener(key.slice(2).toLowerCase(), value);
    }
    this.append(...children);
  }
  append(...children) { this.children.push(...children.flat(Infinity).filter(node => node !== null && node !== undefined && node !== false)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  set textContent(text) { this.children = [String(text)]; }
  get textContent() { return this.children.map(node => node instanceof FormNode ? node.textContent : String(node)).join(''); }
  findAll(predicate) { return this.children.flatMap(node => node instanceof FormNode ? [...(predicate(node) ? [node] : []), ...node.findAll(predicate)] : []); }
  querySelector(tag) { return this.findAll(node => node.tag === tag)[0] || null; }
  addEventListener(type, listener) { (this.handlers[type] ||= []).push(listener); }
  async fire(type) { for (const listener of this.handlers[type] || []) await listener({ preventDefault() {}, target: this }); }
  focus() {}
}

function fixture(artwork = original, confirmAnswers = []) {
  const requests = [], confirms = [], saved = [];
  const el = (tag, attrs = {}, ...children) => new FormNode(tag, attrs, children);
  const context = vm.createContext({
    el,
    button: (label, onClick, className, attrs = {}) => el('button', { type: 'button', className, onClick, ...attrs }, label),
    notice: (text, kind) => el('p', { className: `notice ${kind}` }, text),
    inputField: ({ name, label, multiline, ...attrs }) => el('div', {}, el('label', {}, label), el(multiline ? 'textarea' : 'input', { name, ...attrs })),
    confirmAction: async (title, message) => { confirms.push({ title, message }); return confirmAnswers.shift() ?? false; },
    FormData: function (form) { return form.findAll(node => node.tag === 'textarea').map(node => [node.attrs.name, node.value]); },
    api: async path => { requests.push({ path }); assert.fail('不应请求当前创作计划或模型'); },
    put: async (path, payload) => { requests.push({ path, payload: { ...payload } }); return { artwork: { ...artwork, ...payload } }; },
    toast() {}, openDialog() {}, formatTime() {}, emptyState() {},
  });
  vm.runInContext(source + '\nthis.template = descriptionTemplate; this.editor = artworkEditor;', context);
  const root = context.editor(artwork, { onSaved: item => saved.push(item) });
  const field = name => root.findAll(node => node.tag === 'textarea' && node.attrs.name === name)[0];
  const buttonByLabel = label => root.findAll(node => node.tag === 'button' && node.textContent === label)[0];
  return { root, field, button: buttonByLabel, submit: () => root.querySelector('form').fire('submit'), template: context.template, requests, confirms, saved };
}

test('完整作品说明使用原作品快照，依次纳入七节关键创作内容', () => {
  const page = fixture();
  const template = page.template(original);
  assert.match(template, /^作品名称：《人机共生》/);
  assert.match(template, /01 赛题理解[\s\S]*02 创作背景[\s\S]*03 表达意图[\s\S]*04 画面构思[\s\S]*05 设计选择[\s\S]*06 创新亮点[\s\S]*07 AI辅助与修改过程/);
  for (const [key, value] of Object.entries(answers)) {
    if (['custom_prompt', 'phone', 'name'].includes(key)) assert.ok(!template.includes(value));
    else assert.ok(template.includes(value), `缺少快照答案：${key}`);
  }
  assert.match(template, /根据实际情况.*补充/);
  assert.match(template, /未修改也请如实填写/);
  assert.ok(!template.includes('新草稿里的主题'));
  assert.ok(!template.includes('作品外部的电话'));
  assert.deepEqual(page.requests, []);
});

test('缺项提示补充而不捏造内容，省略未填选项及自动取景', () => {
  const page = fixture();
  const empty = page.template({ answers: { subject_framing: '自动', scene_distance: '自动' } });
  assert.match(empty, /【请补充】/);
  assert.match(empty, /07 AI辅助与修改过程/);
  assert.doesNotMatch(empty, /比赛或练习名称：|赛题主题：|主体呈现：|场景景别：|已获奖/);
});

test('极长回答按字段安全摘录，完整七节与所有字段标签仍在5000个UTF-16单元内', () => {
  const page = fixture();
  const longAnswers = Object.fromEntries(Object.keys(answers).map(key => [key, `${key}：${'🖼️创作'.repeat(3000)}`]));
  const longTemplate = page.template({ title: '🌈'.repeat(500), answers: longAnswers });
  assert.ok(longTemplate.length <= 5000, `当前模板长度：${longTemplate.length}`);
  assert.match(longTemplate, /01 赛题理解[\s\S]*07 AI辅助与修改过程/);
  for (const prefix of ['赛题要求：requirements', '我理解的任务：task_understanding', '创作缘由：reason', '具体创新点：innovation', '创新在画面中的表现：innovation_visible']) {
    assert.ok(longTemplate.includes(prefix), `长字段丢失：${prefix}`);
  }
  assert.match(longTemplate, /原回答已摘录/);
  assert.doesNotMatch(longTemplate, /custom_prompt|phone|姓名：|(?:^|\n)name：/u);
  for (const char of longTemplate) assert.ok(!/^[\uD800-\uDFFF]$/u.test(char), '不应截断 Unicode 字符');
});

test('已有说明不自动替换，取消确认不改任何文本，确认后仍需主动保存', async () => {
  const page = fixture({ ...original, description: '之前自己写的说明', reflection: '此前真实反思' }, [false, true]);
  const description = page.field('description'), reflection = page.field('reflection');
  assert.equal(description.value, '之前自己写的说明');
  assert.equal(reflection.value, '此前真实反思');
  description.value = '尚未保存的新说明';
  reflection.value = '尚未保存的新反思';
  const useTemplate = page.button('使用完整说明模板');
  assert.ok(useTemplate, '旧作品也应有进入完整模板的明确按钮');
  assert.equal(useTemplate.attrs.type, 'button');
  await useTemplate.fire('click');
  assert.equal(page.confirms.length, 1);
  assert.equal(description.value, '尚未保存的新说明');
  assert.equal(reflection.value, '尚未保存的新反思');
  await useTemplate.fire('click');
  assert.equal(page.confirms.length, 2);
  assert.equal(description.value, page.template(original));
  assert.equal(reflection.value, '尚未保存的新反思');
  assert.deepEqual(page.requests, [], '点击模板不能直接调用保存接口');
  await page.submit();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].path, '/api/artworks/art-1');
  assert.equal(page.requests[0].payload.description, description.value);
  assert.equal(page.requests[0].payload.reflection, reflection.value);
  assert.equal(page.saved.length, 1);
});

test('空白说明可直接填入模板，保留原图下载与四项反思引导', async () => {
  const page = fixture({ ...original, description: '旧说明' });
  const description = page.field('description');
  description.value = '';
  await page.button('使用完整说明模板').fire('click');
  assert.deepEqual(page.confirms, []);
  assert.equal(description.value, page.template(original));
  assert.ok(description.attrs.rows >= 12);
  assert.equal(description.attrs.maxlength, 5000);
  assert.equal(page.field('reflection').attrs.maxlength, 5000);
  assert.match(page.field('reflection').attrs.placeholder, /1\.[\s\S]*2\.[\s\S]*3\.[\s\S]*4\./);
  assert.ok(page.root.findAll(node => node.tag === 'a' && node.attrs.href === '/api/artworks/art-1/download').length);
  assert.ok(page.root.findAll(node => node.tag === 'img' && node.attrs.src === '/api/artworks/art-1/image').length);
  assert.deepEqual(page.requests, []);
});
