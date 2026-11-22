import { api, post } from './api.js';
import { el, button, notice, toast, emptyState, formatTime, openDialog } from './ui.js';
import { authScreen } from './auth.js';
import { createWorkspace } from './workspace.js';
import { renderArtworks } from './artworks.js';
import { renderAdmin } from './admin.js';
import { DEFAULT_ANSWERS, STEPS } from './steps.js';
import { createCreditReminder } from './credits.js';

const root = document.querySelector('#app');
const state = { user: null, configured: false, testMode: false, view: 'workspace', workspace: null, plan: null, routeBusy: false };
const creditReminder = createCreditReminder();
let content;
let breadcrumb;
let nav;
let creditText;
let bannerObserver;
let bootstrapBusy = false;
const VIEWS = { workspace: ['创', '创作工作台'], artworks: ['作', '我的作品'], drafts: ['稿', '草稿'], credits: ['算', '算力记录'], admin: ['管', '后台设置'] };

function mount(...nodes) {
  bannerObserver?.disconnect();
  const banner = state.testMode ? el('div', { className: 'test-environment-banner', role: 'status' }, '功能验收环境 · 使用测试图片，不调用真实绘图服务') : null;
  root.replaceChildren(...[banner, ...nodes].filter(Boolean));
  const updateBannerHeight = () => document.documentElement.style.setProperty('--test-banner-height', `${banner?.getBoundingClientRect().height || 0}px`);
  updateBannerHeight();
  if (banner && 'ResizeObserver' in window) {
    bannerObserver = new ResizeObserver(updateBannerHeight);
    bannerObserver.observe(banner);
  }
}

function onUser(user) {
  if (!user) return;
  state.user = user;
  if (creditText) creditText.textContent = `剩余算力 ${user.available_credits ?? user.credits} 点`;
  creditReminder.update(user);
}
function renderNav() {
  if (!nav) return;
  nav.replaceChildren(...Object.entries(VIEWS).filter(([key]) => key !== 'admin' || state.user.role === 'admin').map(([key, [mark, title]]) => button(el('span', { className: `nav-content` }, el('span', { className: `nav-mark nav-${key}`, 'aria-hidden': true }, mark), el('span', {}, title)), () => navigate(key), `nav-button ${state.view === key ? 'active' : ''}`, { 'aria-current': state.view === key ? 'page' : null })));
}
function shell() {
  nav = el('nav', { className: 'main-nav', 'aria-label': '主导航' });
  content = el('main', { id: 'main', className: 'main-content', tabindex: '-1' });
  breadcrumb = el('span', { className: 'breadcrumb' }, '创作 / 练习任务');
  creditText = el('span', { className: 'credit-badge' }, `剩余算力 ${state.user.available_credits ?? state.user.credits} 点`);
  const profile = el('div', { className: 'sidebar-profile' }, el('div', { className: 'profile-avatar' }, state.user.name?.slice(0, 1) || '我'), el('div', {}, el('strong', {}, state.user.name), el('small', {}, state.user.role === 'admin' ? '管理员' : '学生')), button('退出', logout, 'text-button', { 'aria-label': '退出登录' }));
  const sidebar = el('aside', { className: 'sidebar' }, el('a', { href: '/', className: 'brand' }, el('span', { className: 'brand-mark' }, '创'), el('span', {}, '作品创作台')), nav, el('div', { className: 'sidebar-bottom' }, el('div', { className: 'quota-card' }, el('span', {}, '我的算力点数'), creditText, el('small', {}, '成功生成 1 张消耗 1 点')), profile));
  const mobileMenu = () => {
    const dialogContent = el('div', { className: 'mobile-nav' });
    const dialog = openDialog('我的创作空间', dialogContent);
    Object.entries(VIEWS).filter(([key]) => key !== 'admin' || state.user.role === 'admin').forEach(([key, [mark, title]]) => dialogContent.append(button(el('span', { className: 'nav-content' }, el('span', { className: `nav-mark nav-${key}` }, mark), title), () => { dialog.close(); navigate(key); }, `nav-button ${state.view === key ? 'active' : ''}`)));
    dialogContent.append(el('p', { className: 'muted' }, `${state.user.name} · 剩余算力 ${state.user.available_credits ?? state.user.credits} 点`), button('退出登录', () => { dialog.close(); logout(); }, 'button secondary'));
  };
  const header = el('header', { className: 'topbar' }, el('div', { className: 'mobile-brand' }, button('☰', mobileMenu, 'menu-button', { 'aria-label': '打开菜单' }), el('span', { className: 'brand-mark' }, '创'), el('span', { className: 'mobile-brand-title' }, '作品创作台')), breadcrumb, button('保存草稿', () => state.workspace?.save(), 'button secondary header-save', { 'data-header-save': true }));
  mount(el('div', { className: 'app-shell' }, sidebar, el('div', { className: 'app-body' }, header, content)));
  renderNav();
}

async function signedIn(user) {
  creditReminder.reset();
  const bootstrap = await api('/api/bootstrap', { timeoutMs: 15000 }); state.configured = bootstrap.generation_configured; state.testMode = Boolean(bootstrap.test_mode);
  state.user = bootstrap.user || user;
  shell(); onUser(state.user); await navigate('workspace', { skipSave: true });
}
async function navigate(view, options = {}) {
  if (state.routeBusy) return;
  state.routeBusy = true;
  try {
    if (state.workspace && !options.skipSave) await state.workspace.saveBeforeLeave();
    state.workspace?.dispose(); state.workspace = null;
    state.view = view; renderNav();
    breadcrumb.textContent = view === 'workspace' ? '创作 / 练习任务' : VIEWS[view]?.[1] || '作品创作台';
    document.querySelector('[data-header-save]').hidden = view !== 'workspace';
    content.classList.toggle('listing-content', view !== 'workspace');
    content.replaceChildren(notice('正在打开…'));
    if (view === 'workspace') {
      let plan = options.plan;
      if (!plan) {
        const { plans } = await api('/api/plans', { timeoutMs: 15000 });
        if (plans.length) plan = (await api(`/api/plans/${encodeURIComponent(plans[0].id)}`, { timeoutMs: 15000 })).plan;
        else plan = (await post('/api/plans', { title: '我的创作练习', answers: { ...DEFAULT_ANSWERS } })).plan;
      }
      state.plan = plan;
      const ctx = { user: state.user, configured: state.configured, onUser: user => { onUser(user); ctx.user = user; }, onGoAdmin: () => navigate('admin'), onOpenGallery: () => navigate('artworks') };
      state.workspace = createWorkspace(plan, ctx); content.replaceChildren(state.workspace.node);
    } else {
      const titles = { artworks: ['我的作品', '每一件作品，都留下你的想法。'], drafts: ['我的草稿', '先保存灵感，随时接着创作。'], credits: ['算力记录', '每一次创作，都清清楚楚。'], admin: ['后台设置', '把服务准备好，让学生安心创作。'] };
      const [title, subtitle] = titles[view];
      const host = el('div', { className: 'view-content' });
      content.replaceChildren(el('div', { className: 'page-heading' }, el('div', {}, el('span', { className: 'eyebrow blue' }, title), el('h1', {}, subtitle)), view !== 'admin' ? button('＋ 新建创作', newPlan, 'button primary') : null), host);
      if (view === 'artworks') await renderArtworks(host, newPlan);
      else if (view === 'drafts') await renderDrafts(host);
      else if (view === 'credits') await renderCredits(host);
      else if (view === 'admin' && state.user.role === 'admin') await renderAdmin(host, { onConfigured: value => { state.configured = value; } });
    }
    window.scrollTo(0, 0);
  } catch (err) { toast(err.message, true); if (!state.workspace) content.replaceChildren(notice(err.message, 'error'), button('重新加载', () => navigate(view, { skipSave: true }), 'button secondary')); }
  finally { state.routeBusy = false; }
}

async function newPlan(event) {
  const control = event?.currentTarget;
  if (control) control.disabled = true;
  try {
    const { plan } = await post('/api/plans', { title: '我的创作练习', answers: { ...DEFAULT_ANSWERS } });
    await navigate('workspace', { plan });
  } catch (err) { toast(err.message, true); }
  finally { if (control) control.disabled = false; }
}
async function renderDrafts(host) {
  const { plans } = await api('/api/plans');
  if (!plans.length) { host.replaceChildren(emptyState('把第一个想法写下来', '草稿随时保存。先把想法说清楚，再决定是否生成作品。', button('新建创作计划', newPlan, 'button primary'))); return; }
  host.replaceChildren(el('div', { className: 'draft-list' }, plans.map(plan => el('article', { className: 'card draft-card' }, el('span', { className: 'draft-number', 'aria-hidden': true }, '稿'), el('div', { className: 'draft-info' }, el('h2', {}, plan.title || '我的创作练习'), el('p', {}, `第 ${Number(plan.step) + 1} 步 · ${STEPS[plan.step]?.name || '读懂赛题'}${plan.confirmed ? ' · 已确认计划' : ''}`), el('small', { className: 'muted' }, `上次保存 ${formatTime(plan.updated_at)}`)), button('继续创作', async event => { const control = event.currentTarget; control.disabled = true; try { const data = await api(`/api/plans/${encodeURIComponent(plan.id)}`); await navigate('workspace', { plan: data.plan }); } catch (err) { toast(err.message, true); } finally { control.disabled = false; } }, 'button secondary')))));
}
async function renderCredits(host) {
  const { user, entries } = await api('/api/credits'); onUser(user);
  const labels = { welcome: '首次赠送', grant: '首次赠送', initial_grant: '首次赠送', register: '首次赠送', reserve: '生成预留', release: '预留释放', generation: '成功生成', consume: '成功生成', admin_consume: '人工核对消耗算力', admin_release: '人工核对释放' };
  host.replaceChildren(el('div', { className: 'credit-summary' }, el('div', { className: 'stat-card mint' }, el('span', {}, '剩余算力'), el('strong', {}, `${user.available_credits ?? user.credits} 点`)), el('div', { className: 'stat-card yellow' }, el('span', {}, '预留算力'), el('strong', {}, `${user.reserved_credits || 0} 点`)), el('div', { className: 'card credit-explainer' }, el('strong', {}, '成功生成 1 张，消耗 1 点算力'), el('p', {}, '保存草稿、查看和下载作品不消耗算力。结果不确定的任务会暂时预留 1 点算力，等待老师核对。'))), entries.length ? el('div', { className: 'card ledger-list' }, entries.map(entry => el('article', { className: 'ledger-entry' }, el('div', {}, el('strong', {}, labels[entry.kind] || '算力变动'), el('p', {}, entry.note || '算力记录'), el('small', {}, formatTime(entry.created_at))), el('div', { className: 'ledger-value' }, el('strong', {}, Number(entry.delta) > 0 ? `+${entry.delta} 点` : `${entry.delta} 点`), el('small', {}, `结余 ${entry.balance_after} 点`))))) : emptyState('还没有算力记录', '开始创作后，相关算力记录会显示在这里。'));
}
async function logout() {
  try { if (state.workspace) await state.workspace.saveBeforeLeave(); await post('/api/logout'); state.workspace?.dispose(); state.workspace = null; state.user = null; creditReminder.reset(); mount(authScreen(false, user => signedIn(user).catch(err => toast(err.message, true)))); }
  catch (err) { toast(err.message, true); }
}
async function bootstrap(event) {
  if (bootstrapBusy) return;
  bootstrapBusy = true;
  const control = event?.currentTarget;
  if (control) { control.disabled = true; control.textContent = '正在连接…'; }
  try {
    const data = await api('/api/bootstrap', { timeoutMs: 15000 });
    state.configured = data.generation_configured; state.testMode = Boolean(data.test_mode);
    if (data.user) { state.user = data.user; shell(); onUser(data.user); await navigate('workspace', { skipSave: true }); }
    else mount(authScreen(data.setup_required, user => signedIn(user).catch(err => toast(err.message, true)), { setupTokenRequired: Boolean(data.setup_token_required) }));
  } catch (err) { root.replaceChildren(el('main', { id: 'main', className: 'initial-loading' }, el('span', { className: 'brand-mark' }, '创'), el('h1', {}, '作品创作台'), notice(err.message, 'error'), button('重新连接', bootstrap, 'button primary'))); }
  finally { bootstrapBusy = false; if (control) control.disabled = false; }
}
window.addEventListener('session-expired', () => {
  if (!state.user) return;
  state.workspace?.dispose(); state.workspace = null; state.user = null;
  creditReminder.reset();
  mount(authScreen(false, user => signedIn(user).catch(err => toast(err.message, true)))); toast('登录状态已过期，请重新登录', true);
});
// 软键盘打开时取消底部悬浮，避免操作区压住正在填写的内容。
if (window.visualViewport) {
  const updateKeyboard = () => document.body.classList.toggle('keyboard-open', window.innerHeight - window.visualViewport.height > 150);
  visualViewport.addEventListener('resize', updateKeyboard);
}
bootstrap();
