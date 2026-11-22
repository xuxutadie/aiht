import { build, transform } from 'esbuild';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const publicDirectory = new URL('../public/', import.meta.url);
const assetsDirectory = new URL('./.wrangler/frontend-assets/', import.meta.url);
const policyFile = new URL('./.wrangler/frontend-policy.js', import.meta.url);
// 只复制明确属于网页的文件，避免将账户数据、环境文件或部署密钥放入静态资源。
const publicFiles = ['favicon.svg', 'styles.css', 'app.js', 'api.js', 'ui.js', 'auth.js', 'workspace.js', 'artworks.js', 'admin.js', 'authorization-codes.js', 'steps.js', 'credits.js'];
for (const name of ['index.html', ...publicFiles]) {
  if (!(await lstat(new URL(name, publicDirectory))).isFile()) throw new Error(`网页资源必须是普通文件：${name}`);
}

const [sourceHtml, sourceCss, bundled] = await Promise.all([
  readFile(new URL('index.html', publicDirectory), 'utf8'),
  readFile(new URL('styles.css', publicDirectory), 'utf8'),
  build({
    entryPoints: [fileURLToPath(new URL('app.js', publicDirectory))],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
    minify: true, charset: 'utf8', legalComments: 'none',
    supported: { 'inline-script': true }, write: false, logLevel: 'silent',
  }),
]);
const script = bundled.outputFiles[0].text;
const style = (await transform(sourceCss, {
  loader: 'css', minify: true, charset: 'utf8', supported: { 'inline-style': true },
})).code;
// esbuild会转义HTML结束标签；仍在构建时检查，避免浏览器截断内嵌资源。
if (/<\/script/iu.test(script) || /<\/style/iu.test(style)) throw new Error('打包内容含有未转义的HTML结束标签');

const stylesheetTag = '<link rel="stylesheet" href="/styles.css">';
const scriptTag = '<script type="module" src="/app.js"></script>';
if (sourceHtml.split(stylesheetTag).length !== 2 || sourceHtml.split(scriptTag).length !== 2) {
  throw new Error('首页资源标签发生变化，请同步检查云端打包入口');
}
// 使用替换回调，保留JS中的$等字符，哈希对应浏览器实际收到的精确内容。
const html = sourceHtml.replace(stylesheetTag, () => `<style>${style}</style>`)
  .replace(scriptTag, () => `<script>${script}</script>`);
if (/<script\b[^>]*\bsrc\s*=/iu.test(html) || /<link\b[^>]*\brel\s*=\s*["']stylesheet["']/iu.test(html)) {
  throw new Error('云端首页仍包含外部阻塞脚本或样式');
}
const hash = value => `'sha256-${createHash('sha256').update(value, 'utf8').digest('base64')}'`;
const policy = `// 由build-frontend.mjs自动生成，只允许本次打包的精确脚本和样式。\n`
  + `export const FRONTEND_SCRIPT_HASH = ${JSON.stringify(hash(script))};\n`
  + `export const FRONTEND_STYLE_HASH = ${JSON.stringify(hash(style))};\n`;

await mkdir(assetsDirectory, { recursive: true });
await Promise.all([
  ...publicFiles.map(name => copyFile(new URL(name, publicDirectory), new URL(name, assetsDirectory))),
  writeFile(new URL('index.html', assetsDirectory), html, 'utf8'),
  writeFile(policyFile, policy, 'utf8'),
]);
console.log(`云端首屏已打包：HTML ${Buffer.byteLength(html)} 字节，gzip ${gzipSync(html).byteLength} 字节，Brotli ${brotliCompressSync(html).byteLength} 字节。`);
