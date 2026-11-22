import { api, post } from './api.js';
import { el, button, inputField, notice, formatTime } from './ui.js';

// 仅保留本页面会话内的完整码；重用卡片节点，避免刷新其他管理功能时丢失。
let activeCard = null;
export function clearAuthorizationCodes() { activeCard = null; }

export function authorizationCodesCard(users = []) {
  if (!activeCard) activeCard = createCard();
  activeCard.setUsers(users);
  activeCard.refresh();
  return activeCard.node;
}

function createCard() {
  let users = [];
  let batch = [];
  let history = [];
  let nextCursor = null;
  let generating = false;
  let reading = false;
  let requestVersion = 0;
  const feedback = el('div', { 'aria-live': 'polite' });
  const copyFeedback = el('div', { 'aria-live': 'polite' });
  const batchHost = el('div', { className: 'authorization-batch', hidden: true });
  const historyFeedback = el('div', { 'aria-live': 'polite' });
  const historyBody = el('tbody');
  const refresh = button('刷新状态', () => readHistory(), 'button small secondary');
  const more = button('加载更多', () => readHistory(true), 'button small secondary', { hidden: true });
  const historyTable = el('div', { className: 'table-scroll', tabindex: '0', 'aria-label': '授权码使用记录，可横向滚动' },
    el('table', { className: 'authorization-history' }, el('caption', { className: 'sr-only' }, '授权码使用记录，仅显示尾四位'),
      el('thead', {}, el('tr', {}, ['授权码', '状态', '生成时间', '使用时间', '使用者'].map(label => el('th', { scope: 'col' }, label)))), historyBody));
  const countField = inputField({ name: 'authorization_count', label: '本次生成数量', type: 'number', value: '10', min: 1, max: 100, step: 1, required: true, inputmode: 'numeric', hint: '单次 1～100 个，可多次生成，累计不限。' });
  const submit = el('button', { type: 'submit', className: 'button primary' }, '生成授权码');
  const form = el('form', { className: 'authorization-form' }, countField, submit);
  const node = el('section', { className: 'card section-card authorization-section' },
    el('h2', {}, '注册授权码'),
    el('p', { className: 'muted' }, '新用户凭 8 位数字授权码注册，一人一码，注册成功后失效。已有账户照常登录。'),
    notice('完整授权码仅生成时显示，请先复制保存。刷新、关闭页面或退出登录后，历史记录仅能查看尾四位。', 'warning'),
    form, feedback, batchHost,
    el('div', { className: 'section-heading authorization-history-heading' }, el('h3', {}, '授权码使用记录'), refresh),
    historyFeedback, historyTable, el('div', { className: 'button-row' }, more));

  async function copyCodes(text, control) {
    if (control.disabled) return;
    control.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(text);
      copyFeedback.replaceChildren(notice('已复制，请粘贴保存后再发给学生。', 'success'));
    } catch {
      // 剪贴板被浏览器拦截时提供可选文本，复制操作不会重新生成授权码。
      const fallback = el('textarea', { className: 'authorization-copy-text', readOnly: true, rows: Math.min(8, text.split('\n').length), 'aria-label': '待复制的授权码', value: text });
      copyFeedback.replaceChildren(notice('浏览器暂不支持自动复制，请选中下方文本后复制保存。', 'info'), fallback,
        button('选中全部文本', () => { fallback.focus(); fallback.select(); }, 'button small secondary'));
      fallback.focus(); fallback.select();
    } finally { control.disabled = false; }
  }

  function renderBatch() {
    batchHost.hidden = !batch.length;
    if (!batch.length) return;
    copyFeedback.replaceChildren();
    const copyAll = button('一键复制本批', event => copyCodes(batch.map(item => item.code).join('\n'), event.currentTarget), 'button small primary');
    batchHost.replaceChildren(el('div', { className: 'section-heading' }, el('h3', {}, `本批完整授权码（${batch.length} 个）`), copyAll),
      el('p', { className: 'muted' }, '请先复制本批。再次成功生成后，下方将显示新的一批。'),
      el('div', { className: 'authorization-code-grid' }, batch.map(item => el('div', { className: 'authorization-code-item' },
        el('code', { className: 'authorization-code' }, item.code),
        button('复制', event => copyCodes(item.code, event.currentTarget), 'button small secondary', { 'aria-label': `复制授权码 ${item.code}` })))), copyFeedback);
  }

  function renderHistory() {
    historyBody.replaceChildren(...history.map(item => {
      const user = users.find(candidate => String(candidate.id) === String(item.used_by));
      const used = item.status === 'used';
      // 即使接口意外带回完整码，历史区也只取数字尾四位。
      const tail = String(item.code_hint || '').replace(/\D/g, '').slice(-4);
      return el('tr', {}, el('td', {}, el('code', {}, `****${tail || '????'}`)),
        el('td', {}, el('span', { className: `authorization-status ${used ? 'pink' : 'mint'}` }, used ? '已使用' : '未使用')),
        el('td', {}, formatTime(item.created_at)), el('td', {}, used ? formatTime(item.used_at) : '—'),
        el('td', {}, used ? user?.name || '已注册账户' : '—'));
    }));
    more.hidden = nextCursor === null;
  }

  async function readHistory(append = false) {
    if (append && (reading || nextCursor === null)) return;
    const requestId = ++requestVersion;
    const cursor = append ? nextCursor : null;
    reading = true; refresh.disabled = true; more.disabled = true;
    historyFeedback.replaceChildren(notice(append ? '正在加载更多授权码…' : '正在读取授权码状态…'));
    try {
      const result = await api(`/api/admin/authorization-codes?limit=50${cursor === null ? '' : `&before=${encodeURIComponent(cursor)}`}`);
      if (requestId !== requestVersion) return;
      const incoming = Array.isArray(result.codes) ? result.codes : [];
      const rows = append ? [...history, ...incoming] : incoming;
      history = rows.filter((item, index) => rows.findIndex(candidate => String(candidate.id) === String(item.id)) === index);
      nextCursor = result.next_cursor ?? null;
      renderHistory();
      historyFeedback.replaceChildren(...(history.length ? [] : [notice('还没有授权码，先生成一批发给学生。', 'info')]));
    } catch (err) {
      if (requestId !== requestVersion) return;
      historyFeedback.replaceChildren(notice(`状态读取失败：${err.message} 请点击“刷新状态”重试。`, 'error'));
    } finally {
      if (requestId === requestVersion) { reading = false; refresh.disabled = false; more.disabled = false; }
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (generating || !form.reportValidity()) return;
    const count = Number(form.elements.authorization_count.value);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      feedback.replaceChildren(notice('请输入 1～100 之间的整数。', 'error')); return;
    }
    generating = true; submit.disabled = true; form.elements.authorization_count.disabled = true;
    submit.textContent = '正在生成…'; feedback.replaceChildren();
    try {
      const result = await post('/api/admin/authorization-codes', { count });
      if (!Array.isArray(result.codes) || result.codes.length !== count || result.codes.some(item => !/^[0-9]{8}$/.test(item.code))) {
        throw new Error('生成结果不完整，本次是否生成成功尚未确认。');
      }
      batch = result.codes;
      renderBatch();
      feedback.replaceChildren(notice(`已生成 ${batch.length} 个授权码，请先复制保存。`, 'success'));
      await readHistory();
    } catch (err) {
      const uncertain = !err.status || err.status >= 500 || err.code === 'INVALID_RESPONSE';
      feedback.replaceChildren(notice(`${err.message}${uncertain ? ' 本次请求结果尚未确认，请先刷新使用记录核对生成时间和数量，再决定是否重新生成，避免重复。' : ''}`, 'error'));
    } finally {
      generating = false; submit.disabled = false; form.elements.authorization_count.disabled = false;
      submit.textContent = '生成授权码';
    }
  });
  return { node, refresh: () => { if (!reading) readHistory(); }, setUsers(value) { users = value; renderHistory(); } };
}
