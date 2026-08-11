/**
 * D1模拟KV_STORE适配器，API和原生env.KV_STORE完全一致
 * 替换后业务代码无需改动任何put/get/delete/list逻辑
 */
export class KVAdapter {
  constructor(d1) {
    this.db = d1;
  }

  /**
   * @param {string} key
   * @param {string} value
   * @param {{expirationTtl?: number}} options
   */
  async put(key, value, options = {}) {
    let expireAt = null;
    if (options.expirationTtl && Number(options.expirationTtl) > 0) {
      const now = Math.floor(Date.now() / 1000);
      expireAt = now + Number(options.expirationTtl);
    }
    await this.db.prepare(`
      INSERT OR REPLACE INTO kv_store(key, value, expire_at)
      VALUES (?, ?, ?)
    `).bind(key, value, expireAt).run();
  }

  /**
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async get(key) {
    const now = Math.floor(Date.now() / 1000);
    const row = await this.db.prepare(`
      SELECT value, expire_at FROM kv_store WHERE key = ?
    `).bind(key).first();

    if (!row) return null;
    // 过期自动删并返回null
    if (row.expire_at !== null && Number(row.expire_at) < now) {
      await this.db.prepare(`DELETE FROM kv_store WHERE key = ?`).bind(key).run();
      return null;
    }
    return row.value;
  }

  async delete(key) {
    await this.db.prepare(`DELETE FROM kv_store WHERE key = ?`).bind(key).run();
  }

  /**
   * 对齐KV list({prefix, limit})
   * @param {{prefix?: string, limit?: number}} opts
   */
  async list(opts = {}) {
    const { prefix = "", limit = 100 } = opts;
    let sql = "SELECT key FROM kv_store WHERE 1=1";
    const binds = [];
    if (prefix) {
      sql += " AND key LIKE ?";
      binds.push(`${prefix}%`);
    }
    sql += " ORDER BY key LIMIT ?";
    binds.push(limit);

    const { results } = await this.db.prepare(sql).bind(...binds).all();
    return {
      keys: results.map(item => ({ name: item.key }))
    };
  }
}