import { DomainError } from './contracts.js';

export const FIELD_LABELS = {
  competition_name: '比赛或练习名称', competition_theme: '赛题主题', requirements: '赛题要求',
  task_understanding: '我理解的任务', theme: '作品主题', reason: '创作缘由', message: '表达目的',
  message_detail: '表达对应的画面细节', subject: '画面主角', scene: '画面场景', action: '发生的事情',
  details: '关键细节', ratio: '画面比例', style: '画面风格', style_reason: '形式选择理由',
  innovation_type: '创新思考路径', innovation: '具体创新点', innovation_visible: '创新在画面中的表现',
  subject_framing: '主体呈现', scene_distance: '场景景别', custom_prompt: '手动改写提示词',
};
// 新取景选项与手动提示词均可选，保留旧草稿的必填范围。
const optional = new Set(['competition_name', 'competition_theme', 'requirements', 'subject_framing', 'scene_distance', 'custom_prompt']);
const required = Object.keys(FIELD_LABELS).filter(key => !optional.has(key));
const choices = {
  ratio: new Set(['1:1', '4:3', '3:4', '16:9', '9:16']),
  style: new Set(['动漫', '写实', '水彩', '拼贴', '版画']),
  innovation_type: new Set(['新的组合', '不同的视角', '特别的用途', '新的故事']),
  subject_framing: new Set(['自动', '全身', '半身', '特写']),
  scene_distance: new Set(['自动', '远景', '中景', '近景']),
};
export const DEFAULT_ANSWERS = {
  competition_name: '创意练习（可改为实际比赛）', competition_theme: '未来城市与自然共生',
  requirements: '这是一份练习任务。用画面表达城市与自然的关系，并说清自己的创作缘由与创新点。实际比赛请按老师提供的规则填写。',
};

export function sanitizeAnswers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > Object.keys(FIELD_LABELS).length) {
    throw new DomainError(400, 'invalid_answers', '创作内容格式不正确。');
  }
  const result = {};
  for (const [key, text] of Object.entries(value)) {
    if (!Object.hasOwn(FIELD_LABELS, key) || typeof text !== 'string' || /[\u0000\ud800-\udfff]/u.test(text)) {
      throw new DomainError(400, 'invalid_answers', '请使用规定的创作信息字段，并填写文字。');
    }
    const maximum = key === 'custom_prompt' ? 4000 : key === 'requirements' ? 1500 : 600;
    if ([...text].length > maximum) throw new DomainError(400, 'answer_too_long', `${FIELD_LABELS[key]}最多填写${maximum}字。`);
    result[key] = text.trim();
  }
  for (const [key, options] of Object.entries(choices)) {
    if (result[key] && !options.has(result[key])) throw new DomainError(400, 'invalid_choice', `请选择有效的${FIELD_LABELS[key]}。`);
  }
  return result;
}

export function missingFields(answers) {
  const values = sanitizeAnswers(answers);
  return required.filter(key => !values[key]).map(key => FIELD_LABELS[key]);
}

function requireComplete(values) {
  const missing = missingFields(values);
  if (missing.length) throw new DomainError(400, 'incomplete_plan', `请先补充：${missing.join('、')}。`);
}

function framingText(values) {
  return [values.subject_framing && values.subject_framing !== '自动' ? `主体呈现：${values.subject_framing}。` : '',
    values.scene_distance && values.scene_distance !== '自动' ? `场景景别：${values.scene_distance}。` : ''].filter(Boolean).join('');
}

function templateText(values) {
  // 模板只使用画面信息，姓名、手机号等账号资料不会交给绘图接口。
  return [
    `创作一幅主题为《${values.theme}》的完整绘画。`,
    `主体：${values.subject}。场景：${values.scene}。发生的事：${values.action}。`,
    `关键细节：${values.details}。`,
    `表达意图：${values.message}；通过${values.message_detail}让观众理解。`,
    `创新构思：${values.innovation}；画面表现：${values.innovation_visible}。`,
    framingText(values),
    `采用${values.style}风格，画面比例${values.ratio}。构图清楚，细节围绕主题。`,
  ].filter(Boolean).join('\n');
}

function checkedPrompt(prompt) {
  if ([...prompt].length > 4000) throw new DomainError(400, 'prompt_too_long', '画面描述较长，请适当精简主体、细节和创新点后再生成。');
  return prompt;
}

export function buildTemplatePrompt(answers) {
  const values = sanitizeAnswers(answers);
  requireComplete(values);
  return checkedPrompt(templateText(values));
}

export function buildPrompt(answers) {
  const values = sanitizeAnswers(answers);
  requireComplete(values);
  if (Object.hasOwn(values, 'custom_prompt')) {
    if (!values.custom_prompt) throw new DomainError(400, 'empty_prompt', '手动改写的提示词为空，请填写内容或恢复根据回答整理的提示词。');
    return checkedPrompt(values.custom_prompt);
  }
  return checkedPrompt(templateText(values));
}

export function buildPreview(answers) {
  const values = sanitizeAnswers(answers);
  const missing = missingFields(values);
  // 自动模板独立保留，手动清空后也能选择恢复；缺少原框架时不生成模板。
  const template = missing.length ? '' : templateText(values);
  const templateTooLong = [...template].length > 4000;
  const custom = Object.hasOwn(values, 'custom_prompt');
  if (custom && !values.custom_prompt) missing.push(FIELD_LABELS.custom_prompt);
  return { prompt: missing.length ? '' : buildPrompt(values), missing, summary: buildSummary(values),
    template_prompt: templateTooLong ? '' : template, prompt_mode: custom ? 'custom' : 'template',
    ...(templateTooLong ? { template_error: '根据回答整理的提示词超过4000字，请先精简原答案后再恢复。' } : {}) };
}

export function buildSummary(answers) {
  const values = sanitizeAnswers(answers);
  const field = key => values[key] || '【请补充】';
  return `作品名称：《${field('theme')}》\n\n创作缘由：${field('reason')}\n我想表达：${field('message')}\n`
    + `画面设计：以${field('subject')}为主角，在${field('scene')}，${field('action')}。关键细节是${field('details')}。\n`
    + (framingText(values) ? `取景选择：${framingText(values)}\n` : '')
    + `形式选择：${field('ratio')}画幅，${field('style')}风格。选择理由：${field('style_reason')}\n`
    + `我的创新：${field('innovation')}。在画面中通过${field('innovation_visible')}体现。\n\n`
    + 'AI辅助与修改过程：【请根据实际生成、检查和修改过程填写，不要保留这一提示文字。】';
}
