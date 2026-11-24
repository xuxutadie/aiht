import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/workspace.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export function createWorkspace', 'function createWorkspace');
const stepsSource = readFileSync(new URL('../../public/steps.js', import.meta.url), 'utf8').replaceAll('export ', '');
const creditsSource = readFileSync(new URL('../../public/credits.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '');

// 只模拟表单所需DOM，执行实际工作台代码与事件，检查保存和生成边界。
class FormNode {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag; this.attrs = {}; this.children = []; this.handlers = {}; this.dataset = {};
    this.disabled = false; this.checked = false; this.required = false; this.isConnected = true; this.classList = { add() {}, remove() {}, toggle() {} };
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key.startsWith('on') && typeof value === 'function') this.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'className') this.setAttribute('class', value);
      else { this[key] = value; this.setAttribute(key, value); }
    }
    this.append(...children);
  }
  append(...nodes) { this.children.push(...nodes.flat(Infinity).filter(node => node !== null && node !== undefined && node !== false)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  set textContent(text) { this.children = [String(text)]; }
  get textContent() { return this.children.map(node => node instanceof FormNode ? node.textContent : String(node)).join(''); }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
    if (name === 'disabled') this.disabled = true;
  }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, listener) { (this.handlers[type] ||= []).push(listener); }
  removeEventListener() {}
  focus() {}
  scrollIntoView() {}
  matches(selector) {
    if (selector.includes(' ')) selector = selector.split(' ').at(-1);
    if (selector.startsWith('.')) return (this.attrs.class || '').split(' ').includes(selector.slice(1));
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) return Object.hasOwn(this.attrs, attr[1]) && (attr[2] === undefined || this.attrs[attr[1]] === attr[2]);
    return this.tag === selector;
  }
  querySelectorAll(selector) {
    const alternatives = selector.split(',').map(value => value.trim());
    return this.children.flatMap(node => node instanceof FormNode ? [node, ...node.querySelectorAll('*')] : [])
      .filter(node => selector === '*' || alternatives.some(value => node.matches(value)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  async fire(type, value) {
    if (value !== undefined) this.value = value;
    for (const listener of this.handlers[type] || []) await listener({ target: this, currentTarget: this });
  }
}

const ANSWERS = {
  theme: '人机共生', reason: '让老人得到照顾', task_understanding: '画机器人照顾老人', message: '人与机器互相帮助',
  message_detail: '机器人扶着轮椅', subject: '机器人和老人', scene: '敬老院', action: '照顾轮椅上的老人', details: '温暖的阳光',
  ratio: '16:9', style: '动漫', style_reason: '亲切清楚', innovation_type: '新的故事', innovation: '未来照护生活', innovation_visible: '机器人的照护动作',
};

function workspace(t, { step = 4, confirmed = false, answers = {}, revokeConfirmation = false, failSave = false, templateError = '', user = { id: 'student-local', credits: 10, role: 'student' }, configured = true, generation = { id: 'job-local', status: 'failed' } } = {}) {
  let stored = { id: 'plan-local', title: '本地计划', answers: { ...ANSWERS, ...answers }, step, confirmed };
  const calls = [];
  const el = (tag, attrs = {}, ...children) => new FormNode(tag, attrs, children);
  const inputField = ({ name, label, options, multiline, value, hint, ...attrs }) => {
    const field = el('div', { 'data-field': name }, el('label', {}, label));
    const input = el(options ? 'select' : multiline ? 'textarea' : 'input', { ...attrs, name, value });
    if (options) input.append(...options.map(option => el('option', { value: Array.isArray(option) ? option[0] : option }, Array.isArray(option) ? option[1] : option)));
    field.append(input); if (hint) field.append(el('small', {}, hint)); return field;
  };
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), scrollTo() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    crypto: { randomUUID: () => 'request-local' }, setTimeout, clearTimeout,
    el, inputField, button: (text, click, className, attrs = {}) => el('button', { ...attrs, className, onClick: click }, text),
    notice: (text, kind) => el('p', { className: `notice ${kind}` }, text), toast() {}, openDialog: () => ({ close() {} }),
    artworkEditor() {},
    api: async () => ({ artworks: [] }),
    put: async (path, body) => {
      calls.push({ kind: 'put', path, body: structuredClone(body) });
      if (failSave) throw new Error('模拟保存失败');
      stored = { ...stored, ...structuredClone(body), confirmed: revokeConfirmation ? false : body.confirmed };
      return { plan: structuredClone(stored) };
    },
    post: async (path, body) => {
      calls.push({ kind: 'post', path, body: structuredClone(body) });
      if (path.endsWith('/preview')) {
        const custom = Object.hasOwn(stored.answers, 'custom_prompt');
        return { prompt: custom ? stored.answers.custom_prompt.trim() : '根据当前回答整理的模板', template_prompt: templateError ? '' : '根据当前回答整理的模板', template_error: templateError, prompt_mode: custom ? 'custom' : 'template', missing: custom && !stored.answers.custom_prompt.trim() ? ['手动改写提示词'] : [] };
      }
      return { job: generation, user };
    },
  });
  vm.runInContext(stepsSource + '\n' + creditsSource + '\n' + source + '\nthis.makeWorkspace = createWorkspace;', context);
  const result = context.makeWorkspace(structuredClone(stored), { user, configured, onUser() {}, onGoAdmin() {}, onOpenGallery() {} });
  t.after(result.dispose);
  const findButton = text => result.node.querySelectorAll('button').find(node => node.textContent === text || node.textContent.startsWith(text));
  return { result, root: result.node, calls, findButton };
}

test('旧草稿显示自动取景，新选项实际保存且不增加必填', async t => {
  const page = workspace(t, { step: 3 });
  const framing = page.root.querySelector('[name="subject_framing"]');
  const distance = page.root.querySelector('[name="scene_distance"]');
  assert.ok(framing); assert.ok(distance);
  assert.equal(framing.value, '自动'); assert.equal(distance.value, '自动');
  assert.match(framing.textContent, /全身.*半身.*特写/);
  assert.match(distance.textContent, /远景.*中景.*近景/);
  assert.equal(framing.required, false); assert.equal(distance.required, false);
  await framing.fire('change', '半身'); await distance.fire('change', '近景');
  await page.result.save();
  assert.equal(page.calls.at(-1).body.answers.subject_framing, '半身');
  assert.equal(page.calls.at(-1).body.answers.scene_distance, '近景');
});

test('手动提示词可编辑并保存，编辑后可见自查与确认状态同步清除', async t => {
  const page = workspace(t, { confirmed: true, answers: { custom_prompt: '原手动提示词' } });
  const editor = page.root.querySelector('[name="custom_prompt"]');
  assert.ok(editor); assert.notEqual(editor.readOnly, true); assert.equal(editor.value, '原手动提示词');
  await editor.fire('input', '改写后的主体动作\n围绕人机共生表达');
  assert.equal(page.root.querySelector('[name="custom_prompt"]'), editor, '输入过程中不替换文本框');
  assert.ok(page.root.querySelectorAll('input').filter(node => node.attrs.type === 'checkbox').every(node => !node.checked));
  assert.match(page.root.querySelector('.workspace-lock').textContent, /完成并确认/);
  await page.result.save();
  assert.equal(page.calls.at(-1).body.answers.custom_prompt, editor.value);
  assert.equal(page.calls.at(-1).body.confirmed, false);
  const reopened = workspace(t, { answers: { custom_prompt: editor.value } });
  assert.equal(reopened.root.querySelector('[name="custom_prompt"]').value, editor.value);
});

test('模板预览可以改写，清空后仍保留编辑内容并阻止确认', async t => {
  const page = workspace(t);
  await page.findButton('检查计划并预览提示词').fire('click');
  const editor = page.root.querySelector('[name="custom_prompt"]');
  assert.ok(editor); assert.equal(editor.value, '根据当前回答整理的模板');
  await editor.fire('input', '');
  for (const checkbox of page.root.querySelectorAll('input').filter(node => node.attrs.type === 'checkbox')) { checkbox.checked = true; await checkbox.fire('change'); }
  await page.findButton('确认计划，进入生成').fire('click');
  assert.equal(page.root.querySelector('[name="custom_prompt"]').value, '');
  assert.equal(page.calls.some(call => call.kind === 'put' && call.body.confirmed), false);
});

test('修改前面内容保留手动词，明确恢复模板会删除自定义键', async t => {
  const page = workspace(t, { answers: { custom_prompt: '学生自己写的提示词' } });
  await page.root.querySelector('[name="innovation"]').fire('input', '改过的创新点');
  await page.findButton('检查计划并预览提示词').fire('click');
  assert.equal(page.root.querySelector('[name="custom_prompt"]').value, '学生自己写的提示词');
  await page.findButton('根据当前回答恢复提示词').fire('click');
  assert.equal(Object.hasOwn(page.calls.filter(call => call.kind === 'put').at(-1).body.answers, 'custom_prompt'), false);
  assert.equal(page.root.querySelector('[name="custom_prompt"]').value, '根据当前回答整理的模板');
});

test('自动模板超限时，恢复操作保留已保存的手动提示词', async t => {
  const page = workspace(t, { answers: { custom_prompt: '学生精简后的有效提示词' }, templateError: '自动模板太长，请精简原回答。' });
  await page.findButton('根据当前回答恢复提示词').fire('click');
  assert.equal(page.root.querySelector('[name="custom_prompt"]').value, '学生精简后的有效提示词');
  assert.match(page.root.textContent, /自动模板太长/);
  assert.ok(page.calls.filter(call => call.kind === 'put').every(call => call.body.answers.custom_prompt === '学生精简后的有效提示词'));
});

test('服务端未确认方案时不能进入生成页', async t => {
  const page = workspace(t, { confirmed: true, revokeConfirmation: true });
  await page.findButton('确认计划，进入生成').fire('click');
  assert.match(page.root.querySelector('.step-card-heading').textContent, /你的特别之处/);
  assert.equal(page.root.querySelector('[data-generate]'), null);
});

test('生成前保存返回未确认时不发送生成请求', async t => {
  const page = workspace(t, { step: 5, confirmed: true, revokeConfirmation: true });
  await page.findButton('确认生成 1 张').fire('click');
  assert.equal(page.calls.filter(call => call.path === '/api/generate').length, 0);
});

test('生成前保存失败时不创建收费请求', async t => {
  const page = workspace(t, { step: 5, confirmed: true, failSave: true });
  await page.findButton('确认生成 1 张').fire('click');
  assert.equal(page.calls.filter(call => call.path === '/api/generate').length, 0);
});

test('零数字余额的管理员仍能生成，桌面和手机显示无限且结果不扣算力', async t => {
  const user = { id: 'admin-local', role: 'admin', unlimited_credits: true, credits: 0, reserved_credits: 0, available_credits: 0 };
  const page = workspace(t, { step: 5, confirmed: true, user, generation: { id: 'job-local', status: 'succeeded', unlimited_credits: true } });
  assert.match(page.root.querySelector('.generation-balance').textContent, /无限/);
  assert.match(page.root.querySelector('.mobile-credit-summary').textContent, /无限/);
  assert.doesNotMatch(page.root.textContent, /请联系管理员进行补充算力/);
  const generate = page.root.querySelector('[data-generate]');
  assert.equal(generate.disabled, false);
  assert.doesNotMatch(generate.textContent, /消耗 1 点/);
  await generate.fire('click');
  assert.equal(page.calls.filter(call => call.path === '/api/generate').length, 1);
  assert.match(page.root.textContent, /本次不消耗算力/);
  assert.doesNotMatch(page.root.textContent, /本次消耗 1 点算力/);
});

test('学生算力用尽时仍无法生成，且显示联系管理员提示', async t => {
  const page = workspace(t, { step: 5, confirmed: true, user: { id: 'student-local', role: 'student', unlimited_credits: false, credits: 0, available_credits: 0 } });
  const generate = page.root.querySelector('[data-generate]');
  assert.equal(generate.disabled, true);
  assert.match(page.root.textContent, /请联系管理员进行补充算力/);
  await generate.fire('click');
  assert.equal(page.calls.filter(call => call.path === '/api/generate').length, 0);
});

test('管理员无限算力也必须配置服务与确认计划', async t => {
  const user = { id: 'admin-local', role: 'admin', credits: 0 };
  const noConfig = workspace(t, { step: 5, confirmed: true, user, configured: false });
  assert.equal(noConfig.root.querySelector('[data-generate]').disabled, true);
  const unconfirmed = workspace(t, { step: 5, confirmed: false, user });
  assert.equal(unconfirmed.root.querySelector('[data-generate]').disabled, true);
});
