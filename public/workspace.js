import { api, post, put } from './api.js';
import { el, button, inputField, notice, toast, openDialog } from './ui.js';
import { STEPS, INNOVATION_QUESTIONS, FIELD_LABELS } from './steps.js';
import { artworkEditor } from './artworks.js';
import { creditBalance, EXHAUSTED_MESSAGE } from './credits.js';

export function createWorkspace(initialPlan, ctx) {
  let plan = initialPlan;
  let answers = { ...plan.answers };
  let step = Math.max(0, Math.min(6, Number(plan.step) || 0));
  let busy = false;
  let disposed = false;
  let pollTimer;
  let preview = null;
  let latestArtwork = null;
  let requestRecord = readRecord();
  // 刷新后的首次查询尚未返回时，先按已知状态锁住重复生成。
  let job = requestRecord?.job_id ? { id: requestRecord.job_id, status: ['succeeded', 'failed', 'settled', 'uncertain'].includes(requestRecord.status) ? requestRecord.status : 'running' } : null;
  let checks = plan.confirmed ? [true, true, true] : [false, false, false];
  const mobileHintQuery = window.matchMedia('(max-width: 720px)');
  let hintOpen = !mobileHintQuery.matches;
  const root = el('div', { className: 'workspace' });
  const status = el('div', { className: 'workspace-status', 'aria-live': 'polite' });
  const updateHintDefault = event => {
    hintOpen = !event.matches;
    const hint = root.querySelector('.thinking-card');
    if (hint) hint.open = hintOpen;
  };
  mobileHintQuery.addEventListener('change', updateHintDefault);

  function readRecord() {
    try { return JSON.parse(sessionStorage.getItem(`studio-generation-${plan.id}`) || 'null'); } catch { return null; }
  }
  function record(value) {
    requestRecord = value;
    try { sessionStorage.setItem(`studio-generation-${plan.id}`, JSON.stringify(value)); } catch { /* 私密浏览模式下仍可继续当前页面的操作。 */ }
  }
  function setBusy(value) {
    busy = value;
    root.querySelectorAll('[data-work-action], [data-generate], input, textarea, select').forEach(node => {
      if (node.dataset.baseDisabled === undefined) node.dataset.baseDisabled = node.disabled ? '1' : '0';
      node.disabled = value || node.dataset.baseDisabled === '1';
    });
  }
  function updateAnswer(key, value) {
    answers[key] = value;
    plan.confirmed = false;
    preview = null;
    checks = [false, false, false];
    const summary = root.querySelector('[data-theme-summary]');
    if (summary) summary.textContent = answers.theme || '先选一个你关心的主题';
    status.replaceChildren(el('span', { className: 'save-status' }, '有未保存的修改'));
  }
  async function save(target = step, confirmed = plan.confirmed, quiet = false) {
    const result = await put(`/api/plans/${encodeURIComponent(plan.id)}`, { title: (answers.theme || plan.title || '我的创作练习').slice(0, 100), answers, step: target, confirmed });
    plan = result.plan;
    answers = { ...plan.answers };
    if (!quiet && !disposed) status.replaceChildren(el('span', { className: 'save-status saved' }, '✓ 草稿已保存，不会出图或消耗算力'));
    return plan;
  }
  async function saveDraft() {
    if (busy) return;
    setBusy(true);
    try { await save(); toast('草稿已保存，不会触发生成'); }
    catch (err) { status.replaceChildren(notice(err.message, 'error')); }
    finally { setBusy(false); }
  }
  function validateStep() {
    const missing = STEPS[step].fields.filter(([name, , , required]) => required && !String(answers[name] || '').trim()).map(field => field[0]);
    if (step === 3) ['ratio', 'style'].forEach(name => { if (!answers[name]) missing.push(name); });
    if (step === 4 && !answers.innovation_type) missing.push('innovation_type');
    markMissing(missing);
    return missing.length === 0;
  }
  function markMissing(missing) {
    root.querySelectorAll('[aria-invalid]').forEach(node => node.removeAttribute('aria-invalid'));
    missing.forEach(name => root.querySelector(`[name="${name}"]`)?.setAttribute('aria-invalid', 'true'));
    if (missing.length) {
      status.replaceChildren(notice(`还需要补充：${missing.map(name => FIELD_LABELS[name] || name).join('、')}。`, 'error'));
      root.querySelector('[aria-invalid="true"]')?.focus();
    }
  }
  async function goStep(target, validate = false) {
    if (busy || target === step || target < 0 || target > 6) return;
    if (validate && !validateStep()) return;
    if (target === 5 && !plan.confirmed) { toast('请先在第 5 步自查并确认创作计划', true); return; }
    if (target === 6 && !latestArtwork) { toast('成功生成一张作品后，就可以写作品说明了'); return; }
    setBusy(true);
    try { await save(target); step = target; render(); root.querySelector('.step-card h2')?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    catch (err) { status.replaceChildren(notice(err.message, 'error')); }
    finally { setBusy(false); }
  }
  async function previewPlan() {
    if (busy) return null;
    setBusy(true);
    try {
      await save(step, false, true);
      preview = await post(`/api/plans/${encodeURIComponent(plan.id)}/preview`);
      render();
      markMissing(preview.missing || []);
      return preview;
    } catch (err) { status.replaceChildren(notice(err.message, 'error')); return null; }
    finally { setBusy(false); }
  }
  async function confirmPlan() {
    if (busy || !validateStep()) return;
    if (!checks.every(Boolean)) { status.replaceChildren(notice('请逐项阅读并勾选三项自查，再确认计划。', 'error')); root.querySelector('[name="check-0"]')?.focus(); return; }
    setBusy(true);
    try {
      await save(step, false, true);
      preview = await post(`/api/plans/${encodeURIComponent(plan.id)}/preview`);
      if (preview.missing?.length) { render(); markMissing(preview.missing); return; }
      await save(5, true);
      step = 5; render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) { status.replaceChildren(notice(err.message, 'error')); }
    finally { setBusy(false); }
  }
  function stepsList(drawer = false, close) {
    return el('ol', { className: drawer ? 'drawer-steps' : 'step-track', 'aria-label': '七步创作流程' }, STEPS.map((item, index) => {
      const complete = index < 5 ? item.fields.every(([name, , , required]) => !required || String(answers[name] || '').trim()) && (index !== 4 || plan.confirmed) : index === 5 ? Boolean(latestArtwork) : Boolean(latestArtwork?.description && latestArtwork?.reflection);
      return el('li', {}, button([el('span', { className: 'step-number', 'aria-hidden': true }, complete && index !== step ? '✓' : `${index + 1}`), el('span', { className: 'step-name' }, item.name)], () => { close?.(); goStep(index); }, `step-button ${index === step ? 'current' : complete ? 'done' : ''}`, { 'aria-label': `第 ${index + 1} 步：${item.name}${complete ? '，已完成' : ''}`, 'aria-current': index === step ? 'step' : null, 'data-work-action': true }));
    }));
  }
  function showSteps() {
    const content = el('div');
    const dialog = openDialog('七步创作流程', content);
    content.append(stepsList(true, () => dialog.close()));
  }
  function makeField(spec) {
    const [name, label, multiline, required, placeholder] = spec;
    const field = inputField({ name, label, multiline, required, placeholder, value: answers[name] || '', maxlength: name === 'requirements' ? 4000 : 2000 });
    field.querySelector('input,textarea').addEventListener('input', event => updateAnswer(name, event.target.value));
    return field;
  }
  function choiceField(name, label, options) {
    const field = inputField({ name, label, options, value: answers[name] || '', required: true });
    field.querySelector('select').addEventListener('change', event => {
      updateAnswer(name, event.target.value);
      if (name === 'innovation_type') root.querySelector('[data-innovation-question]').textContent = INNOVATION_QUESTIONS[event.target.value] || '';
    });
    return field;
  }
  function planningContent() {
    const body = el('div', { className: 'step-card-body' });
    body.append(el('p', { className: 'step-intro' }, STEPS[step].intro));
    if (step === 3) {
      body.append(...STEPS[step].fields.slice(0, 4).map(makeField), el('div', { className: 'field-pair' }, choiceField('ratio', '画面比例', ['1:1', '4:3', '3:4', '16:9', '9:16']), choiceField('style', '画面风格', ['动漫', '写实', '水彩', '拼贴', '版画'])), makeField(STEPS[step].fields[4]));
    } else {
      if (step === 4) body.append(choiceField('innovation_type', '选择一个创新方向', Object.keys(INNOVATION_QUESTIONS)), el('p', { className: 'preset-question', 'data-innovation-question': true }, INNOVATION_QUESTIONS[answers.innovation_type] || INNOVATION_QUESTIONS['新的组合']));
      body.append(...STEPS[step].fields.map(makeField));
    }
    if (step === 4) {
      body.append(el('div', { className: 'self-check' }, el('h3', {}, '生成前，自己检查一次'), ...['我已核对题目要求，作品围绕自己确定的主题。', '我的表达与创新，都能在画面细节里找到。', '这些内容是我自己的想法，我能说明为什么这样设计。'].map((text, index) => el('label', { className: 'check-label' }, el('input', { type: 'checkbox', name: `check-${index}`, checked: checks[index], onChange: event => { checks[index] = event.target.checked; } }), el('span', {}, text)))));
      body.append(button('检查计划并预览提示词', previewPlan, 'button secondary', { 'data-work-action': true }));
      if (preview) body.append(el('section', { className: 'prompt-preview' }, el('h3', {}, '提示词预览'), el('p', { className: 'muted' }, '这是根据你的回答整理的画面描述，请核对是否表达了你的想法。要调整内容，请回到对应步骤修改。'), preview.missing?.length ? notice(`还有 ${preview.missing.length} 项待补充，请返回对应步骤完善。`, 'error') : notice('所需内容已齐全，可以自查确认。', 'success'), inputField({ name: 'prompt-preview', label: '整理后的绘图提示词（只读）', multiline: true, value: preview.prompt || '', rows: 8, readOnly: true })));
    }
    body.append(button('给我一点提示', () => { const hint = root.querySelector('.thinking-card'); if (hint) { hintOpen = true; hint.open = true; hint.scrollIntoView({ behavior: 'smooth', block: 'center' }); hint.querySelector('summary')?.focus({ preventScroll: true }); } }, 'text-button'));
    return body;
  }
  function generationContent() {
    const body = el('div', { className: 'step-card-body generation-body' });
    body.append(el('p', { className: 'step-intro' }, STEPS[5].intro), el('div', { className: 'generation-balance' }, el('span', {}, '本次生成 ', el('strong', {}, '1 张')), el('span', {}, '剩余算力 ', el('strong', {}, `${ctx.user.available_credits ?? ctx.user.credits}`), ' 点'), el('span', {}, '预留 ', el('strong', {}, `${ctx.user.reserved_credits || 0}`), ' 点')));
    const balance = creditBalance(ctx.user);
    if (balance.exhausted) body.append(notice(`剩余算力为 0 点。${EXHAUSTED_MESSAGE}。你仍可以保存草稿、查看并下载已有作品。`, 'warning'));
    else if (balance.fullyReserved) body.append(notice('当前算力已全部预留，请等待生成结果或联系老师核对。你仍可以保存草稿、查看并下载已有作品。', 'warning'));
    if (!plan.confirmed) body.append(notice('你修改过创作计划，请回到第 5 步重新检查并确认。', 'error'), button('回到提炼创新', () => goStep(4), 'button secondary', { 'data-work-action': true }));
    if (!ctx.configured) {
      body.append(notice('绘图服务还没有配置。请联系老师；配置完成前，你可以继续完善计划并保存草稿。', 'info'));
      if (ctx.user.role === 'admin') body.append(button('去后台配置绘图服务', ctx.onGoAdmin, 'button primary'));
      body.append(button('重新检查配置', async event => {
        const control = event.currentTarget; control.disabled = true;
        try { const data = await api('/api/bootstrap'); ctx.configured = data.generation_configured; if (data.user) ctx.onUser(data.user); render(); if (!ctx.configured) toast('老师尚未配置绘图服务'); }
        catch (err) { toast(err.message, true); } finally { control.disabled = false; }
      }, 'button secondary'));
    }
    const pendingWithoutJob = requestRecord?.status === 'requesting' && !requestRecord?.job_id;
    const active = job && ['queued', 'running'].includes(job.status);
    if (pendingWithoutJob) body.append(notice('上次请求的结果尚未确定。请先核对，暂时不要发起新的生成。若核对失败，请联系老师查看任务，也可以到“我的作品”查看是否已保存图片。', 'warning'), button('核对上次请求（不会重复消耗算力）', () => startGeneration(true), 'button secondary', { 'data-work-action': true }));
    if (job) {
      const text = { queued: '任务已排队，正在等待绘图。请勿重复提交。', running: '正在生成作品，图片完成后会自动保存在“我的作品”。', succeeded: '作品已生成并保存，本次消耗 1 点算力。', failed: '本次生成未成功，不消耗算力，预留的 1 点算力已释放。你可以检查计划后重试。', uncertain: '上游结果尚不确定，1 点算力暂时预留。请联系老师核对，核对完成前不要重复生成。', settled: '老师已核对这项任务。请到算力记录查看处理结果。' }[job.status] || '任务状态正在核对。';
      body.append(notice(text, job.status === 'failed' ? 'error' : job.status === 'uncertain' ? 'warning' : job.status === 'succeeded' ? 'success' : 'info'));
      if (job.error_message) body.append(el('p', { className: 'muted' }, job.error_message));
      if (active) body.append(el('div', { className: 'job-progress', role: 'status' }, el('span', { className: 'progress-dot', 'aria-hidden': true }), '正在等待绘图服务，请保留此页面…'));
      if (job.status === 'uncertain' || job.status === 'settled') body.append(button('刷新核对状态', pollJob, 'button secondary', { 'data-work-action': true }));
    }
    if (latestArtwork) body.append(el('figure', { className: 'generated-artwork' }, el('img', { src: `/api/artworks/${encodeURIComponent(latestArtwork.id)}/image`, alt: latestArtwork.title || '本次生成的作品' }), el('figcaption', {}, '对照计划看一看：画面表达了你的意思吗？')), el('div', { className: 'button-row' }, button('写作品说明', () => goStep(6), 'button primary', { 'data-work-action': true }), el('a', { className: 'button secondary', href: `/api/artworks/${encodeURIComponent(latestArtwork.id)}/download`, download: '' }, '下载原图')));
    const mayGenerate = !job || ['failed', 'succeeded', 'settled'].includes(job.status);
    if (!pendingWithoutJob && !active && mayGenerate) {
      const available = Number(ctx.user.available_credits ?? ctx.user.credits);
      body.append(button(job?.status === 'failed' ? '确认重试 1 张（成功消耗 1 点）' : latestArtwork ? '再生成 1 张（成功消耗 1 点）' : '确认生成 1 张（成功消耗 1 点）', () => startGeneration(false), 'button primary generation-submit', { disabled: !ctx.configured || !plan.confirmed || available <= 0, 'data-generate': true }));
    }
    return body;
  }
  async function startGeneration(recover = false) {
    if (busy) return;
    if (!recover && (['queued', 'running', 'uncertain'].includes(job?.status) || requestRecord?.status === 'requesting')) return;
    if (!recover && (!plan.confirmed || !ctx.configured || Number(ctx.user.available_credits ?? ctx.user.credits) <= 0)) return;
    const previousGeneration = { job, artwork: latestArtwork };
    setBusy(true);
    root.querySelector('[data-generate]')?.setAttribute('disabled', '');
    try {
      if (!recover) {
        await save(5, true, true);
        job = null;
        latestArtwork = null;
        record({ plan_id: plan.id, request_key: crypto.randomUUID(), status: 'requesting' });
      }
      const data = await post('/api/generate', { plan_id: plan.id, request_key: requestRecord.request_key });
      job = data.job;
      record({ ...requestRecord, job_id: job.id, status: job.status });
      if (disposed) return;
      ctx.onUser(data.user);
      render();
      if (['queued', 'running'].includes(job.status)) schedulePoll();
      else await loadJobArtwork();
    } catch (err) {
      const insufficientCredits = String(err.code).toLowerCase() === 'insufficient_credits';
      // 网络异常可能发生在服务端已受理之后，仅允许用同一请求号核对。
      // 余额不足是明确未受理，即使状态码为 409，也不能标成结果未知。
      if (insufficientCredits || (!recover && err.status >= 400 && err.status < 500 && err.status !== 409)) {
        record({ ...requestRecord, status: 'rejected' });
      }
      if (disposed) return;
      let refreshError = null;
      if (insufficientCredits) {
        job = previousGeneration.job;
        latestArtwork = previousGeneration.artwork;
        try { await refreshCredits(); }
        catch (balanceError) { refreshError = balanceError; }
      }
      if (disposed) return;
      render(); status.replaceChildren(notice(err.message, 'error'));
      if (refreshError) status.append(notice('暂时无法刷新算力余额，请检查连接后重试。不会自动重新生成。', 'warning'), button('刷新算力余额', () => refreshCredits().catch(error => toast(error.message, true)), 'button secondary'));
    } finally { setBusy(false); }
  }
  async function refreshCredits() {
    const { user } = await api('/api/me');
    if (disposed) return;
    ctx.onUser(user);
    render();
  }
  function schedulePoll() { clearTimeout(pollTimer); if (!disposed) pollTimer = setTimeout(pollJob, 2200); }
  async function loadJobArtwork() {
    if (job?.artwork_id) {
      try { const result = await api(`/api/artworks/${encodeURIComponent(job.artwork_id)}`); latestArtwork = result.artwork; if (!disposed) render(); }
      catch (err) { if (!disposed) status.replaceChildren(notice(`作品已保存，读取时遇到问题：${err.message} 请到“我的作品”查看。`, 'error')); }
    }
  }
  async function pollJob() {
    if (disposed || !requestRecord?.job_id) return;
    clearTimeout(pollTimer);
    try {
      const data = await api(`/api/jobs/${encodeURIComponent(requestRecord.job_id)}`);
      if (disposed) return;
      job = data.job; ctx.onUser(data.user); record({ ...requestRecord, status: job.status }); render();
      if (['queued', 'running'].includes(job.status)) schedulePoll(); else await loadJobArtwork();
    } catch (err) {
      if (!disposed) status.replaceChildren(notice(`任务查询暂时中断。${err.message} 不会自动重新生成。`, 'warning'), button('继续查询任务', pollJob, 'button secondary'));
    }
  }
  function reflectionContent() {
    return latestArtwork ? el('div', { className: 'step-card-body' }, el('p', { className: 'step-intro' }, STEPS[6].intro), artworkEditor(latestArtwork, { onSaved: artwork => { latestArtwork = artwork; } })) : el('div', { className: 'step-card-body' }, notice('请先成功生成一张作品。已有作品也可以在“我的作品”中补充说明。', 'info'), button('查看我的作品', ctx.onOpenGallery, 'button primary'));
  }
  function render() {
    if (disposed) return;
    const card = el('section', { className: 'step-card card' }, el('div', { className: 'step-card-heading' }, el('span', { className: 'step-index' }, String(step + 1).padStart(2, '0')), el('h2', { tabindex: '-1' }, STEPS[step].title)), step < 5 ? planningContent() : step === 5 ? generationContent() : reflectionContent());
    const footer = el('div', { className: 'workspace-actions' });
    footer.append(button('上一步', () => goStep(step - 1), 'button secondary', { disabled: step === 0, 'data-work-action': true }));
    if (step < 4) footer.append(button('保存，继续下一步', () => goStep(step + 1, true), 'button primary', { 'data-work-action': true }));
    else if (step === 4) footer.append(button('确认计划，进入生成', confirmPlan, 'button primary', { 'data-work-action': true }));
    else if (step === 5) footer.append(button(latestArtwork ? '下一步，写作品说明' : '保存草稿', latestArtwork ? () => goStep(6) : saveDraft, 'button primary', { 'data-work-action': true }));
    else footer.append(button('查看我的作品', ctx.onOpenGallery, 'button primary', { 'data-work-action': true }));
    root.replaceChildren(el('div', { className: 'mobile-step-heading' }, el('strong', {}, el('span', {}, `第 ${step + 1} 步 / 共 7 步`), el('small', { className: 'mobile-credit-summary' }, `剩余算力 ${ctx.user.available_credits ?? ctx.user.credits} 点${ctx.user.reserved_credits ? `（预留 ${ctx.user.reserved_credits} 点）` : ''}`)), button(`${STEPS[step].name} ▾`, showSteps, 'text-button', { 'aria-label': `查看步骤，当前${STEPS[step].name}` })), el('div', { className: 'workspace-title' }, el('span', { className: 'eyebrow blue' }, `练习任务：${answers.theme || answers.competition_theme || '我的创作计划'}`), el('h1', {}, '先把想法，说得清清楚楚。')), stepsList(), status, el('div', { className: 'workspace-columns' }, card, el('aside', { className: 'workspace-aside' }, el('details', { className: 'thinking-card card', open: hintOpen, onToggle: event => { if (event.target.isConnected) hintOpen = event.target.open; } }, el('summary', { className: 'aside-heading' }, el('h3', { className: 'chip yellow' }, '想一想'), el('span', { className: 'idea-symbol', 'aria-hidden': true }, '！')), el('p', {}, STEPS[step].hint)), el('section', { className: 'theme-card card' }, el('h3', { className: 'chip mint' }, '我的主题'), el('p', { 'data-theme-summary': true }, answers.theme || '先选一个你关心的主题')), el('section', { className: 'rule-note' }, el('strong', {}, '我的想法 · 自己表达'), el('p', {}, '提示帮助你想清楚，表达由你来完成。填写和保存计划不消耗算力。')))), footer, el('p', { className: 'workspace-lock' }, plan.confirmed ? '✓ 创作计划已确认，可以由你决定何时生成' : '□ 完成并确认创作计划后解锁绘图'));
    if (busy) setBusy(true);
  }

  render();
  if (requestRecord?.job_id) pollJob();
  // 从作品记录恢复第七步，页面刷新后仍能继续编辑说明。
  if (step === 6 && !requestRecord?.job_id) api('/api/artworks').then(({ artworks }) => {
    if (disposed) return;
    latestArtwork = artworks.find(artwork => String(artwork.plan_id) === String(plan.id)) || null;
    render();
  }).catch(err => { if (!disposed) status.replaceChildren(notice(err.message, 'error')); });
  return {
    node: root,
    save: saveDraft,
    saveBeforeLeave: async () => {
      if (busy) throw new Error('正在保存或提交，请稍候再切换页面。');
      setBusy(true);
      try { return await save(); } finally { setBusy(false); }
    },
    dispose: () => { disposed = true; clearTimeout(pollTimer); mobileHintQuery.removeEventListener('change', updateHintDefault); },
  };
}
