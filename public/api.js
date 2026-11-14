export class ApiError extends Error {
  constructor(message, code, status = 0) { super(message); this.code = code; this.status = status; }
}

// 会话由同源 HttpOnly Cookie 管理，前端不存储密码或密钥。
export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError('网络连接暂时中断，请检查连接后再试。', 'NETWORK_ERROR');
  }
  let data;
  try { data = await response.json(); } catch { throw new ApiError('服务返回了无法识别的结果，请稍后再试。', 'INVALID_RESPONSE', response.status); }
  if (!response.ok) {
    const error = new ApiError(data.error?.message || '操作没有完成，请稍后重试。', data.error?.code || 'REQUEST_FAILED', response.status);
    if (response.status === 401) window.dispatchEvent(new CustomEvent('session-expired'));
    throw error;
  }
  return data;
}

export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
