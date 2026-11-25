import { api, put } from './api.js';
import { el, button, inputField, notice, toast, formatTime, emptyState, openDialog, confirmAction } from './ui.js';

const DESCRIPTION_LIMIT = 5000;
const EXCERPT_MARKER = '…【原回答已摘录】';
const SHORT_CHOICES = new Set(['ratio', 'style', 'subject_framing', 'scene_distance', 'innovation_type']);

function excerpt(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!limit || text.length <= limit) return text;
  // 按编辑框的 UTF-16 单位预算截取，避免切断表情等字符。
  return text.slice(0, limit - EXCERPT_MARKER.length).replace(/[\uD800-\uDBFF]$/, '') + EXCERPT_MARKER;
}

export function descriptionTemplate(artwork) {
  // 只读取生成这张作品时保留的回答，不读当前草稿或手动提示词。
  const a = artwork.answers || {};
  function render(shorten = false) {
    const field = name => excerpt(a[name], shorten ? (SHORT_CHOICES.has(name) ? 50 : 250) : 0);
    const line = (label, name) => `${label}：${field(name) || '【请补充】'}`;
    const optional = (label, name, skipAuto = false) => field(name) && !(skipAuto && field(name) === '自动') ? line(label, name) : null;
    const title = excerpt(artwork.title, shorten ? 250 : 0) || field('theme') || '【请补充】';
    const sections = [
      [`作品名称：《${title}》`],
      ['01 赛题理解', optional('比赛或练习名称', 'competition_name'), optional('赛题主题', 'competition_theme'), optional('赛题要求', 'requirements'), line('我理解的任务', 'task_understanding')],
      ['02 创作背景', line('作品主题', 'theme'), line('创作缘由', 'reason')],
      ['03 表达意图', line('我希望表达', 'message'), line('画面如何传达', 'message_detail')],
      ['04 画面构思', line('画面主体', 'subject'), line('场景设定', 'scene'), line('发生的事情', 'action'), line('关键细节', 'details')],
      ['05 设计选择', line('画面比例', 'ratio'), line('画面风格', 'style'), optional('主体呈现', 'subject_framing', true), optional('场景景别', 'scene_distance', true), line('选择理由', 'style_reason')],
      ['06 创新亮点', line('创新思考路径', 'innovation_type'), line('具体创新点', 'innovation'), line('创新在画面中的表现', 'innovation_visible')],
      ['07 AI辅助与修改过程', 'AI辅助方式：依据创作计划整理提示词，并使用AI绘图工具辅助画面创作。',
        '实际生成过程：【请根据实际情况补充生成与选择作品的过程。】',
        '检查与修改：【请根据实际情况补充对照赛题要求检查作品的过程和实际修改内容，未修改也请如实填写。】'],
    ];
    return sections.map(section => section.filter(Boolean).join('\n')).join('\n\n');
  }
  const full = render();
  if (full.length <= DESCRIPTION_LIMIT) return full;
  // 过长时每个字段独立摘录，全部栏目仍保留，不修改作品的原始回答。
  return `${render(true)}\n\n说明：较长的回答已按字段摘录，完整内容仍保留在创作计划中，可自行补充。`;
}

export function artworkEditor(artwork, { onSaved, compact = false } = {}) {
  const form = el('form', { className: 'artwork-editor' });
  const description = inputField({ name: 'description', label: '作品说明', value: artwork.description || descriptionTemplate(artwork), multiline: true, rows: 15, maxlength: DESCRIPTION_LIMIT, hint: '已根据这张作品的创作计划整理说明，不需要重新填写前六步。请核对内容，补上实际生成、检查与修改过程，并用自己的话表达。' });
  const reflection = inputField({ name: 'reflection', label: '我的观察与反思', value: artwork.reflection || '', multiline: true, rows: 6, maxlength: DESCRIPTION_LIMIT, hint: '对照真实作品，从实际结果、与计划的差异、调整过程、收获与改进四个方面思考。', placeholder: '1. 哪些实际画面细节实现了我的想法？\n2. 生成结果与计划有哪些相同或不同？\n3. 我实际修改了什么？没有修改也请如实说明。\n4. 这次创作有什么收获？下次还想改进什么？' });
  const status = el('div', { 'aria-live': 'polite' });
  const save = el('button', { type: 'submit', className: 'button primary' }, '保存作品说明');
  const useTemplate = button('使用完整说明模板', async () => {
    if (save.disabled || useTemplate.disabled) return;
    const editor = description.querySelector('textarea');
    useTemplate.disabled = true;
    try {
      if (editor.value !== '' && !await confirmAction('换成完整说明模板？', '这会替换当前说明框中的文字，不会改变作品反思或原图。替换后还需要点击“保存作品说明”。是否继续？')) return;
      editor.value = descriptionTemplate(artwork);
      status.replaceChildren(notice('已填入完整模板，请核对并补充真实创作过程，完成后点击保存。', 'info'));
    } finally { useTemplate.disabled = false; }
  }, 'button secondary');
  form.append(description, el('div', { className: 'artwork-template-tools' }, useTemplate, el('p', { className: 'muted' }, '已有说明不会自动替换，需要时可使用完整模板。')), reflection,
    el('details', { className: 'artwork-presentation-tips' }, el('summary', {}, '答辩练习 · 试着讲给别人听'), el('ol', {},
      el('li', {}, '为什么选择这个主题？希望观众明白什么？'), el('li', {}, '哪些画面细节表现了你的设计与创新？'), el('li', {}, 'AI帮助你完成了哪些工作？你自己作了哪些选择或调整？'))),
    status, el('div', { className: 'button-row' }, save, el('a', { className: 'button secondary', href: `/api/artworks/${encodeURIComponent(artwork.id)}/download`, download: '' }, '下载原图')));
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (save.disabled) return; save.disabled = true; status.replaceChildren();
    try { const payload = Object.fromEntries(new FormData(form)); const result = await put(`/api/artworks/${encodeURIComponent(artwork.id)}`, payload); artwork = result.artwork; toast('作品说明已保存'); onSaved?.(artwork); }
    catch (err) { status.replaceChildren(notice(err.message, 'error')); }
    finally { save.disabled = false; }
  });
  return compact ? form : el('div', { className: 'artwork-detail' }, el('div', { className: 'artwork-image-wrap' }, el('img', { className: 'artwork-image', src: `/api/artworks/${encodeURIComponent(artwork.id)}/image`, alt: artwork.title || '生成的作品' })), form);
}

export async function openArtwork(id) {
  try {
    const { artwork } = await api(`/api/artworks/${encodeURIComponent(id)}`);
    openDialog(artwork.title || '我的作品', artworkEditor(artwork), { wide: true });
  } catch (err) { toast(err.message, true); }
}

export async function renderArtworks(host, onCreate) {
  host.replaceChildren(notice('正在整理你的作品…'));
  try {
    const { artworks } = await api('/api/artworks');
    if (!artworks.length) { host.replaceChildren(emptyState('作品，会从一个想法开始', '完成创作计划并成功生成后，作品会保存在这里。查看与下载已保存作品不会消耗算力。', button('开始一件新作品', onCreate, 'button primary'))); return; }
    host.replaceChildren(el('p', { className: 'muted' }, `共 ${artworks.length} 件作品 · 查看、修改说明和下载均不消耗算力`), el('div', { className: 'artwork-grid' }, artworks.map(artwork => el('article', { className: 'card artwork-card' }, button(el('img', { src: `/api/artworks/${encodeURIComponent(artwork.id)}/image`, alt: artwork.title || '我的作品', loading: 'lazy' }), () => openArtwork(artwork.id), 'artwork-preview', { 'aria-label': `查看${artwork.title || '作品'}` }), el('div', { className: 'artwork-card-body' }, el('h2', {}, artwork.title || '未命名作品'), el('p', { className: 'muted' }, formatTime(artwork.created_at)), el('div', { className: 'button-row' }, button('查看与写说明', () => openArtwork(artwork.id), 'button small secondary'), el('a', { className: 'button small primary', href: `/api/artworks/${encodeURIComponent(artwork.id)}/download`, download: '' }, '下载')))))));
  } catch (err) { host.replaceChildren(notice(err.message, 'error'), button('重新加载', () => renderArtworks(host, onCreate), 'button secondary')); }
}
