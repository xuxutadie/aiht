import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/auth.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export function authScreen', 'function authScreen');

// 模拟登录表单需要的 DOM 和 API，无真实注册或登录请求。
class FormNode {
  constructor(tag, attrs, children) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
    this.handlers = {};
    this.value = attrs.value ?? '';
    this.disabled = Boolean(attrs.disabled);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) this.addEventListener(key.slice(2).toLowerCase(), value);
    }
    this.append(...children);
  }
  append(...children) { this.children.push(...children.flat(Infinity).filter(child => child !== null && child !== undefined)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  set textContent(text) { this.children = [String(text)]; }
  get textContent() { return this.children.map(child => child instanceof FormNode ? child.textContent : String(child)).join(''); }
  findAll(predicate) {
    return this.children.flatMap(child => child instanceof FormNode ? [...(predicate(child) ? [child] : []), ...child.findAll(predicate)] : []);
  }
  addEventListener(type, listener) { (this.handlers[type] ||= []).push(listener); }
  reportValidity() { return true; }
  reset() { for (const field of this.findAll(node => node.tag === 'input')) field.value = field.attrs.value ?? ''; }
  async fire(type) { for (const listener of this.handlers[type] || []) await listener({ preventDefault() {}, target: this }); }
}

function authPage({ setupRequired = false, code, message = '该手机号已注册，请直接登录。' } = {}) {
  const requests = [];
  const el = (tag, attrs = {}, ...children) => new FormNode(tag, attrs, children);
  const context = vm.createContext({
    el,
    button: (label, onClick, className, attrs = {}) => el('button', { type: 'button', className, onClick, ...attrs }, label),
    notice: (text, kind) => el('p', { className: `notice ${kind}` }, text),
    inputField: ({ name, label, ...attrs }) => el('div', {}, el('label', {}, label), el('input', { name, ...attrs })),
    clearAuthorizationCodes() {},
    FormData: function (form) { return form.findAll(node => node.tag === 'input').map(({ attrs, value }) => [attrs.name, value]); },
    post: async (path, payload) => {
      requests.push({ path, payload: { ...payload } });
      throw Object.assign(new Error(message), { code, status: 409 });
    },
  });
  vm.runInContext(source + '\nthis.makeAuth = authScreen;', context);
  const root = context.makeAuth(setupRequired, () => assert.fail('失败请求不应登录'));
  const field = name => root.findAll(node => node.tag === 'input' && node.attrs.name === name)[0];
  const button = label => root.findAll(node => node.tag === 'button' && node.textContent === label)[0];
  const error = () => root.findAll(node => node.attrs.className === 'form-error')[0];
  const submit = () => root.findAll(node => node.tag === 'form')[0].fire('submit');
  return { root, field, button, error, submit, requests };
}

test('重复注册时显示去登录入口，切换后只保留手机号，不保留密码或授权码', async () => {
  const page = authPage({ code: 'phone_registered' });
  await page.button('注册新账户').fire('click');
  page.field('phone').value = '13800138000';
  page.field('password').value = 'test-password-only';
  page.field('authorization_code').value = '12345678';
  await page.submit();
  assert.equal(page.requests[0].path, '/api/register');
  assert.match(page.error().textContent, /该手机号已注册，请直接登录。/);
  const goLogin = page.error().findAll(node => node.tag === 'button' && node.textContent === '去登录')[0];
  assert.ok(goLogin, '重复手机号提示下应显示去登录按钮');
  assert.equal(goLogin.attrs.type, 'button');
  await goLogin.fire('click');
  assert.ok(page.button('登录，继续创作'));
  assert.equal(page.field('phone').value, '13800138000');
  assert.equal(page.field('password').value, '');
  assert.equal(page.field('authorization_code'), undefined);
  assert.equal(page.error().textContent, '');
  assert.equal(page.requests.length, 1, '去登录按钮不能自动提交请求');
});

test('其他注册错误保持原提示，不显示去登录入口', async () => {
  const message = '授权码已使用，请联系管理员。';
  const page = authPage({ code: 'authorization_code_used', message });
  await page.button('注册新账户').fire('click');
  await page.submit();
  assert.equal(page.error().textContent, message);
  assert.equal(page.button('去登录'), undefined);
  assert.ok(page.button('验证授权码并注册'));
});

test('登录或管理员初始化中的同名错误不显示注册专用跳转按钮', async () => {
  for (const setupRequired of [false, true]) {
    const page = authPage({ setupRequired, code: 'phone_registered' });
    await page.submit();
    assert.equal(page.error().textContent, '该手机号已注册，请直接登录。');
    assert.equal(page.button('去登录'), undefined);
  }
});
