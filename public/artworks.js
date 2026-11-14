import { api, put } from './api.js';
import { el, button, inputField, notice, toast, formatTime, emptyState, openDialog } from './ui.js';

export function descriptionTemplate(artwork) {
  const a = artwork.answers || {};
  return `我的作品《${artwork.title || a.theme || '未命名作品'}》围绕“${a.theme || '（填写主题）'}”展开。我希望表达：${a.message || '（填写想表达的意思）'}。\n画面通过${a.message_detail || '（填写画面细节）'}来呈现这个想法。\n我选择${a.style || '（填写风格）'}风格，原因是${a.style_reason || '（填写原因）'}。我的创新点是${a.innovation || '（填写创新点）'}，它体现在${a.innovation_visible || '（填写可见的细节）'}。`;
}

export function artworkEditor(artwork, { onSaved, compact = false } = {}) {
  const form = el('form', { className: 'artwork-editor' });
  const description = inputField({ name: 'description', label: '作品说明', value: artwork.description || descriptionTemplate(artwork), multiline: true, rows: 7, maxlength: 8000, hint: '这是根据你的创作计划整理的文字模板，请核对并修改成自己的表达。' });
  const reflection = inputField({ name: 'reflection', label: '我的观察与反思', value: artwork.reflection || '', multiline: true, rows: 4, maxlength: 8000, placeholder: '1. 哪些细节实现了我的想法？\n2. 生成结果哪里和计划不同？\n3. 如果再修改一次，我想调整什么？' });
  const status = el('div', { 'aria-live': 'polite' });
  const save = el('button', { type: 'submit', className: 'button primary' }, '保存作品说明');
  form.append(description, reflection, status, el('div', { className: 'button-row' }, save, el('a', { className: 'button secondary', href: `/api/artworks/${encodeURIComponent(artwork.id)}/download`, download: '' }, '下载原图')));
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
