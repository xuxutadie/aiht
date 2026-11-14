import { post } from './api.js';
import { el, button, inputField, notice } from './ui.js';

export function authScreen(setupRequired, onSignedIn) {
  let mode = setupRequired ? 'setup' : 'login';
  const root = el('main', { id: 'main', className: 'auth-page' });
  const render = () => {
    const title = mode === 'setup' ? '先为创作台设置一位管理员' : mode === 'register' ? '开启你的第一次创作' : '欢迎回到创作台';
    const form = el('form', { className: 'auth-form' });
    const error = el('div', { className: 'form-error', 'aria-live': 'polite' });
    if (mode !== 'login') form.append(inputField({ name: 'name', label: '姓名', required: true, autocomplete: 'name', maxlength: 30 }));
    form.append(inputField({ name: 'phone', label: '手机号', type: 'tel', required: true, autocomplete: 'tel', inputmode: 'tel', maxlength: 20 }), inputField({ name: 'password', label: '密码', type: 'password', required: true, autocomplete: mode === 'login' ? 'current-password' : 'new-password', minlength: 8, maxlength: 128, hint: mode === 'login' ? undefined : '至少 8 位，建议同时包含字母和数字。' }));
    if (mode === 'register') {
      form.append(inputField({ name: 'region', label: '所在地区', required: true, maxlength: 80, placeholder: '省 / 市 / 区县', autocomplete: 'address-level2' }), inputField({ name: 'school', label: '学校', required: true, maxlength: 80, autocomplete: 'organization' }), inputField({ name: 'grade', label: '年级', required: true, options: [['', '请选择年级'], '小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级', '初一', '初二', '初三', '其他'] }));
    }
    const submit = el('button', { type: 'submit', className: 'button primary full-width' }, mode === 'setup' ? '创建管理员并进入' : mode === 'register' ? '注册并领取 10 点算力' : '登录，继续创作');
    form.append(error, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity() || submit.disabled) return;
      submit.disabled = true; submit.textContent = '正在处理…'; error.replaceChildren();
      const payload = Object.fromEntries(new FormData(form));
      try { const result = await post(`/api/${mode}`, payload); form.reset(); await onSignedIn(result.user); }
      catch (err) { error.replaceChildren(notice(err.message, 'error')); submit.disabled = false; submit.textContent = mode === 'setup' ? '创建管理员并进入' : mode === 'register' ? '注册并领取 10 点算力' : '登录，继续创作'; }
      finally { payload.password = ''; submit.disabled = false; submit.textContent = mode === 'setup' ? '创建管理员并进入' : mode === 'register' ? '注册并领取 10 点算力' : '登录，继续创作'; }
    });
    const tabs = !setupRequired ? el('div', { className: 'auth-tabs', 'aria-label': '登录方式' }, ...[['login', '登录'], ['register', '注册新账户']].map(([value, label]) => button(label, () => { mode = value; render(); }, `button ${mode === value ? 'tab-active' : 'secondary'}`, { 'aria-pressed': mode === value }))) : notice('首次初始化仅在本机完成。此账户可以配置绘图服务、查看学生资料并核对任务。', 'info');
    root.replaceChildren(el('section', { className: 'auth-story' }, el('a', { className: 'brand', href: '/', 'aria-label': '作品创作台首页' }, el('span', { className: 'brand-mark' }, '创'), el('span', {}, '作品创作台')), el('div', { className: 'auth-story-content' }, el('span', { className: 'eyebrow blue' }, '从一个想法，到一件自己的作品'), el('h1', {}, '先把想法，', el('br'), '说得清清楚楚。'), el('p', {}, '读懂任务、确定主题、设计画面。用七个清晰的步骤，留下你的观察与创意。'), el('div', { className: 'auth-step-chips' }, el('span', { className: 'chip mint' }, '先想清楚'), el('span', { className: 'chip pink' }, '再做出来'), el('span', { className: 'chip yellow' }, '讲出自己的思考'))), el('p', { className: 'muted' }, '创作属于你 · 工具帮助你表达')), el('section', { className: 'auth-card card' }, tabs, el('h2', {}, title), mode === 'register' ? el('p', { className: 'muted' }, '每个新账户首次获赠 10 点算力，成功生成 1 张消耗 1 点。') : null, form));
  };
  render();
  return root;
}
