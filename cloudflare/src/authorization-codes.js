import { DomainError } from './contracts.js';

export function validateAuthorizationCode(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) {
    throw new DomainError(400, 'authorization_code_required', '请填写老师提供的8位数字授权码。');
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]{7}$/u.test(value.trim())) {
    throw new DomainError(400, 'invalid_authorization_code', '授权码无效或已使用，请向老师获取新的授权码。');
  }
  return value.trim();
}

export function validateAuthorizationCodeCount(count) {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new DomainError(400, 'invalid_authorization_code_count', '每次生成数量须为1至100之间的整数。');
  }
  return count;
}

export function validateAuthorizationCodePage({ limit = 50, before = null } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || (before !== null && (!Number.isSafeInteger(before) || before < 1))) {
    throw new DomainError(400, 'invalid_pagination', '分页数量须为1至100，游标须为正整数。');
  }
  return { limit, before };
}

export function parseAuthorizationCodePage(search) {
  const integer = (key, fallback) => {
    const value = search.get(key);
    if (value === null) return fallback;
    if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new DomainError(400, 'invalid_pagination', '分页数量和游标须为正整数。');
    }
    return Number(value);
  };
  return validateAuthorizationCodePage({ limit: integer('limit', 50), before: integer('before', null) });
}

export function randomAuthorizationCode() {
  const range = 90000000;
  // 丢弃不完整区间，保证10000000至99999999中的每个数字等概率出现。
  const ceiling = Math.floor(2 ** 32 / range) * range;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    if (value < ceiling) return String(10000000 + value % range);
  }
  throw authorizationCodeGenerationError();
}

export function authorizationCodeGenerationError() {
  return new DomainError(503, 'authorization_code_generation_failed', '授权码生成暂未完成，请稍后重试。');
}

export function authorizationCodeRecord(row) {
  return { id: row.id, code_hint: row.code_hint, status: row.used_by === null ? 'unused' : 'used',
    created_at: row.created_at, used_at: row.used_at, used_by: row.used_by };
}
