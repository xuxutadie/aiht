import { Buffer } from 'node:buffer';
import { DomainError, MAX_IMAGE_BYTES, IMAGE_CHUNK_BYTES, now } from './contracts.js';

const MIME_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const failure = () => new DomainError(503, 'image_storage_unavailable', '图片保存暂未完成，请联系老师核对，不要重复生图。');

function validKey(key) {
  return typeof key === 'string' && /^artworks\/[a-f0-9]{32}\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(key);
}

// 图片只经本人的作品接口读取。D1每行最多1MiB文本，不依赖R2或公开图片桶。
export class D1ImageStorage {
  constructor(db) { this.db = db; }

  async put(key, data, options = {}) {
    const metadata = options.customMetadata || {};
    const mime = options.httpMetadata?.contentType;
    const extension = MIME_EXTENSIONS[mime];
    if (!validKey(key) || !(data instanceof Uint8Array) || !data.length || data.length > MAX_IMAGE_BYTES
      || !extension || !key.endsWith(`/${metadata.artwork_id}${extension}`)
      || !/^[a-f0-9]{32}$/.test(metadata.job_id || '')) throw failure();
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex');
    const previous = await this.db.prepare('SELECT * FROM image_objects WHERE object_key = ?').bind(key).first();
    if (previous) {
      if (previous.completed && previous.sha256 === digest && previous.byte_size === data.length) return { key, etag: digest };
      throw failure();
    }
    const count = Math.ceil(data.length / IMAGE_CHUNK_BYTES);
    const encodedSize = Math.ceil(data.length / 3) * 4;
    // 从最坏图片预留转为实际图片预算，与pending元数据一起原子提交。
    const created = await this.db.batch([
      this.db.prepare(`INSERT INTO image_objects
        (object_key,job_id,mime,byte_size,encoded_size,chunk_count,metadata_json,sha256,completed,created_at)
        SELECT ?,id,?,?,?,?,?,?,0,? FROM jobs WHERE id = ? AND status = 'running'
          AND reservation_active = 1 AND storage_reservation_bytes >= ?
          AND ? = 'artworks/' || user_id || '/' || ? || ?`)
        .bind(key, mime, data.length, encodedSize, count, JSON.stringify(metadata), digest, now(), metadata.job_id,
          encodedSize, key, metadata.artwork_id, extension),
      this.db.prepare(`UPDATE jobs SET storage_reservation_bytes = 0 WHERE id = ?
        AND EXISTS (SELECT 1 FROM image_objects WHERE object_key = ? AND job_id = jobs.id AND sha256 = ?)`)
        .bind(metadata.job_id, key, digest),
    ]);
    if (created[0].meta.changes !== 1) throw failure();
    // 每次仅编码一片，避免20MiB整图的base64、JSON和数字数组同时占据内存。
    for (let index = 0; index < count; index += 1) {
      const start = index * IMAGE_CHUNK_BYTES;
      const length = Math.min(IMAGE_CHUNK_BYTES, data.length - start);
      const encoded = Buffer.from(data.buffer, data.byteOffset + start, length).toString('base64');
      const result = await this.db.prepare(`INSERT INTO image_chunks (object_key,chunk_index,body_base64)
        SELECT object_key,?,? FROM image_objects WHERE object_key = ? AND completed = 0
          AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'running')`)
        .bind(index, encoded, key, metadata.job_id).run();
      if (result.meta.changes !== 1) throw failure();
    }
    const completed = await this.db.prepare(`UPDATE image_objects SET completed = 1 WHERE object_key = ? AND completed = 0
      AND chunk_count = (SELECT COUNT(*) FROM image_chunks WHERE object_key = ?)
      AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'running')`).bind(key, key, metadata.job_id).run();
    if (completed.meta.changes !== 1) throw failure();
    return { key, etag: digest };
  }

  async get(key) {
    if (!validKey(key)) return null;
    const row = await this.db.prepare('SELECT * FROM image_objects WHERE object_key = ? AND completed = 1').bind(key).first();
    if (!row) return null;
    if (!MIME_EXTENSIONS[row.mime] || !Number.isSafeInteger(row.byte_size) || row.byte_size < 1 || row.byte_size > MAX_IMAGE_BYTES
      || row.chunk_count !== Math.ceil(row.byte_size / IMAGE_CHUNK_BYTES)) throw failure();
    let index = 0;
    const db = this.db;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (index >= row.chunk_count) { controller.close(); return; }
          const part = await db.prepare('SELECT body_base64 FROM image_chunks WHERE object_key = ? AND chunk_index = ?').bind(key, index).first();
          if (!part || typeof part.body_base64 !== 'string' || part.body_base64.length > 1024 * 1024) throw failure();
          const data = Buffer.from(part.body_base64, 'base64');
          const expected = Math.min(IMAGE_CHUNK_BYTES, row.byte_size - index * IMAGE_CHUNK_BYTES);
          if (data.length !== expected) throw failure();
          index += 1;
          controller.enqueue(data);
        } catch (error) { controller.error(error); }
      },
    });
    const httpMetadata = { contentType: row.mime };
    return {
      key, body, size: row.byte_size, etag: row.sha256, httpMetadata,
      customMetadata: JSON.parse(row.metadata_json),
      writeHttpMetadata(headers) { headers.set('Content-Type', row.mime); },
      async arrayBuffer() { return new Response(body).arrayBuffer(); },
    };
  }

  async delete(key) {
    if (validKey(key)) await this.db.prepare('DELETE FROM image_objects WHERE object_key = ?').bind(key).run();
  }
}

export const getImageStorage = env => env.IMAGE_STORAGE || new D1ImageStorage(env.DB);
