import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('公共页面底部展示准确的服务备案号并链接至工信部官网', async () => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const footers = [...html.matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer>/giu)];
  assert.equal(footers.length, 1, '公共页面应包含一个静态页脚');
  const footer = footers[0][1];
  assert.match(footer, /<a\b[^>]*href="https:\/\/beian\.miit\.gov\.cn\/"[^>]*>\s*黔ICP备2025047127号-4\s*<\/a>/u);
  assert.match(footer, /target="_blank"/u);
  assert.match(footer, /rel="noopener noreferrer"/u);
  // 应在应用挂载容器之外，避免登录或切换页面时被动态替换掉。
  assert.ok(footers[0].index > html.indexOf('id="app"'));
});
