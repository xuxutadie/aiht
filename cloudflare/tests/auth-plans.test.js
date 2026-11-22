import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProfile } from '../src/auth.js';
import { sanitizeAnswers, missingFields, buildPrompt, buildSummary } from '../src/plans.js';

const student = { name: '测试同学', phone: '13900000000', region: '测试地区', school: '测试学校', grade: '小学五年级' };
const answers = {
  competition_name: '练习', competition_theme: '未来城市', requirements: '表达人与自然的关系',
  task_understanding: '用画面说明城市可以为小鸟留出空间', theme: '给小鸟让路的城市', reason: '关心窗外的小鸟',
  message: '城市和自然可以共生', message_detail: '大楼间的小鸟通道', subject: '学生和小鸟', scene: '未来城市',
  action: '为小鸟留出迁徙通道', details: '楼顶有花园', ratio: '16:9', style: '动漫', style_reason: '形象易懂',
  innovation_type: '新的组合', innovation: '把城市交通与小鸟迁徙结合', innovation_visible: '立体鸟类通道',
};

test('学生资料完整、管理员只需姓名手机号，输出去掉额外权限字段', () => {
  assert.deepEqual(validateProfile({ ...student, role: 'admin', credits: 900 }, 'student'), student);
  assert.deepEqual(validateProfile({ name: '老师', phone: student.phone }, 'admin'), {
    name: '老师', phone: student.phone, region: '', school: '', grade: '',
  });
});

test('拒绝手机号、缺项、控制字符及未配对代理字符', () => {
  for (const invalid of [{ ...student, phone: '123' }, { ...student, school: '' }, { ...student, name: '测试\n姓名' }, { ...student, name: '\ud800' }]) {
    assert.throws(() => validateProfile(invalid, 'student'), error => error.status === 400);
  }
  assert.throws(() => validateProfile(student, 'owner'), error => error.status === 400);
});

test('创作字段检查保持选项和长度边界，拒绝注册资料混入提示词', () => {
  assert.deepEqual(missingFields(answers), []);
  assert.equal(sanitizeAnswers({ theme: '  小鸟  ' }).theme, '小鸟');
  assert.throws(() => sanitizeAnswers({ ...answers, phone: student.phone }), error => error.code === 'invalid_answers');
  assert.throws(() => sanitizeAnswers({ ratio: '7:3' }), error => error.code === 'invalid_choice');
  assert.throws(() => sanitizeAnswers({ theme: '字'.repeat(601) }), error => error.code === 'answer_too_long');
  assert.throws(() => sanitizeAnswers({ theme: '\ud800' }), error => error.status === 400);
});

test('不完整方案不能生成；提示词与说明包含学生表达、细节和创新', () => {
  const incomplete = { ...answers, message: '' };
  assert.ok(missingFields(incomplete).includes('表达目的'));
  assert.throws(() => buildPrompt(incomplete), error => error.code === 'incomplete_plan');
  const prompt = buildPrompt(answers);
  assert.ok(prompt.includes('采用动漫风格，画面比例16:9'));
  assert.ok(prompt.includes('表达意图：城市和自然可以共生'));
  assert.ok(prompt.includes('创新构思：把城市交通与小鸟迁徙结合'));
  assert.ok(!prompt.includes(student.phone));
  assert.ok(buildSummary(answers).includes('创作缘由：关心窗外的小鸟'));
  assert.ok(buildSummary({}).includes('【请补充】'));
});
