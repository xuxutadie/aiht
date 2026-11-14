import { el, button, openDialog } from './ui.js';

export const EXHAUSTED_MESSAGE = '请联系管理员进行补充算力';

// 总余额为零才代表真正用完；可用为零也可能只是任务暂时预留。
export function creditBalance(user) {
  const total = Number(user?.credits);
  const available = Number(user?.available_credits ?? user?.credits);
  const reserved = Number(user?.reserved_credits || 0);
  return {
    total, available, reserved,
    exhausted: Number.isFinite(total) && total <= 0,
    fullyReserved: total > 0 && available <= 0 && reserved > 0,
  };
}

export function createCreditReminder() {
  const remindedAccounts = new Set();
  let activeDialog = null;
  let activeAccount = null;

  function update(user) {
    if (!user || user.id === undefined || user.id === null) return;
    const account = String(user.id);
    if (!creditBalance(user).exhausted) {
      remindedAccounts.delete(account);
      if (activeAccount === account) activeDialog?.close();
      return;
    }
    if (remindedAccounts.has(account)) return;
    remindedAccounts.add(account);
    const content = el('div', {}, el('p', {}, EXHAUSTED_MESSAGE));
    const dialog = openDialog('算力已用完', content, {
      onClose: () => {
        if (activeDialog === dialog) { activeDialog = null; activeAccount = null; }
      },
    });
    activeDialog = dialog;
    activeAccount = account;
    content.append(el('div', { className: 'button-row' }, button('我知道了', () => dialog.close(), 'button primary')));
  }

  // 去重只保留在当前页面内，重新登录和刷新后可以再次提醒。
  function reset() {
    remindedAccounts.clear();
    activeDialog?.close();
    activeDialog = null;
    activeAccount = null;
  }

  return { update, reset };
}
