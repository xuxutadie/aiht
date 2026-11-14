import { api, post, put } from './api.js';
import { el, button, inputField, notice, toast, openDialog, formatTime } from './ui.js';

export async function renderAdmin(host, ctx) {
  host.replaceChildren(notice('正在读取管理信息…'));
  try {
    const [settings, overview] = await Promise.all([api('/api/admin/settings'), api('/api/admin/overview')]);
    const settingsForm = el('form', { className: 'settings-form' });
    const result = el('div', { 'aria-live': 'polite' });
    settingsForm.append(notice(settings.configured ? `绘图服务已配置 · 密钥标记：${settings.key_hint || '已保存（不显示完整密钥）'}` : '还未配置绘图服务。学生可以保存计划，配置完成后才能生成。', settings.configured ? 'success' : 'info'), inputField({ name: 'api_key', label: '火山方舟 API 密钥', type: 'password', value: '', autocomplete: 'off', maxlength: 500, hint: '已配置时留空表示保留原密钥。保存成功后，输入框会立即清空。密钥不会返回到浏览器。' }), inputField({ name: 'model', label: '绘图模型', value: settings.model || 'doubao-seedream-5-0-flash-260915', required: true, maxlength: 160 }), inputField({ name: 'base_url', label: '官方接口地址', type: 'url', value: settings.base_url || 'https://ark.cn-beijing.volces.com/api/v3', required: true, maxlength: 300, hint: '使用官方 HTTPS 地址。模型与地址将由服务器校验。' }), el('label', { className: 'check-label' }, el('input', { name: 'watermark', type: 'checkbox', checked: settings.watermark !== false }), el('span', {}, '保留生成图片的水印')), result);
    const save = el('button', { type: 'submit', className: 'button primary' }, '保存绘图服务配置');
    settingsForm.append(save);
    settingsForm.addEventListener('submit', async event => {
      event.preventDefault(); if (!settingsForm.reportValidity() || save.disabled) return;
      save.disabled = true; result.replaceChildren();
      const payload = Object.fromEntries(new FormData(settingsForm)); payload.watermark = settingsForm.elements.watermark.checked;
      try {
        const saved = await put('/api/admin/settings', payload);
        settingsForm.elements.api_key.value = ''; payload.api_key = '';
        ctx.onConfigured(saved.configured);
        result.replaceChildren(notice(`配置已保存 · 密钥标记：${saved.key_hint || '已保存'}`, 'success'));
      } catch (err) { result.replaceChildren(notice(err.message, 'error')); }
      finally { payload.api_key = ''; save.disabled = false; }
    });
    const users = overview.users || [];
    const pending = overview.uncertain_jobs || [];
    const overviewCards = el('div', { className: 'admin-stats' }, el('div', { className: 'stat-card mint' }, el('span', {}, '学生账户'), el('strong', {}, users.filter(user => user.role === 'student').length)), el('div', { className: 'stat-card yellow' }, el('span', {}, '待核对任务'), el('strong', {}, pending.length)), el('div', { className: 'stat-card pink' }, el('span', {}, '绘图服务'), el('strong', {}, settings.configured ? '已配置' : '待配置')));
    const userTable = el('div', { className: 'table-scroll', tabindex: '0', 'aria-label': '学生资料表，可横向滚动' }, el('table', {}, el('caption', { className: 'sr-only' }, '账户资料与算力点数'), el('thead', {}, el('tr', {}, ['姓名 / 身份', '手机号', '地区', '学校 / 年级', '可用 / 预留（点）', '注册时间'].map(label => el('th', { scope: 'col' }, label)))), el('tbody', {}, users.map(user => el('tr', {}, el('td', {}, el('strong', {}, user.name), el('small', {}, user.role === 'admin' ? '管理员' : '学生')), el('td', {}, user.phone), el('td', {}, user.region || '—'), el('td', {}, user.school || '—', el('small', {}, user.grade || '—')), el('td', {}, `${user.available_credits ?? user.credits} / ${user.reserved_credits || 0}`), el('td', {}, formatTime(user.created_at)))))));
    const pendingList = pending.length ? el('div', { className: 'pending-list' }, pending.map(job => {
      const user = users.find(item => String(item.id) === String(job.user_id));
      return el('article', { className: 'pending-job' }, el('div', {}, el('strong', {}, `${user?.name || '账户'} · 任务 ${String(job.id).slice(0, 8)}`), el('p', {}, job.error_message || '上游结果尚不确定，需要人工核对。'), el('small', {}, formatTime(job.created_at)), el('p', {className: 'muted'}, `上游请求编号：${job.upstream_request_id || '暂未返回，请按时间和任务核对'}`)), el('div', { className: 'button-row' }, button('确认已出图，消耗 1 点', () => resolveJob(job, true), 'button small primary'), button('确认未出图，释放预留 1 点', () => resolveJob(job, false), 'button small secondary')));
    })) : el('p', { className: 'muted' }, '当前没有需要人工核对的任务。');
    host.replaceChildren(overviewCards, el('div', { className: 'admin-grid' }, el('section', { className: 'card section-card' }, el('h2', {}, '绘图服务配置'), settingsForm), el('section', { className: 'card section-card pending-section' }, el('h2', {}, '待核对任务'), el('p', { className: 'muted' }, '先在服务商记录中核实结果，再决定消耗算力或释放预留。请填写可追溯的核对理由。'), pendingList)), el('section', { className: 'card section-card' }, el('div', { className: 'section-heading' }, el('h2', {}, '账户与学生资料'), button('刷新', () => renderAdmin(host, ctx), 'button small secondary')), userTable));

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
