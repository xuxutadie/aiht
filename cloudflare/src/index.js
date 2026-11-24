import { Store } from './store.js';
import { DomainError, COOKIE_NAME, SESSION_SECONDS, MODEL_DEFAULT, BASE_URL_DEFAULT, textValue } from './contracts.js';
import { sha256, constantTimeEqual, encryptSecret, decryptSecret } from './crypto.js';
import { validateProfile } from './auth.js';
import { validateAuthorizationCode, parseAuthorizationCodePage } from './authorization-codes.js';
import { DEFAULT_ANSWERS, sanitizeAnswers, buildPrompt, buildPreview } from './plans.js';
import { validateSettings, publicSettings, configFingerprint } from './provider.js';
import { handleQueue, handleScheduled } from './queue.js';
import { hashInRuntime, verifyInRuntime, getRuntimeImage } from './runtime-services.js';
import { FRONTEND_SCRIPT_HASH, FRONTEND_STYLE_HASH } from '../.wrangler/frontend-policy.js';

const BODY_LIMIT = 65536;
const USER_FIELDS = ['id', 'name', 'phone', 'region', 'school', 'grade', 'role', 'credits', 'reserved_credits', 'available_credits', 'unlimited_credits', 'created_at'];
// 不存在的账号也执行同等密码校验，避免通过运算时间判断手机号是否注册。
const DUMMY_PASSWORD_HASH = `scrypt$16384$8$1$${'00'.repeat(16)}$${'00'.repeat(32)}`;

const defaults = () => ({ model: MODEL_DEFAULT, base_url: BASE_URL_DEFAULT, watermark: true, api_key: '' });
const publicUser = user => user ? Object.fromEntries(USER_FIELDS.filter(key => key in user).map(key => [key, user[key]])) : null;
const publicArtwork = artwork => ({ ...artwork, image_path: `/api/artworks/${encodeURIComponent(artwork.id)}/image` });
const jsonResponse = (status, payload, cookie) => {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (cookie !== undefined) headers.set('Set-Cookie', `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${cookie ? SESSION_SECONDS : 0}`);
  return new Response(JSON.stringify(payload), { status, headers });
};

function secureResponse(response, url) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self' ${FRONTEND_SCRIPT_HASH}; style-src 'self' ${FRONTEND_STYLE_HASH}; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function sessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  if (cookie.length > 8192) return '';
  for (const field of cookie.split(';')) {
    const separator = field.indexOf('=');
    if (field.slice(0, separator).trim() === COOKIE_NAME) {
      const token = field.slice(separator + 1).trim();
      return /^[0-9a-f]{64}$/u.test(token) ? token : '';
    }
  }
  return '';
}

async function readJson(request) {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new DomainError(415, 'json_required', '请求必须使用JSON格式。');
  }
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > BODY_LIMIT)) {
    throw new DomainError(413, 'body_too_large', '提交内容过多，请适当精简。');
  }
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BODY_LIMIT) {
          await reader.cancel();
          throw new DomainError(413, 'body_too_large', '提交内容过多，请适当精简。');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new DomainError(400, 'invalid_json', '提交内容格式不正确。');
  }
}

function allowedOrigin(url, env) {
  if (!env.PUBLIC_URL) return url.origin;
  try {
    const configured = new URL(env.PUBLIC_URL);
    if (configured.protocol !== 'https:' || !['', '/'].includes(configured.pathname) || configured.search || configured.hash || configured.username || configured.password) throw new Error();
    if (configured.origin !== url.origin) throw new DomainError(403, 'invalid_host', '此访问地址尚未获准。');
    return configured.origin;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(503, 'invalid_deployment', '正式访问地址配置不正确，请联系管理员。');
  }
}

async function loadConfig(store, env) {
  const stored = await store.getSettings();
  const config = { ...defaults(), ...(stored || {}) };
  if (stored?.encrypted_key) {
    if (!env.CONFIG_ENCRYPTION_KEY) throw new DomainError(503, 'encryption_key_required', '绘图密钥保护尚未配置，请联系管理员。');
    try { config.api_key = await decryptSecret(stored.encrypted_key, env.CONFIG_ENCRYPTION_KEY); }
    catch { throw new DomainError(503, 'settings_unreadable', '无法读取出图配置，请联系管理员重新配置。'); }
  }
  delete config.encrypted_key;
  return config;
}

async function imageResponse(request, route, user, store, env) {
  const artwork = user.role === 'admin'
    ? await store.getArtworkForAdmin(user.id, route[1])
    : await store.getArtwork(user.id, route[1]);
  if (route.length === 2 && request.method === 'GET') return jsonResponse(200, { artwork: publicArtwork(artwork) });
  if (route.length !== 3 || !['image', 'download'].includes(route[2]) || request.method !== 'GET') {
    throw new DomainError(404, 'not_found', '没有找到此内容。');
  }
  const object = await getRuntimeImage(env, artwork.image_path);
  if (!object) throw new DomainError(404, 'image_missing', '图片文件暂不可用，请联系老师恢复。');
  const headers = new Headers({ 'Content-Type': artwork.mime, 'Cache-Control': 'private, no-store' });
  if (Number.isSafeInteger(object.size) && object.size >= 0) headers.set('Content-Length', String(object.size));
  if (route[2] === 'download') {
    const suffix = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[artwork.mime] || '';
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`作品图片${suffix}`)}`);
  }
  return new Response(object.body, { status: 200, headers });
}

async function apiResponse(request, url, route, env) {
  const store = new Store(env.DB);
  const method = request.method;
  if (!['GET', 'POST', 'PUT'].includes(method)) throw new DomainError(405, 'method_not_allowed', '不支持此操作。');
  const token = sessionToken(request);
  const tokenHash = token ? await sha256(token) : '';
  const user = tokenHash ? await store.getUserBySession(tokenHash) : null;
  const origin = allowedOrigin(url, env);
  let body = {};
  const ip = (request.headers.get('CF-Connecting-IP') || 'local').slice(0, 128);
  const ipHash = await sha256(ip);
  if (['POST', 'PUT'].includes(method)) {
    if (request.headers.get('Origin') !== origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      throw new DomainError(403, 'cross_origin', '请从作品创作台页面内操作。');
    }
    await store.checkRateLimit(user ? `write-user:${user.id}` : `anonymous-write:${ipHash}`, 180, 60);
    body = await readJson(request);
  }
  const path = route.join('/');
  const requireUser = (admin = false) => {
    if (!user) throw new DomainError(401, 'login_required', '请先注册或登录后使用。');
    if (admin && user.role !== 'admin') throw new DomainError(403, 'admin_required', '此功能仅供老师管理员使用。');
    return user;
  };
  const login = async account => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const raw = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    await store.createSession(account.id, await sha256(raw), Math.floor(Date.now() / 1000) + SESSION_SECONDS);
    return jsonResponse(200, { user: publicUser(account) }, raw);
  };

  if (path === 'bootstrap' && method === 'GET') {
    const settings = await store.getSettings();
    const setupRequired = !(await store.hasAdmin());
    return jsonResponse(200, {
      service: 'creation-studio', version: '2.0-cloudflare', instance_id: 'cloudflare-aiht',
      setup_required: setupRequired, setup_token_required: setupRequired,
      user: publicUser(user), generation_configured: Boolean(settings?.encrypted_key && env.CONFIG_ENCRYPTION_KEY), test_mode: false,
    });
  }
  if (path === 'setup' && method === 'POST') {
    await store.checkRateLimit(`setup:${ipHash}`, 10, 600);
    if (await store.hasAdmin()) throw new DomainError(409, 'admin_exists', '平台已经完成初始化，请直接登录。');
    if (typeof env.ADMIN_SETUP_TOKEN !== 'string' || env.ADMIN_SETUP_TOKEN.length < 16) {
      throw new DomainError(503, 'setup_token_not_configured', '云端初始化口令尚未配置，请先在部署设置中配置。');
    }
    if (typeof body.setup_token !== 'string' || body.setup_token.length > 512 || !(await constantTimeEqual(body.setup_token, env.ADMIN_SETUP_TOKEN))) {
      throw new DomainError(403, 'invalid_setup_token', '初始化口令不正确，请向平台负责人核实。');
    }
    const profile = validateProfile(body, 'admin');
    const account = await store.createUser(profile, await hashInRuntime(env, body.password), 'admin');
    return login(account);
  }
  if (path === 'register' && method === 'POST') {
    if (!(await store.hasAdmin())) throw new DomainError(409, 'setup_required', '请先由老师完成平台初始化。');
    await store.checkRateLimit(`register:${ipHash}`, 120, 600);
    const profile = validateProfile(body, 'student');
    const authorizationCode = validateAuthorizationCode(body.authorization_code);
    return login(await store.createUser(profile, await hashInRuntime(env, body.password), 'student', authorizationCode));
  }
  if (path === 'login' && method === 'POST') {
    await store.checkRateLimit(`login:${ipHash}`, 60, 600);
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    await store.checkRateLimit(`phone:${await sha256(phone.slice(0, 32))}`, 8, 600);
    const record = /^1[3-9][0-9]{9}$/u.test(phone) ? await store.findUserByPhone(phone) : null;
    const verified = await verifyInRuntime(env, body.password, record?.password_hash || DUMMY_PASSWORD_HASH);
    if (!record || !verified) throw new DomainError(401, 'invalid_credentials', '手机号或密码不正确。');
    return login(await store.getUser(record.id));
  }
  if (path === 'logout' && method === 'POST') {
    if (tokenHash) await store.deleteSession(tokenHash);
    return jsonResponse(200, { ok: true }, '');
  }

  requireUser();
  if (path === 'me' && method === 'GET') return jsonResponse(200, { user: publicUser(user) });
  if (path === 'credits' && method === 'GET') return jsonResponse(200, { user: publicUser(user), entries: await store.ledger(user.id) });
  if (path === 'plans' && method === 'GET') return jsonResponse(200, { plans: await store.listPlans(user.id) });
  if (path === 'plans' && method === 'POST') {
    const answers = { ...DEFAULT_ANSWERS, ...sanitizeAnswers(body.answers ?? {}) };
    return jsonResponse(201, { plan: await store.createPlan(user.id, body.title ?? '我的新作品', answers) });
  }
  if (route.length === 2 && route[0] === 'plans' && method === 'GET') return jsonResponse(200, { plan: await store.getPlan(user.id, route[1]) });
  if (route.length === 2 && route[0] === 'plans' && method === 'PUT') {
    const answers = sanitizeAnswers(body.answers ?? {});
    const confirmed = body.confirmed ?? false;
    if (typeof confirmed !== 'boolean') throw new DomainError(400, 'invalid_confirmation', '方案确认状态不正确。');
    if (confirmed) buildPrompt(answers);
    const plan = await store.savePlan(user.id, route[1], { title: body.title, answers, step: body.step ?? 0, confirmed });
    return jsonResponse(200, { plan });
  }
  if (route.length === 3 && route[0] === 'plans' && route[2] === 'preview' && method === 'POST') {
    const plan = await store.getPlan(user.id, route[1]);
    return jsonResponse(200, buildPreview(plan.answers));
  }
  if (path === 'generate' && method === 'POST') {
    await store.checkRateLimit(`generate:${user.id}`, 20, 60);
    const planId = textValue(body.plan_id, '创作方案', 128, false);
    const requestKey = textValue(body.request_key, '请求标识', 128, false);
    const previous = await store.getJobByRequest(user.id, requestKey);
    if (previous) {
      if (previous.plan_id !== planId) throw new DomainError(409, 'request_conflict', '该请求标识已用于其他内容，请重新发起创作。');
      return jsonResponse(202, { job: previous, user: publicUser(await store.getUser(user.id)) });
    }
    if (!env.GENERATION_QUEUE?.send) throw new DomainError(503, 'generation_unavailable', '云端绘图队列尚未配置，请联系管理员。');
    const plan = await store.getPlan(user.id, planId);
    if (!plan.confirmed) throw new DomainError(409, 'plan_unconfirmed', '请先完成自查并确认创作方案。');
    const prompt = buildPrompt(plan.answers);
    const config = validateSettings({}, await loadConfig(store, env));
    if (!config.api_key) throw new DomainError(503, 'generation_not_configured', '绘图服务还没有配置，请联系老师。');
    const options = { ratio: plan.answers.ratio, style: plan.answers.style, model: config.model, base_url: config.base_url,
      quality: config.quality, watermark: config.watermark, config_fingerprint: await configFingerprint(config) };
    let job = await store.reserveGeneration(user.id, planId, requestKey, prompt, options, plan.revision);
    if (job.newly_created && job.status === 'queued') {
      try { await env.GENERATION_QUEUE.send({ job_id: job.id }); }
      catch {
        // 网络报错不能证明Queue未接受；冻结结果，避免下一次自动重发付费调用。
        await store.failGeneration(job.id, '任务投递结果尚不确定，请联系老师核对。', true, true);
        job = await store.getJob(user.id, job.id);
      }
    }
    return jsonResponse(202, { job, user: publicUser(await store.getUser(user.id)) });
  }
  if (route.length === 2 && route[0] === 'jobs' && method === 'GET') {
    return jsonResponse(200, { job: await store.getJob(user.id, route[1]), user: publicUser(await store.getUser(user.id)) });
  }
  if (path === 'artworks' && method === 'GET') return jsonResponse(200, { artworks: (await store.listArtworks(user.id)).map(publicArtwork) });
  if (route.length >= 2 && route[0] === 'artworks') {
    if (route.length === 2 && method === 'PUT') {
      const artwork = await store.updateArtwork(user.id, route[1], body.reflection ?? '', body.description ?? '');
      return jsonResponse(200, { artwork: publicArtwork(artwork) });
    }
    return imageResponse(request, route, user, store, env);
  }
  if (route[0] === 'admin') {
    requireUser(true);
    if (path === 'admin/authorization-codes' && method === 'GET') {
      return jsonResponse(200, await store.listAuthorizationCodes(user.id, parseAuthorizationCodePage(url.searchParams)));
    }
    if (path === 'admin/authorization-codes' && method === 'POST') {
      return jsonResponse(201, { codes: await store.createAuthorizationCodes(user.id, body.count === undefined ? 1 : body.count) });
    }
    if (path === 'admin/settings' && method === 'GET') return jsonResponse(200, await publicSettings(await loadConfig(store, env)));
    if (path === 'admin/settings' && method === 'PUT') {
      if (!env.CONFIG_ENCRYPTION_KEY) throw new DomainError(503, 'encryption_key_required', '绘图密钥保护尚未配置，请联系管理员。');
      const stored = await store.getSettings();
      const hasNewKey = typeof body.api_key === 'string' && body.api_key.trim() !== '';
      const current = hasNewKey ? { ...defaults(), ...(stored || {}), api_key: '' } : await loadConfig(store, env);
      const config = await validateSettings(body, current);
      const encryptedKey = hasNewKey ? await encryptSecret(config.api_key, env.CONFIG_ENCRYPTION_KEY) : stored?.encrypted_key;
      await store.saveSettings({ model: config.model, base_url: config.base_url, watermark: config.watermark,
        quality: config.quality, encrypted_key: encryptedKey || null });
      return jsonResponse(200, await publicSettings(config));
    }
    if (path === 'admin/overview' && method === 'GET') {
      const users = (await store.listUsers()).map(publicUser);
      const uncertain = await store.listUncertainJobs();
      return jsonResponse(200, { users, uncertain_jobs: uncertain, stats: { users: users.length, uncertain_jobs: uncertain.length, remaining_credits: users.filter(account => account.role === 'student').reduce((sum, account) => sum + account.credits, 0) } });
    }
    if (route.length === 4 && route[1] === 'jobs' && route[3] === 'resolve' && method === 'POST') {
      if (typeof body.consume !== 'boolean') throw new DomainError(400, 'invalid_decision', '请选择实际核对结果。');
      await store.resolveUncertainJob(route[2], body.consume, user.id, body.reason ?? '');
      return jsonResponse(200, { ok: true });
    }
    throw new DomainError(404, 'not_found', '没有找到此管理功能。');
  }
  throw new DomainError(404, 'not_found', '没有找到此内容。');
}

export async function handleFetch(request, env) {
  const url = new URL(request.url);
  let response;
  try {
    if (request.method === 'OPTIONS') throw new DomainError(403, 'cross_origin', '不允许跨站调用。');
    let route;
    try { route = decodeURIComponent(url.pathname).split('/').filter(Boolean); }
    catch { throw new DomainError(400, 'invalid_path', '访问地址不正确。'); }
    if (route.some(part => part.startsWith('.'))) throw new DomainError(404, 'not_found', '页面不存在。');
    allowedOrigin(url, env);
    if (route[0] === 'api') response = await apiResponse(request, url, route.slice(1), env);
    else {
      if (!['GET', 'HEAD'].includes(request.method)) throw new DomainError(405, 'method_not_allowed', '不支持此操作。');
      if (!env.ASSETS?.fetch) throw new DomainError(503, 'assets_unavailable', '网页资源尚未部署，请联系管理员。');
      response = await env.ASSETS.fetch(request);
    }
  } catch (error) {
    response = error instanceof DomainError
      ? jsonResponse(error.status, { error: { code: error.code, message: error.message } })
      : jsonResponse(500, { error: { code: 'internal_error', message: '服务暂时遇到问题，请稍后再试。' } });
  }
  return secureResponse(response, url);
}

export default {
  fetch: handleFetch,
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: (_controller, env, context) => context.waitUntil(handleScheduled(env)),
};

export { AihtRuntimeServices } from './runtime-services.js';
