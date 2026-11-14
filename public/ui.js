// 所有用户内容均作为文本节点写入，避免把输入当成 HTML 执行。
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (['value', 'checked', 'disabled', 'required', 'readOnly', 'selected'].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const button = (text, onClick, className = 'button', attrs = {}) => el('button', { type: 'button', className, onClick, ...attrs }, text);
export const notice = (text, kind = '') => el('p', { className: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
export function toast(message, error = false) {
  const root = document.querySelector('#notifications');
  root.replaceChildren(notice(message, error ? 'error' : 'success'));
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => root.replaceChildren(), 5500);
}
export function formatTime(value) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value || '—' : time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function inputField({ name, label, value = '', type = 'text', hint, required = false, multiline = false, options, ...attrs }) {
  const id = `field-${name}`;
  const props = { id, name, value, required, ...attrs };
  let input;
  if (options) {
    input = el('select', props, options.map(option => {
      const [optionValue, text] = typeof option === 'string' ? [option, option] : option;
      return el('option', { value: optionValue, selected: optionValue === value }, text);
    }));
    input.value = value;
  } else input = multiline ? el('textarea', { rows: 3, ...props }) : el('input', { type, ...props });
  const help = hint ? el('small', { id: `${id}-help`, className: 'field-hint' }, hint) : null;
  if (hint) input.setAttribute('aria-describedby', `${id}-help`);
  return el('div', { className: 'field', 'data-field': name }, el('label', { for: id }, label, required ? el('span', { className: 'required', 'aria-label': '必填' }, ' *') : null), input, help);
}

export function emptyState(title, text, action) {
  return el('div', { className: 'empty-state' }, el('span', { className: 'empty-mark', 'aria-hidden': true }, '创'), el('h2', {}, title), el('p', {}, text), action);
}

export function openDialog(title, content, { wide = false, onClose } = {}) {
  const dialog = el('dialog', { className: wide ? 'modal wide' : 'modal', 'aria-label': title });
  const close = () => dialog.close();
  dialog.append(el('div', { className: 'modal-heading' }, el('h2', {}, title), button('关闭', close, 'button small secondary', { 'aria-label': `关闭${title}` })), content);
  dialog.addEventListener('close', () => { dialog.remove(); onClose?.(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export async function confirmAction(title, message) {
  return new Promise(resolve => {
    let decided = false;
    const content = el('div', {}, el('p', {}, message));
    const dialog = openDialog(title, content, { onClose: () => { if (!decided) resolve(false); } });
    content.append(el('div', { className: 'button-row' }, button('取消', () => dialog.close(), 'button secondary'), button('确认', () => { decided = true; resolve(true); dialog.close(); }, 'button primary')));
  });
}
