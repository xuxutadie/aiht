import { api, post, put } from './api.js';
import { el, button, inputField, notice, toast, openDialog, formatTime } from './ui.js';
import { authorizationCodesCard } from './authorization-codes.js';

const DRAWING_SERVICES = {
  ark: { label: '豆包 · 火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-flash-260915' },
  'openai-hk': { label: 'OpenAI-HK · GPT Image 2', base: 'https://api.openai-hk.com/v1', model: 'gpt-image-2' },
};
const serviceOf = settings => settings.base_url?.startsWith('https://api.openai-hk.com') ? 'openai-hk' : 'ark';

function drawingSettingsForm(initialSettings, ctx) {
  let savedSettings = initialSettings;
  const form = el('form', { className: 'settings-form' });
  const status = el('div');
  const feedback = el('div', { 'aria-live': 'polite' });
  const keyHint = el('p', { className: 'muted', 'aria-live': 'polite' });
  const providerField = inputField({ name: 'drawing_service', label: '绘图服务商', value: serviceOf(savedSettings),
    options: Object.entries(DRAWING_SERVICES).map(([value, service]) => [value, service.label]) });
  const qualityField = inputField({ name: 'quality', label: '绘图清晰度', value: savedSettings.quality || 'low',
    options: [['low', '基础（low）'], ['medium', '标准（medium）'], ['high', '精细（high）']],
    hint: '清晰度会影响服务商实际费用；新接入默认使用基础档。' });
  const watermarkField = el('label', { className: 'check-label' },
    el('input', { name: 'watermark', type: 'checkbox', checked: savedSettings.watermark !== false }), el('span', {}, '保留生成图片的水印'));
  const save = el('button', { type: 'submit', className: 'button primary' }, '保存绘图服务配置');
  form.append(status, providerField,
    inputField({ name: 'api_key', label: '绘图 API 密钥', type: 'password', value: '', autocomplete: 'off', maxlength: 512,
      hint: '请填写当前服务商的密钥。保存后输入框会清空，完整密钥不会返回学生端。' }),
    keyHint,
    inputField({ name: 'base_url', label: '接口根地址', type: 'url', required: true, readOnly: true,
      hint: '选择服务商后自动填写对应的接口地址。' }),
    inputField({ name: 'model', label: '绘图模型', required: true, maxlength: 128 }),
    qualityField, watermarkField, feedback, save);

  function refreshFields(resetValues = true) {
    const selected = form.elements.drawing_service.value;
    const service = DRAWING_SERVICES[selected];
    const sameProvider = selected === serviceOf(savedSettings);
    const hk = selected === 'openai-hk';
    if (resetValues) {
      form.elements.base_url.value = service.base;
      form.elements.model.value = sameProvider ? savedSettings.model || service.model : service.model;
      form.elements.quality.value = sameProvider ? savedSettings.quality || 'low' : 'low';
    }
    form.elements.model.readOnly = hk;
    qualityField.hidden = !hk;
    form.elements.quality.disabled = !hk;
    watermarkField.hidden = hk;
    form.elements.watermark.disabled = hk;
    form.elements.api_key.required = !savedSettings.configured || !sameProvider;
    keyHint.textContent = !sameProvider ? '切换服务商时，请重新填写对应密钥；原服务商密钥不会自动沿用。'
      : savedSettings.configured ? '当前服务已配置；密钥留空可保留已保存的值。' : '尚未配置密钥，学生暂时只能填写和保存创作计划。';
    status.replaceChildren(notice(savedSettings.configured
      ? `绘图服务已配置 · 密钥标记：${savedSettings.key_hint || '已保存'}`
      : '还未配置绘图服务。完成设置后学生才能生成。', savedSettings.configured ? 'success' : 'info'));
  }
  form.elements.drawing_service.addEventListener('change', () => {
    // 切换服务商时清除尚未提交的密钥，避免误发到另一平台。
    form.elements.api_key.value = '';
    feedback.replaceChildren();
    refreshFields();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled || !form.reportValidity()) return;
    const payload = { base_url: form.elements.base_url.value, model: form.elements.model.value,
      api_key: form.elements.api_key.value, quality: form.elements.quality.value,
      watermark: form.elements.watermark.checked };
    const controls = [...form.querySelectorAll('input, select, button')];
    controls.forEach(control => { control.disabled = true; });
    feedback.replaceChildren();
    try {
      const saved = await put('/api/admin/settings', payload);
      form.elements.api_key.value = '';
      savedSettings = saved;
      ctx.onConfigured(saved.configured);
      feedback.replaceChildren(notice(`配置已保存 · 密钥标记：${saved.key_hint || '已保存'}`, 'success'));
    } catch (err) { feedback.replaceChildren(notice(err.message, 'error')); }
    finally {
      payload.api_key = '';
      controls.forEach(control => { control.disabled = false; });
      // 失败时保留刚填写的模型和清晰度，便于修正密钥后重试。
      refreshFields(false);
    }
  });
  refreshFields();
  return form;
}

export async function renderAdmin(host, ctx) {
  host.replaceChildren(notice('正在读取管理信息…'));
  try {
    const [settings, overview] = await Promise.all([api('/api/admin/settings'), api('/api/admin/overview')]);
    const serviceStatus = el('strong', {}, settings.configured ? '已配置' : '待配置');
    const settingsForm = drawingSettingsForm(settings, { ...ctx, onConfigured(configured) {
      ctx.onConfigured(configured);
      serviceStatus.textContent = configured ? '已配置' : '待配置';
    } });
    const users = overview.users || [];
    const pending = overview.uncertain_jobs || [];
    const overviewCards = el('div', { className: 'admin-stats' }, el('div', { className: 'stat-card mint' }, el('span', {}, '学生账户'), el('strong', {}, users.filter(user => user.role === 'student').length)), el('div', { className: 'stat-card yellow' }, el('span', {}, '待核对任务'), el('strong', {}, pending.length)), el('div', { className: 'stat-card pink' }, el('span', {}, '绘图服务'), serviceStatus));
    const userTable = el('div', { className: 'table-scroll', tabindex: '0', 'aria-label': '学生资料表，可横向滚动' }, el('table', {}, el('caption', { className: 'sr-only' }, '账户资料与算力点数'), el('thead', {}, el('tr', {}, ['姓名 / 身份', '手机号', '地区', '学校 / 年级', '可用 / 预留（点）', '注册时间'].map(label => el('th', { scope: 'col' }, label)))), el('tbody', {}, users.map(user => el('tr', {}, el('td', {}, el('strong', {}, user.name), el('small', {}, user.role === 'admin' ? '管理员' : '学生')), el('td', {}, user.phone), el('td', {}, user.region || '—'), el('td', {}, user.school || '—', el('small', {}, user.grade || '—')), el('td', {}, `${user.available_credits ?? user.credits} / ${user.reserved_credits || 0}`), el('td', {}, formatTime(user.created_at)))))));
    const pendingList = pending.length ? el('div', { className: 'pending-list' }, pending.map(job => {
      const user = users.find(item => String(item.id) === String(job.user_id));
      return el('article', { className: 'pending-job' }, el('div', {}, el('strong', {}, `${user?.name || '账户'} · 任务 ${String(job.id).slice(0, 8)}`), el('p', {}, job.error_message || '上游结果尚不确定，需要人工核对。'), el('small', {}, formatTime(job.created_at)), el('p', {className: 'muted'}, `上游请求编号：${job.upstream_request_id || '暂未返回，请按时间和任务核对'}`)), el('div', { className: 'button-row' }, button('确认已出图，消耗 1 点', () => resolveJob(job, true), 'button small primary'), button('确认未出图，释放预留 1 点', () => resolveJob(job, false), 'button small secondary')));
    })) : el('p', { className: 'muted' }, '当前没有需要人工核对的任务。');
    host.replaceChildren(overviewCards, authorizationCodesCard(users), el('div', { className: 'admin-grid' }, el('section', { className: 'card section-card' }, el('h2', {}, '绘图服务配置'), settingsForm), el('section', { className: 'card section-card pending-section' }, el('h2', {}, '待核对任务'), el('p', { className: 'muted' }, '先在服务商记录中核实结果，再决定消耗算力或释放预留。请填写可追溯的核对理由。'), pendingList)), el('section', { className: 'card section-card' }, el('div', { className: 'section-heading' }, el('h2', {}, '账户与学生资料'), button('刷新', () => renderAdmin(host, ctx), 'button small secondary')), userTable));

    function resolveJob(job, consume) {
      const title = consume ? '确认消耗 1 点' : '确认释放预留 1 点';
      const form = el('form', {}, notice(consume ? '仅在确认上游已经成功出图后消耗 1 点算力。本操作会写入算力记录。' : '仅在确认上游没有成功出图后释放预留的 1 点算力。本操作会写入算力记录。', 'warning'), inputField({ name: 'reason', label: '核对理由', required: true, multiline: true, minlength: 5, maxlength: 1000, placeholder: '写明核查渠道、结果或关联记录。' }), el('label', { className: 'check-label' }, el('input', { type: 'checkbox', required: true }), el('span', {}, '我已核实这项任务的实际结果。')));
      const feedback = el('div', { 'aria-live': 'polite' });
      const submit = el('button', { type: 'submit', className: 'button primary' }, title);
      const dialog = openDialog(title, form);
      form.append(feedback, el('div', { className: 'button-row' }, button('取消', () => dialog.close(), 'button secondary'), submit));
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (!form.reportValidity() || submit.disabled) return;
        submit.disabled = true;
        try { await post(`/api/admin/jobs/${encodeURIComponent(job.id)}/resolve`, { consume, reason: form.elements.reason.value }); dialog.close(); toast('核对结果已保存'); renderAdmin(host, ctx); }
        catch (err) { feedback.replaceChildren(notice(err.message, 'error')); submit.disabled = false; }
      });
    }
  } catch (err) { host.replaceChildren(notice(err.message, 'error'), button('重新读取', () => renderAdmin(host, ctx), 'button secondary')); }
}
