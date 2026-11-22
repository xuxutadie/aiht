import { DomainError } from './contracts.js';

// 只选择允许登记的字段，注册请求无法指定角色或算力余额。
export function validateProfile(profile, role) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !['student', 'admin'].includes(role)) {
    throw new DomainError(400, 'invalid_profile', '账号资料格式不正确。');
  }
  const labels = { name: '姓名', phone: '手机号', region: '地区', school: '学校', grade: '年级' };
  const limits = { name: 50, phone: 11, region: 100, school: 100, grade: 30 };
  const result = {};
  for (const [key, maximum] of Object.entries(limits)) {
    const value = profile[key] ?? '';
    if (typeof value !== 'string' || [...value].length > maximum) {
      throw new DomainError(400, 'invalid_profile', `请填写有效的${labels[key]}。`);
    }
    const clean = value.trim();
    const required = ['name', 'phone'].includes(key) || role === 'student';
    if ((required && !clean) || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(clean)) {
      throw new DomainError(400, 'invalid_profile', `请填写有效的${labels[key]}。`);
    }
    result[key] = clean;
  }
  if (!/^1[3-9][0-9]{9}$/u.test(result.phone)) {
    throw new DomainError(400, 'invalid_phone', '请填写11位中国大陆手机号。');
  }
  return result;
}
