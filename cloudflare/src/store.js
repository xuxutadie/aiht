import { DomainError, INITIAL_CREDITS, ADMIN_UNLIMITED_RESERVE_NOTE, IMAGE_STORAGE_BUDGET, IMAGE_RESERVATION_BYTES, now, newId, textValue } from './contracts.js';
import { sha256 } from './crypto.js';
import { validateAuthorizationCode, validateAuthorizationCodeCount, validateAuthorizationCodePage,
  randomAuthorizationCode, authorizationCodeGenerationError, authorizationCodeRecord } from './authorization-codes.js';

const USER_FIELDS = ['id', 'name', 'phone', 'region', 'school', 'grade', 'role', 'credits', 'reserved_credits', 'created_at'];
const JOB_FIELDS = ['id', 'user_id', 'plan_id', 'status', 'error_message', 'artwork_id', 'created_at', 'updated_at', 'upstream_request_id'];
const USAGE_FIELDS = ['generated_images', 'input_images', 'output_tokens', 'total_tokens'];
// 固定免扣标记跟随任务写入流水；旧任务没有此标记，仍按已预留的点数结算。
const UNLIMITED_JOB_SQL = `EXISTS (SELECT 1 FROM ledger AS reserve_entry WHERE reserve_entry.job_id = jobs.id
  AND reserve_entry.user_id = jobs.user_id AND reserve_entry.kind = 'reserve' AND reserve_entry.note = '${ADMIN_UNLIMITED_RESERVE_NOTE}')`;
const JOB_SELECT = `SELECT jobs.*, ${UNLIMITED_JOB_SQL} AS unlimited_credits FROM jobs`;

function found(row, message) {
  if (!row) throw new DomainError(404, 'not_found', message);
  return row;
}
function userRecord(row) {
  found(row, '账号不存在。');
  const user = Object.fromEntries(USER_FIELDS.map(key => [key, row[key]]));
  user.available_credits = user.credits - user.reserved_credits;
  user.unlimited_credits = user.role === 'admin';
  return user;
}
function planRecord(row) {
  found(row, '创作方案不存在。');
  return { ...row, answers: JSON.parse(row.answers), confirmed: Boolean(row.confirmed) };
}
function jobRecord(row) {
  found(row, '生成任务不存在。');
  return { ...Object.fromEntries(JOB_FIELDS.map(key => [key, row[key]])), unlimited_credits: Boolean(row.unlimited_credits) };
}
function reservationResult(job, newlyCreated) {
  // 仅本次HTTP调用使用；恢复请求不会重复投递，JSON仍保留原有公开字段。
  Object.defineProperty(job, 'newly_created', { value: newlyCreated, enumerable: false });
  return job;
}
function internalJob(row) {
  return { ...jobRecord(row), prompt: row.prompt, options: JSON.parse(row.options),
    answers: JSON.parse(row.snapshot_answers), title: row.snapshot_title,
    reservation_active: row.reservation_active, storage_reservation_bytes: row.storage_reservation_bytes, usage: JSON.parse(row.usage_json) };
}
function artworkRecord(row) {
  found(row, '作品不存在。');
  return { ...row, answers: JSON.parse(row.answers) };
}
function jsonObject(value, label = '创作答案', maximum = 32768) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError(400, 'invalid_input', `${label}必须是对象。`);
  try {
    const sort = input => {
      if (Array.isArray(input)) return input.map(sort);
      if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])]));
      if (input === undefined || ['function', 'symbol', 'bigint'].includes(typeof input) || (typeof input === 'number' && !Number.isFinite(input))) throw new Error('invalid');
      return input;
    };
    const encoded = JSON.stringify(sort(value));
    if (new TextEncoder().encode(encoded).length > maximum) throw new Error('large');
    return encoded;
  } catch {
    throw new DomainError(400, 'invalid_input', `${label}格式不正确或超过大小限制。`);
  }
}
function validateUser(profile, passwordHash, role) {
  if (!profile || typeof profile !== 'object' || !['student', 'admin'].includes(role)) throw new DomainError(400, 'invalid_profile', '账号资料格式不正确。');
  const values = {};
  for (const [key, label, maximum] of [['name', '姓名', 50], ['phone', '手机号', 11], ['region', '地区', 100], ['school', '学校', 100], ['grade', '年级', 30]]) {
    values[key] = textValue(profile[key] ?? '', label, maximum, role !== 'student' && !['name', 'phone'].includes(key));
  }
  if (!/^1[3-9][0-9]{9}$/.test(values.phone)) throw new DomainError(400, 'invalid_phone', '请填写11位中国大陆手机号。');
  textValue(passwordHash, '密码摘要', 300, false);
  return values;
}

export class Store {
  constructor(db) { this.db = db; }
  statement(query, ...values) { return this.db.prepare(query).bind(...values); }
  async first(query, ...values) { return this.statement(query, ...values).first(); }
  async all(query, ...values) { return (await this.statement(query, ...values).all()).results; }

  async hasAdmin() { return Boolean(await this.first("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1")); }
  async createUser(profile, passwordHash, role = 'student', authorizationCode) {
    const value = validateUser(profile, passwordHash, role);
    const codeHash = role === 'student' ? await sha256(validateAuthorizationCode(authorizationCode)) : null;
    const id = newId(), timestamp = now();
    const initialCredits = role === 'admin' ? 0 : INITIAL_CREDITS;
    try {
      // D1 batch是一个事务：条件建号、赠送流水、用码记录一起提交；并发请求不能各自先查后写。
      const create = role === 'student'
        ? this.statement(`INSERT INTO users (id,name,phone,region,school,grade,role,password_hash,credits,reserved_credits,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,0,? FROM authorization_codes WHERE code_hash = ? AND used_by IS NULL`,
        id, value.name, value.phone, value.region, value.school, value.grade, role, passwordHash, initialCredits, timestamp, codeHash)
        : this.statement(`INSERT INTO users (id,name,phone,region,school,grade,role,password_hash,credits,reserved_credits,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,0,?)`, id, value.name, value.phone, value.region, value.school, value.grade, role, passwordHash, initialCredits, timestamp);
      const statements = [create,
        this.statement(`INSERT INTO ledger (id,user_id,kind,delta,balance_after,job_id,note,created_at)
          SELECT ?,id,'grant',?,?,NULL,?,? FROM users WHERE id = ?`,
        newId(), initialCredits, initialCredits, role === 'admin' ? '管理员享有无限算力' : '首次注册赠送10点算力', timestamp, id)];
      if (role === 'student') statements.push(this.statement(`UPDATE authorization_codes SET used_by = ?, used_at = ?
        WHERE code_hash = ? AND used_by IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ?)`, id, timestamp, codeHash, id));
      const result = await this.db.batch(statements);
      if (role === 'student' && result.some(item => item.meta.changes !== 1)) {
        throw new DomainError(400, 'invalid_authorization_code', '授权码无效或已使用，请向老师获取新的授权码。');
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (role === 'admin' && await this.hasAdmin()) throw new DomainError(409, 'setup_complete', '管理员已完成初始化，请直接登录。');
      if (await this.findUserByPhone(value.phone)) throw new DomainError(409, 'phone_registered', '该手机号已注册，请直接登录。');
      throw error;
    }
    return this.getUser(id);
  }
  async findUserByPhone(phone) { return this.first('SELECT * FROM users WHERE phone = ?', phone); }
  async getUser(id) { return userRecord(await this.first('SELECT * FROM users WHERE id = ?', id)); }
  async listUsers() { return (await this.all('SELECT * FROM users ORDER BY created_at DESC, rowid DESC')).map(userRecord); }

  async createAuthorizationCodes(adminId, count = 1) {
    if ((await this.getUser(adminId)).role !== 'admin') throw new DomainError(403, 'admin_required', '仅管理员可以生成授权码。');
    validateAuthorizationCodeCount(count);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const codes = new Set();
      for (let draw = 0; codes.size < count && draw < count * 10; draw += 1) codes.add(randomAuthorizationCode());
      if (codes.size !== count) throw authorizationCodeGenerationError();
      const timestamp = now();
      const values = await Promise.all([...codes].map(async code => ({ code, code_hash: await sha256(code), code_hint: code.slice(-4) })));
      try {
        // 整批事务避免碰撞时留下已入库却未向老师展示的授权码。
        const result = await this.db.batch(values.map(item => this.statement(`INSERT INTO authorization_codes
          (code_hash,code_hint,created_by,created_at,used_by,used_at) VALUES (?,?,?,?,NULL,NULL)`,
        item.code_hash, item.code_hint, adminId, timestamp)));
        return values.map((item, index) => ({ ...authorizationCodeRecord({ id: result[index].meta.last_row_id,
          code_hint: item.code_hint, created_at: timestamp, used_by: null, used_at: null }), code: item.code }));
      } catch (error) {
        if (!/UNIQUE constraint failed: authorization_codes\.code_hash/u.test(String(error.message))) throw error;
      }
    }
    throw authorizationCodeGenerationError();
  }
  async listAuthorizationCodes(adminId, options = {}) {
    if ((await this.getUser(adminId)).role !== 'admin') throw new DomainError(403, 'admin_required', '仅管理员可以查看授权码。');
    const { limit, before } = validateAuthorizationCodePage(options);
    const fields = 'id,code_hint,created_at,used_by,used_at';
    const rows = before === null
      ? await this.all(`SELECT ${fields} FROM authorization_codes ORDER BY id DESC LIMIT ?`, limit + 1)
      : await this.all(`SELECT ${fields} FROM authorization_codes WHERE id < ? ORDER BY id DESC LIMIT ?`, before, limit + 1);
    const codes = rows.slice(0, limit).map(authorizationCodeRecord);
    return { codes, next_cursor: rows.length > limit ? codes.at(-1).id : null };
  }

  async createSession(userId, tokenHash, expiresAt) {
    await this.getUser(userId);
    if (typeof tokenHash !== 'string' || tokenHash.length > 256 || !tokenHash || !Number.isSafeInteger(expiresAt)) throw new DomainError(400, 'invalid_session', '会话格式不正确。');
    await this.db.batch([
      this.statement('DELETE FROM sessions WHERE expires_at <= ?', Math.floor(Date.now() / 1000)),
      this.statement('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)', tokenHash, userId, expiresAt, now()),
    ]);
  }
  async getUserBySession(tokenHash) {
    if (typeof tokenHash !== 'string' || !tokenHash || tokenHash.length > 256) return null;
    const row = await this.first(`SELECT users.* FROM users JOIN sessions ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`, tokenHash, Math.floor(Date.now() / 1000));
    return row ? userRecord(row) : null;
  }
  async deleteSession(tokenHash) { await this.statement('DELETE FROM sessions WHERE token_hash = ?', tokenHash).run(); }

  async createPlan(userId, title = '', answers = {}) {
    await this.getUser(userId);
    const cleanTitle = textValue(title, '方案标题', 120) || '我的创作方案';
    const encoded = jsonObject(answers);
    const id = newId(), timestamp = now();
    await this.statement(`INSERT INTO plans (id,user_id,title,answers,step,confirmed,revision,created_at,updated_at)
      VALUES (?,?,?,?,0,0,1,?,?)`, id, userId, cleanTitle, encoded, timestamp, timestamp).run();
    return this.getPlan(userId, id);
  }
  async listPlans(userId) { return (await this.all('SELECT * FROM plans WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC', userId)).map(planRecord); }
  async getPlan(userId, id) { return planRecord(await this.first('SELECT * FROM plans WHERE id = ? AND user_id = ?', id, userId)); }
  async savePlan(userId, id, { title, answers, step, confirmed = false }) {
    if (!Number.isInteger(step) || step < 0 || step > 6) throw new DomainError(400, 'invalid_step', '创作步骤须为0至6之间的整数。');
    if (typeof confirmed !== 'boolean') throw new DomainError(400, 'invalid_confirmation', '请使用勾选确认状态。');
    const previous = found(await this.first('SELECT * FROM plans WHERE id = ? AND user_id = ?', id, userId), '创作方案不存在。');
    const cleanTitle = title === undefined ? previous.title : textValue(title, '方案标题', 120) || '我的创作方案';
    const encoded = jsonObject(answers);
    const changed = encoded !== previous.answers || cleanTitle !== previous.title;
    const result = await this.statement(`UPDATE plans SET title = ?, answers = ?, step = ?, confirmed = ?, revision = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND revision = ?`, cleanTitle, encoded, step, Number(confirmed && !(previous.confirmed && changed)),
    previous.revision + Number(changed), now(), id, userId, previous.revision).run();
    if (!result.meta.changes) throw new DomainError(409, 'plan_changed', '创作方案刚刚被修改，请重新加载后再保存。');
    return this.getPlan(userId, id);
  }

  async getJobByRequest(userId, requestKey) {
    if (typeof requestKey !== 'string' || !requestKey || requestKey.length > 128) return null;
    const row = await this.first(`${JOB_SELECT} WHERE user_id = ? AND request_key = ?`, userId, requestKey);
    return row ? jobRecord(row) : null;
  }
  async reserveGeneration(userId, planId, requestKey, prompt, options, expectedRevision) {
    requestKey = textValue(requestKey, '请求标识', 128, false);
    const existing = await this.getJobByRequest(userId, requestKey);
    if (existing) {
      if (existing.plan_id !== planId) throw new DomainError(409, 'request_conflict', '该请求标识已用于其他内容，请重新发起创作。');
      return reservationResult(existing, false);
    }
    prompt = textValue(prompt, '绘图提示词', 20000, false);
    const encodedOptions = jsonObject(options, '绘图选项', 8192);
    const plan = await this.getPlan(userId, planId);
    const revision = expectedRevision ?? plan.revision;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new DomainError(400, 'invalid_revision', '方案版本格式不正确。');
    const id = newId(), timestamp = now();
    // batch中的筛选、预留、流水一起提交；请求之间不保留数据库事务。
    await this.db.batch([
      this.statement(`INSERT OR IGNORE INTO jobs
        (id,user_id,plan_id,request_key,prompt,options,snapshot_answers,snapshot_title,status,reservation_active,storage_reservation_bytes,error_message,artwork_id,created_at,updated_at)
        SELECT ?,users.id,plans.id,?,?,?,plans.answers,plans.title,'queued',1,?,NULL,NULL,?,?
        FROM plans JOIN users ON users.id = plans.user_id
        WHERE plans.id = ? AND plans.user_id = ? AND plans.confirmed = 1 AND plans.revision = ?
          AND (users.role = 'admin' OR users.credits - users.reserved_credits >= 1)
          AND (SELECT COALESCE(SUM(encoded_size),0) FROM image_objects)
            + (SELECT COALESCE(SUM(storage_reservation_bytes),0) FROM jobs) <= ? - ?`,
      id, requestKey, prompt, encodedOptions, IMAGE_RESERVATION_BYTES, timestamp, timestamp, planId, userId, revision, IMAGE_STORAGE_BUDGET, IMAGE_RESERVATION_BYTES),
      this.statement(`UPDATE users SET reserved_credits = reserved_credits + 1 WHERE id = ? AND role <> 'admin'
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND reservation_active = 1 AND status = 'queued')`, userId, id),
      this.statement(`INSERT INTO ledger (id,user_id,kind,delta,balance_after,job_id,note,created_at)
        SELECT ?,users.id,'reserve',0,users.credits,jobs.id,CASE WHEN users.role = 'admin' THEN ? ELSE ? END,?
        FROM users JOIN jobs ON jobs.user_id = users.id
        WHERE jobs.id = ?`, newId(), ADMIN_UNLIMITED_RESERVE_NOTE, '已预留1点算力，生成成功后扣除', timestamp, id),
    ]);
    const job = await this.getJobByRequest(userId, requestKey);
    if (job) {
      if (job.plan_id !== planId) throw new DomainError(409, 'request_conflict', '该请求标识已用于其他内容，请重新发起创作。');
      return reservationResult(job, job.id === id);
    }
    const latest = await this.getPlan(userId, planId);
    if (latest.revision !== revision) throw new DomainError(409, 'plan_changed', '创作方案刚刚被修改，请重新查看并确认后再生成。');
    if (!latest.confirmed) throw new DomainError(409, 'plan_unconfirmed', '请先完成自查并确认创作方案。');
    const user = await this.getUser(userId);
    if (user.unlimited_credits || user.available_credits >= 1) throw new DomainError(409, 'storage_capacity', '云端图片存储空间不足，请联系管理员整理后再生成。本次未消耗算力。');
    throw new DomainError(409, 'insufficient_credits', user.credits === 0
      ? '算力已用完，请联系管理员进行补充算力。' : '当前算力已全部预留，请等待生成结果或联系老师核对。');
  }
  async getJob(userId, id) { return jobRecord(await this.first(`${JOB_SELECT} WHERE id = ? AND user_id = ?`, id, userId)); }
  async getJobInternal(id) { return internalJob(await this.first(`${JOB_SELECT} WHERE id = ?`, id)); }
  async claimJob(id) {
    const row = await this.statement(`UPDATE jobs SET status = 'running', updated_at = ?
      WHERE id = ? AND status = 'queued' AND reservation_active = 1 RETURNING *, ${UNLIMITED_JOB_SQL} AS unlimited_credits`, now(), id).first();
    return row ? internalJob(row) : null;
  }
  async recordProviderResult(id, requestId, usage = {}) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{0,160}$/.test(requestId)) throw new DomainError(400, 'invalid_upstream_request_id', '上游请求编号格式不正确。');
    jsonObject(usage, '上游用量信息', 4096);
    const clean = Object.fromEntries(USAGE_FIELDS.filter(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0 && usage[key] <= 10 ** 12).map(key => [key, usage[key]]));
    await this.getJobInternal(id);
    await this.statement(`UPDATE jobs SET upstream_request_id = CASE WHEN ? = '' THEN upstream_request_id ELSE ? END,
      usage_json = ?, updated_at = ? WHERE id = ?`, requestId, requestId, JSON.stringify(clean), now(), id).run();
  }

  async completeGeneration(id, artifact) {
    const previous = await this.getJobInternal(id);
    if (previous.status === 'succeeded') return artworkRecord(await this.first('SELECT * FROM artworks WHERE job_id = ?', id));
    if (previous.status !== 'running') return null;
    if (!artifact || typeof artifact !== 'object') throw new DomainError(400, 'invalid_artifact', '作品元信息格式不正确。');
    const artworkId = textValue(artifact.id, '作品编号', 128, false);
    const imagePath = textValue(artifact.image_path, '作品图片路径', 4096, false);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mime)
      || [artifact.width, artifact.height].some(value => !Number.isInteger(value) || value < 1 || value > 20000)) throw new DomainError(400, 'invalid_artifact', '作品图片格式或尺寸不正确。');
    const description = textValue(artifact.description ?? '', '作品说明', 5000);
    const reflection = textValue(artifact.reflection ?? '', '作品反思', 5000);
    const timestamp = now();
    const points = previous.unlimited_credits ? 0 : 1;
    await this.db.batch([
      this.statement(`INSERT INTO artworks (id,user_id,job_id,plan_id,title,image_path,mime,width,height,prompt,answers,description,reflection,created_at)
        SELECT ?,user_id,id,plan_id,snapshot_title,?,?,?,?,prompt,snapshot_answers,?,?,? FROM jobs
        WHERE id = ? AND status = 'running' AND reservation_active = 1`, artworkId, imagePath, artifact.mime, artifact.width, artifact.height, description, reflection, timestamp, id),
      ...(points ? [this.statement(`UPDATE users SET credits = credits - 1, reserved_credits = reserved_credits - 1
        WHERE id = (SELECT user_id FROM jobs WHERE id = ? AND status = 'running' AND reservation_active = 1)
          AND EXISTS (SELECT 1 FROM artworks WHERE id = ? AND job_id = ?)`, id, artworkId, id)] : []),
      this.statement(`INSERT INTO ledger (id,user_id,kind,delta,balance_after,job_id,note,created_at)
        SELECT ?,users.id,'consume',?,users.credits,jobs.id,?,? FROM users JOIN jobs ON jobs.user_id = users.id
        WHERE jobs.id = ? AND jobs.status = 'running' AND jobs.reservation_active = 1
          AND EXISTS (SELECT 1 FROM artworks WHERE id = ? AND job_id = jobs.id)`, newId(), -points,
      previous.unlimited_credits ? '单张作品生成成功，管理员无限算力，不扣点数' : '单张作品生成成功，扣除1点算力', timestamp, id, artworkId),
      this.statement(`UPDATE jobs SET status = 'succeeded', reservation_active = 0, storage_reservation_bytes = 0, artwork_id = ?, error_message = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM artworks WHERE id = ? AND job_id = ?)`, artworkId, timestamp, id, artworkId, id),
    ]);
    const completed = await this.getJobInternal(id);
    return completed.status === 'succeeded' ? artworkRecord(await this.first('SELECT * FROM artworks WHERE job_id = ?', id)) : null;
  }
  async failGeneration(id, message, uncertain = false, onlyQueued = false) {
    if (typeof uncertain !== 'boolean' || typeof onlyQueued !== 'boolean') throw new DomainError(400, 'invalid_input', '任务状态格式不正确。');
    message = textValue(message, '任务说明', 1000) || '生成未完成，请联系老师。';
    const job = await this.getJobInternal(id);
    const timestamp = now();
    // 投递请求报错时可能消费者已开始工作，只允许原子冻结尚未领取的queued任务。
    // 这里的SQL片段来自固定布尔分支，不接受请求中的SQL或状态文字。
    const eligible = onlyQueued ? "'queued'" : "'queued','running'";
    const statements = [];
    if (!uncertain && !job.unlimited_credits) statements.push(this.statement(`UPDATE users SET reserved_credits = reserved_credits - 1
      WHERE id = (SELECT user_id FROM jobs WHERE id = ? AND status IN (${eligible}) AND reservation_active = 1)`, id));
    if (!uncertain) statements.push(this.statement(`DELETE FROM image_objects WHERE job_id = ? AND completed = 0
      AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status IN (${eligible}) AND reservation_active = 1)`, id, id));
    statements.push(
      this.statement(`INSERT INTO ledger (id,user_id,kind,delta,balance_after,job_id,note,created_at)
        SELECT ?,users.id,?,0,users.credits,jobs.id,?,? FROM users JOIN jobs ON jobs.user_id = users.id
        WHERE jobs.id = ? AND jobs.status IN (${eligible}) AND jobs.reservation_active = 1`, newId(), uncertain ? 'freeze' : 'release',
      job.unlimited_credits ? (uncertain ? '结果待核对，管理员无限算力，无需预留点数' : '生成明确失败，管理员无限算力，不扣点数')
        : (uncertain ? '结果待核对，保留预留的1点算力' : '生成明确失败，不扣算力，已释放预留的1点算力'), timestamp, id),
      this.statement(`UPDATE jobs SET status = ?, reservation_active = ?, storage_reservation_bytes = ${uncertain ? 'storage_reservation_bytes' : '0'}, error_message = ?, updated_at = ?
        WHERE id = ? AND status IN (${eligible}) AND reservation_active = 1`, uncertain ? 'uncertain' : 'failed', Number(uncertain), message, timestamp, id),
    );
    await this.db.batch(statements);
  }
  async listUncertainJobs() { return (await this.all(`${JOB_SELECT} WHERE status = 'uncertain' ORDER BY created_at, rowid`)).map(jobRecord); }
  async resolveUncertainJob(id, consume, adminId, reason) {
    if (typeof consume !== 'boolean') throw new DomainError(400, 'invalid_input', '请选择扣除或返还算力。');
    reason = textValue(reason, '核对原因', 1000, false);
    if ((await this.getUser(adminId)).role !== 'admin') throw new DomainError(403, 'admin_required', '仅管理员可以核对生成结果。');
    const job = await this.getJobInternal(id);
    const auditId = newId(), timestamp = now();
    const points = job.unlimited_credits ? 0 : 1;
    await this.db.batch([
      ...(points ? [this.statement(`UPDATE users SET credits = credits - ?, reserved_credits = reserved_credits - 1
        WHERE id = (SELECT user_id FROM jobs WHERE id = ? AND status = 'uncertain' AND reservation_active = 1)`, Number(consume), id)] : []),
      this.statement(`INSERT INTO ledger (id,user_id,kind,delta,balance_after,job_id,note,created_at)
        SELECT ?,users.id,?,?,users.credits,jobs.id,?,? FROM users JOIN jobs ON jobs.user_id = users.id
        WHERE jobs.id = ? AND jobs.status = 'uncertain' AND jobs.reservation_active = 1`, newId(), consume ? 'manual_consume' : 'manual_release', -points * Number(consume),
      job.unlimited_credits ? `老师核对（管理员无限算力，不扣点数）：${reason}` : `老师核对：${reason}`, timestamp, id),
      this.statement(`INSERT INTO audit (id,job_id,admin_user_id,consume,reason,created_at)
        SELECT ?,id,?,?,?,? FROM jobs WHERE id = ? AND status = 'uncertain' AND reservation_active = 1`, auditId, adminId, Number(consume), reason, timestamp, id),
      this.statement(`DELETE FROM image_objects WHERE job_id = ? AND completed = 0
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'uncertain' AND reservation_active = 1)`, id, id),
      this.statement(`UPDATE jobs SET status = 'settled', reservation_active = 0, storage_reservation_bytes = 0, updated_at = ?
        WHERE id = ? AND status = 'uncertain' AND reservation_active = 1`, timestamp, id),
    ]);
    if (!await this.first('SELECT id FROM audit WHERE id = ?', auditId)) throw new DomainError(409, 'job_already_resolved', '该任务无需核对或已经完成核对。');
  }
  async markStaleJobsUncertain(cutoffISOString) {
    if (typeof cutoffISOString !== 'string' || !Number.isFinite(Date.parse(cutoffISOString))) throw new DomainError(400, 'invalid_cutoff', '任务核对时间格式不正确。');
    const timestamp = now();
    await this.db.batch([
      this.statement(`INSERT INTO ledger (id,user_id,kind,delta,balance_after,job_id,note,created_at)
        SELECT lower(hex(randomblob(16))),users.id,'freeze',0,users.credits,jobs.id,CASE WHEN ${UNLIMITED_JOB_SQL} THEN ? ELSE ? END,?
        FROM users JOIN jobs ON jobs.user_id = users.id
        WHERE jobs.status IN ('queued','running') AND jobs.reservation_active = 1 AND jobs.updated_at < ?`, '管理员任务等待时间过长，结果待核对，无需预留点数', '任务等待时间过长，保留预留的1点算力等待老师核对', timestamp, cutoffISOString),
      this.statement(`UPDATE jobs SET status = 'uncertain', error_message = ?, updated_at = ?
        WHERE status IN ('queued','running') AND reservation_active = 1 AND updated_at < ?`, '任务等待时间过长，结果待老师核对，请勿重复生成。', timestamp, cutoffISOString),
    ]);
  }

  async listArtworks(userId) { return (await this.all('SELECT * FROM artworks WHERE user_id = ? ORDER BY created_at DESC, rowid DESC', userId)).map(artworkRecord); }
  async getArtwork(userId, id) { return artworkRecord(await this.first('SELECT * FROM artworks WHERE id = ? AND user_id = ?', id, userId)); }
  async getArtworkForAdmin(adminId, id) {
    if ((await this.getUser(adminId)).role !== 'admin') throw new DomainError(403, 'admin_required', '仅管理员可以审核其他学员的作品。');
    return artworkRecord(await this.first('SELECT * FROM artworks WHERE id = ?', id));
  }
  async updateArtwork(userId, id, reflection, description) {
    reflection = textValue(reflection, '作品反思', 5000);
    description = textValue(description, '作品说明', 5000);
    const result = await this.statement('UPDATE artworks SET reflection = ?, description = ? WHERE id = ? AND user_id = ?', reflection, description, id, userId).run();
    if (!result.meta.changes) throw new DomainError(404, 'not_found', '作品不存在。');
    return this.getArtwork(userId, id);
  }
  async ledger(userId) { return this.all('SELECT id,kind,delta,balance_after,job_id,note,created_at FROM ledger WHERE user_id = ? ORDER BY rowid DESC', userId); }

  async getSettings() {
    const row = await this.first("SELECT value_json FROM settings WHERE key = 'generation-settings'");
    return row ? JSON.parse(row.value_json) : null;
  }
  async saveSettings(config) {
    const allowed = new Set(['model', 'base_url', 'watermark', 'quality', 'encrypted_key']);
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !allowed.has(key))
      || (config.encrypted_key != null && (typeof config.encrypted_key !== 'object' || Array.isArray(config.encrypted_key)))) throw new DomainError(400, 'invalid_settings', '只允许保存受保护的绘图配置。');
    const encoded = jsonObject(config, '绘图配置', 32768);
    await this.statement(`INSERT INTO settings (key,value_json,updated_at) VALUES ('generation-settings',?,?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, encoded, now()).run();
  }
  async checkRateLimit(key, limit = 60, period = 60) {
    key = textValue(key, '限流标识', 200, false);
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(period) || period < 1 || period > 86400) throw new DomainError(400, 'invalid_rate_limit', '访问频率配置不正确。');
    const timestamp = Math.floor(Date.now() / 1000);
    const row = await this.statement(`INSERT INTO rate_limits (key,count,resets_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count = CASE WHEN resets_at <= ? THEN 1 ELSE count + 1 END,
        resets_at = CASE WHEN resets_at <= ? THEN excluded.resets_at ELSE resets_at END RETURNING count`, key, timestamp + period, timestamp, timestamp).first();
    if (row.count > limit) throw new DomainError(429, 'rate_limited', '操作较频繁，请稍后再试。');
  }
  async cleanupRateLimits() {
    const timestamp = Math.floor(Date.now() / 1000);
    await this.db.batch([
      this.statement('DELETE FROM rate_limits WHERE resets_at < ?', timestamp),
      this.statement('DELETE FROM sessions WHERE expires_at <= ?', timestamp),
    ]);
  }
}
