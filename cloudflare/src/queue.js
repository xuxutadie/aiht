import { Store } from './store.js';
import { newId } from './contracts.js';
import { buildSummary } from './plans.js';
import { decryptSecret } from './crypto.js';
import { generateImage, validateSettings, configFingerprint, ProviderError } from './provider.js';
import { getImageStorage } from './image-storage.js';

async function readGenerationConfig(store, env) {
  const stored = await store.getSettings();
  if (!stored?.encrypted_key) throw new ProviderError('绘图服务尚未配置，请联系老师。');
  try {
    const apiKey = await decryptSecret(stored.encrypted_key, env.CONFIG_ENCRYPTION_KEY);
    const config = validateSettings({ api_key: apiKey }, stored);
    if (!config.api_key) throw new Error('没有绘图密钥。');
    return config;
  } catch { throw new ProviderError('出图配置无法使用，请联系管理员检查设置。'); }
}

function acknowledge(message) {
  // 消费函数始终正常结束；即使确认方法异常，也不抛出导致平台自动重试收费请求。
  try { message.ack(); } catch { console.error('绘图消息确认未能返回，请按任务编号人工核对。'); }
}

export async function processQueueMessage(message, store, env, generate = generateImage) {
  const jobId = message?.body?.job_id;
  let claimed = false;
  let submitted = false;
  try {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(jobId)) return;
    const job = await store.claimJob(jobId);
    // 其他消费者正在运行或任务已经结算时，只确认重复消息，不改变它的任务状态。
    if (!job) return;
    claimed = true;
    const config = await readGenerationConfig(store, env);
    // 任务排队期间更换平台、模型、密钥或清晰度时，不把旧任务送到新配置。
    const snapshot = job.options || {};
    const changed = Object.hasOwn(snapshot, 'config_fingerprint')
      ? snapshot.config_fingerprint !== await configFingerprint(config)
      : config.provider !== 'ark' || (snapshot.model && snapshot.model !== config.model)
        || (snapshot.base_url && snapshot.base_url !== config.base_url)
        || (typeof snapshot.watermark === 'boolean' && snapshot.watermark !== config.watermark);
    if (changed) throw new ProviderError('绘图配置已变更，本次尚未发送请求，算力不扣除。请重新确认后再生成。');
    submitted = true;
    const image = await generate(config, job.prompt, job.options);
    await store.recordProviderResult(jobId, image.upstream_request_id, image.usage);
    const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[image.mime];
    if (!extension || !(image.data instanceof Uint8Array)) throw new ProviderError('绘图服务返回的作品格式需要老师核对。', true, image.upstream_request_id);
    const artworkId = newId();
    const imagePath = `artworks/${job.user_id}/${artworkId}${extension}`;
    await getImageStorage(env).put(imagePath, image.data, { httpMetadata: { contentType: image.mime }, customMetadata: { job_id: jobId, artwork_id: artworkId } });
    const artwork = await store.completeGeneration(jobId, { id: artworkId, image_path: imagePath, mime: image.mime, width: image.width, height: image.height, description: buildSummary(job.answers), reflection: '' });
    if (!artwork) throw new ProviderError('图片已经保存，任务结算结果待老师核对。', true, image.upstream_request_id);
  } catch (error) {
    if (claimed) {
      const uncertain = submitted && (!(error instanceof ProviderError) || error.uncertain);
      const messageText = error instanceof ProviderError ? error.message : '生成结果需要老师核对，请勿重复提交。';
      if (error instanceof ProviderError && error.requestId) {
        try { await store.recordProviderResult(jobId, error.requestId); }
        catch { console.error('绘图请求编号保存未能确认。'); }
      }
      try { await store.failGeneration(jobId, messageText, uncertain); }
      catch { console.error('绘图任务结果未能结算，定时任务将保留预留等待核对。'); }
    } else {
      // 领取操作的返回值丢失时，不能确定本消费者是否拥有任务；留给超时核对，避免抢改活任务。
      console.error('绘图任务尚未领取确认，等待定时核对。');
    }
  } finally { acknowledge(message); }
}

export async function handleQueue(batch, env, generateImageOverride) {
  const messages = Array.isArray(batch?.messages) ? batch.messages : [];
  try {
    const store = new Store(env.DB);
    const generate = generateImageOverride === undefined ? generateImage : generateImageOverride;
    if (typeof generate !== 'function') throw new Error('生成函数格式不正确。');
    for (const message of messages) await processQueueMessage(message, store, env, generate);
  } catch {
    // 不依赖队列重试来重新调用付费模型；仍在queued/running的记录由定时维护转待核对。
    for (const message of messages) acknowledge(message);
    console.error('绘图消费入口暂不可用，等待任务人工核对。');
  }
}

export async function sweepStaleJobs(store, timestamp = Date.now()) {
  await store.markStaleJobsUncertain(new Date(timestamp - 10 * 60 * 1000).toISOString());
  await store.cleanupRateLimits();
}

export async function handleScheduled(env) {
  try { await sweepStaleJobs(new Store(env.DB)); }
  catch { console.error('定时任务维护暂未完成，将在下次维护时继续核对。'); }
}
