import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// 测试也走真实管理员发码流程，不能为旧用例跳过学生授权校验。
export async function createTestAdmin(store) {
  const existing = await store.first("SELECT id FROM users WHERE role = 'admin'");
  return existing ? store.getUser(existing.id) : store.createUser({ name: '测试夹具管理员', phone: '19999999999', region: '', school: '', grade: '' }, 'test-admin-hash', 'admin');
}
export async function createAuthorizedTestUser(store, profile, passwordHash = 'test-password-hash') {
  const admin = await createTestAdmin(store);
  const [{ code }] = await store.createAuthorizationCodes(admin.id);
  return store.createUser(profile, passwordHash, 'student', code);
}

// 使用真实 SQLite 验证 SQL 和原子 batch，不引入测试依赖；正式 D1 由平台提供。
export function createTestD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  function prepare(query) {
    const statement = sqlite.prepare(query);
    const make = values => ({
      bind: (...parameters) => make(parameters),
      first: async column => {
        const row = statement.get(...values);
        return row ? (column ? row[column] : { ...row }) : null;
      },
      all: async () => ({ success: true, results: statement.all(...values).map(row => ({ ...row })), meta: {} }),
      run: async () => {
        if (/\bRETURNING\b/i.test(query)) {
          const results = statement.all(...values).map(row => ({ ...row }));
          return { success: true, results, meta: { changes: results.length } };
        }
        const result = statement.run(...values);
        return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      _execute: () => {
        const result = statement.run(...values);
        return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
    });
    return make([]);
  }
  return {
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement._execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(query) { sqlite.exec(query); return { count: 1, duration: 0 }; },
    close() { sqlite.close(); },
  };
}
