export class ApiError extends Error {
  constructor(message, code, status = 0) { super(message); this.code = code; this.status = status; }
}

// 会话由同源 HttpOnly Cookie 管理，前端不存储密码或密钥。
export async function api(path, options = {}) {
  const { timeoutMs, ...requestOptions } = options;
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const controller = hasTimeout ? new AbortController() : null;
  const callerSignal = requestOptions.signal;
  let timedOut = false;
  let timer;
  const timeoutError = () => new ApiError('连接较慢，暂时未能打开创作空间。请点击“重新连接”再试。', 'REQUEST_TIMEOUT');
  const checkCancelled = () => {
    if (timedOut) throw timeoutError();
    if (callerSignal?.aborted) throw new ApiError('连接已取消，请重新连接。', 'REQUEST_CANCELLED');
  };
  const forwardAbort = () => controller?.abort(callerSignal.reason);
  if (controller && callerSignal) {
    if (callerSignal.aborted) forwardAbort();
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  const request = async () => {
    let response;
    try {
      response = await fetch(path, {
        credentials: 'same-origin', cache: 'no-store', ...requestOptions,
        ...(controller ? { signal: controller.signal } : {}),
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch {
      checkCancelled();
      throw new ApiError('网络连接暂时中断，请检查连接后再试。', 'NETWORK_ERROR');
    }
    checkCancelled();
    let data;
    try { data = await response.json(); }
    catch {
      checkCancelled();
      throw new ApiError('服务返回了无法识别的结果，请稍后再试。', 'INVALID_RESPONSE', response.status);
    }
    // 超时或取消后即使旧响应晚到，也不能误报会话失效或返回旧结果。
    checkCancelled();
    if (!response.ok) {
      const error = new ApiError(data.error?.message || '操作没有完成，请稍后重试。', data.error?.code || 'REQUEST_FAILED', response.status);
      if (response.status === 401) window.dispatchEvent(new CustomEvent('session-expired'));
      throw error;
    }
    return data;
  };

  try {
    if (!hasTimeout) return await request();
    // 仅由需要限时的调用启用，涵盖响应正文；不自动重试任何请求。
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(timeoutError());
        controller.abort();
      }, timeoutMs);
    });
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
    if (controller && callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
  }
}

export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
