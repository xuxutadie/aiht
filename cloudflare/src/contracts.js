// 云端版保持现有网页接口及算力含义，统一可公开的错误格式。
export const INITIAL_CREDITS = 10;
export const ADMIN_UNLIMITED_RESERVE_NOTE = '管理员无限算力，无需预留点数';
export const COOKIE_NAME = 'creation_session';
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const MODEL_DEFAULT = 'doubao-seedream-5-0-flash-260915';
export const BASE_URL_DEFAULT = 'https://ark.cn-beijing.volces.com/api/v3';
// 图片分片存D1，保留足够数据库余量给账户、草稿和账本。
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 768 * 1024;
export const IMAGE_STORAGE_BUDGET = 320 * 1024 * 1024;
export const IMAGE_RESERVATION_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID().replaceAll('-', '');

export function textValue(value, label, maximum = 2000, optional = true) {
  if (typeof value !== 'string' || [...value].length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new DomainError(400, 'invalid_input', `${label}格式不正确。`);
  }
  const clean = value.trim();
  if (!optional && !clean) throw new DomainError(400, 'invalid_input', `请填写${label}。`);
  return clean;
}
