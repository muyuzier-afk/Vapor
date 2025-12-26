/**
 * KV 存储封装层
 * 提供类型安全的 KV 操作接口
 */

/**
 * KV 键前缀定义
 */
export const KV_PREFIX = {
  USER: 'user:',           // user:{uid} -> UserData
  API_KEY: 'apikey:',      // apikey:{key} -> ApiKeyData
  SESSION: 'session:',     // session:{sid} -> SessionData
  ORDER: 'order:',         // order:{trade_no} -> OrderData
  USAGE: 'usage:',         // usage:{uid}:{YYYYMMDD} -> UsageData
  MODEL: 'model:',         // model:{model_id} -> ModelConfig
  CHANNEL: 'channel:',     // channel:{channel_id} -> ChannelConfig
  CONFIG: 'config:',       // config:{key} -> any
};

/**
 * 创建 KV 操作实例
 * @param {KVNamespace} kv - EdgeOne KV 命名空间
 * @param {Object} env - 环境变量（可选，用于读取配置）
 */
export function createKVClient(kv, env = {}) {
  return {
    // 保存 env 引用
    _env: env,
    // ============ 通用操作 ============

    /**
     * 获取 JSON 数据
     */
    async get(key) {
      const data = await kv.get(key, 'json');
      return data;
    },

    /**
     * 设置 JSON 数据
     */
    async set(key, value, options = {}) {
      await kv.put(key, JSON.stringify(value), options);
    },

    /**
     * 删除数据
     */
    async delete(key) {
      await kv.delete(key);
    },

    /**
     * 列出指定前缀的所有键
     */
    async list(prefix, limit = 100) {
      const result = await kv.list({ prefix, limit });
      return result.keys;
    },

    // ============ 用户操作 ============

    /**
     * 获取用户数据
     * @param {string} uid - 用户 ID
     */
    async getUser(uid) {
      return await this.get(`${KV_PREFIX.USER}${uid}`);
    },

    /**
     * 保存用户数据
     * @param {string} uid - 用户 ID
     * @param {object} data - 用户数据
     */
    async setUser(uid, data) {
      await this.set(`${KV_PREFIX.USER}${uid}`, {
        ...data,
        updated_at: Date.now(),
      });
    },

    /**
     * 创建或更新用户（OAuth 登录后调用）
     */
    async upsertUser(uid, oauthData) {
      const existing = await this.getUser(uid);
      const now = Date.now();

      const userData = {
        uid,
        username: oauthData.username,
        avatar: oauthData.avatar_url || '',
        email: oauthData.email || '',
        balance: existing?.balance ?? 0,
        total_consumed: existing?.total_consumed ?? 0,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        is_blocked: existing?.is_blocked ?? false,
      };

      await this.setUser(uid, userData);
      return userData;
    },

    /**
     * 更新用户余额（原子操作模拟）
     * 注意：KV 不支持真正的原子操作，高并发场景需要额外处理
     */
    async updateBalance(uid, delta) {
      const user = await this.getUser(uid);
      if (!user) {
        throw new Error('用户不存在');
      }

      const newBalance = user.balance + delta;
      if (newBalance < 0) {
        throw new Error('余额不足');
      }

      user.balance = newBalance;
      if (delta < 0) {
        user.total_consumed = (user.total_consumed || 0) + Math.abs(delta);
      }

      await this.setUser(uid, user);
      return user;
    },

    // ============ Session 操作 ============

    /**
     * 创建 Session
     */
    async createSession(uid, expiresIn = 7 * 24 * 60 * 60 * 1000) {
      const sid = crypto.randomUUID();
      const expiresAt = Date.now() + expiresIn;

      await this.set(`${KV_PREFIX.SESSION}${sid}`, {
        uid,
        created_at: Date.now(),
        expires_at: expiresAt,
      }, {
        expirationTtl: Math.floor(expiresIn / 1000),
      });

      return { sid, expiresAt };
    },

    /**
     * 获取 Session
     */
    async getSession(sid) {
      const session = await this.get(`${KV_PREFIX.SESSION}${sid}`);
      if (!session) return null;

      if (Date.now() > session.expires_at) {
        await this.delete(`${KV_PREFIX.SESSION}${sid}`);
        return null;
      }

      return session;
    },

    /**
     * 删除 Session
     */
    async deleteSession(sid) {
      await this.delete(`${KV_PREFIX.SESSION}${sid}`);
    },

    // ============ API Key 操作 ============

    /**
     * 生成 API Key
     */
    async createApiKey(uid, name = 'default') {
      const key = `sk-${crypto.randomUUID().replace(/-/g, '')}`;
      const now = Date.now();

      await this.set(`${KV_PREFIX.API_KEY}${key}`, {
        key,
        uid,
        name,
        created_at: now,
        last_used: null,
        enabled: true,
      });

      return key;
    },

    /**
     * 获取 API Key 数据
     */
    async getApiKey(key) {
      return await this.get(`${KV_PREFIX.API_KEY}${key}`);
    },

    /**
     * 验证 API Key 并返回用户
     */
    async validateApiKey(key) {
      const keyData = await this.getApiKey(key);
      if (!keyData || !keyData.enabled) {
        return null;
      }

      // 更新最后使用时间
      keyData.last_used = Date.now();
      await this.set(`${KV_PREFIX.API_KEY}${key}`, keyData);

      // 获取用户数据
      const user = await this.getUser(keyData.uid);
      if (!user || user.is_blocked) {
        return null;
      }

      return { keyData, user };
    },

    /**
     * 获取用户的所有 API Key
     */
    async listUserApiKeys(uid) {
      const keys = await this.list(KV_PREFIX.API_KEY);
      const userKeys = [];

      for (const { name } of keys) {
        const keyData = await this.get(name);
        if (keyData && keyData.uid === uid) {
          // 返回时隐藏完整 key
          userKeys.push({
            ...keyData,
            key: keyData.key.slice(0, 8) + '...' + keyData.key.slice(-4),
            full_key: keyData.key,
          });
        }
      }

      return userKeys;
    },

    /**
     * 删除 API Key
     */
    async deleteApiKey(key, uid) {
      const keyData = await this.getApiKey(key);
      if (!keyData || keyData.uid !== uid) {
        throw new Error('API Key 不存在或无权限');
      }
      await this.delete(`${KV_PREFIX.API_KEY}${key}`);
    },

    // ============ 订单操作 ============

    /**
     * 创建订单
     */
    async createOrder(uid, money, outTradeNo) {
      const tradeNo = outTradeNo || `V${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();

      await this.set(`${KV_PREFIX.ORDER}${tradeNo}`, {
        trade_no: tradeNo,
        uid,
        money,
        status: 0, // 0=待支付, 1=已支付
        created_at: now,
        paid_at: null,
      });

      return tradeNo;
    },

    /**
     * 获取订单
     */
    async getOrder(tradeNo) {
      return await this.get(`${KV_PREFIX.ORDER}${tradeNo}`);
    },

    /**
     * 完成订单（支付成功回调）
     */
    async completeOrder(tradeNo) {
      const order = await this.getOrder(tradeNo);
      if (!order) {
        throw new Error('订单不存在');
      }
      if (order.status === 1) {
        return order; // 已处理，幂等返回
      }

      order.status = 1;
      order.paid_at = Date.now();
      await this.set(`${KV_PREFIX.ORDER}${tradeNo}`, order);

      // 增加用户余额
      await this.updateBalance(order.uid, order.money);

      return order;
    },

    /**
     * 获取用户订单列表
     */
    async listUserOrders(uid, limit = 50) {
      const keys = await this.list(KV_PREFIX.ORDER, 500);
      const orders = [];

      for (const { name } of keys) {
        const order = await this.get(name);
        if (order && order.uid === uid) {
          orders.push(order);
        }
        if (orders.length >= limit) break;
      }

      return orders.sort((a, b) => b.created_at - a.created_at);
    },

    // ============ 用量统计操作 ============

    /**
     * 记录用量
     */
    async recordUsage(uid, modelId, inputTokens, outputTokens, cost) {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const key = `${KV_PREFIX.USAGE}${uid}:${today}`;

      const existing = await this.get(key) || {
        uid,
        date: today,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
        models: {},
      };

      existing.requests += 1;
      existing.input_tokens += inputTokens;
      existing.output_tokens += outputTokens;
      existing.cost += cost;

      // 按模型统计
      if (!existing.models[modelId]) {
        existing.models[modelId] = { requests: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
      }
      existing.models[modelId].requests += 1;
      existing.models[modelId].input_tokens += inputTokens;
      existing.models[modelId].output_tokens += outputTokens;
      existing.models[modelId].cost += cost;

      await this.set(key, existing, {
        expirationTtl: 90 * 24 * 60 * 60, // 保留 90 天
      });

      return existing;
    },

    /**
     * 获取用户用量统计
     */
    async getUserUsage(uid, days = 30) {
      const usage = [];
      const now = new Date();

      for (let i = 0; i < days; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');

        const data = await this.get(`${KV_PREFIX.USAGE}${uid}:${dateStr}`);
        if (data) {
          usage.push(data);
        }
      }

      return usage;
    },

    // ============ 模型配置操作 ============

    /**
     * 获取模型配置
     */
    async getModel(modelId) {
      return await this.get(`${KV_PREFIX.MODEL}${modelId}`);
    },

    /**
     * 保存模型配置
     */
    async setModel(modelId, config) {
      await this.set(`${KV_PREFIX.MODEL}${modelId}`, {
        ...config,
        model_id: modelId,
        updated_at: Date.now(),
      });
    },

    /**
     * 获取所有模型配置
     */
    async listModels() {
      const keys = await this.list(KV_PREFIX.MODEL);
      const models = [];

      for (const { name } of keys) {
        const model = await this.get(name);
        if (model) {
          models.push(model);
        }
      }

      return models;
    },

    /**
     * 删除模型配置
     */
    async deleteModel(modelId) {
      await this.delete(`${KV_PREFIX.MODEL}${modelId}`);
    },

    // ============ 渠道配置操作 ============

    /**
     * 获取渠道配置
     */
    async getChannel(channelId) {
      return await this.get(`${KV_PREFIX.CHANNEL}${channelId}`);
    },

    /**
     * 保存渠道配置
     */
    async setChannel(channelId, config) {
      await this.set(`${KV_PREFIX.CHANNEL}${channelId}`, {
        ...config,
        channel_id: channelId,
        updated_at: Date.now(),
      });
    },

    /**
     * 获取所有渠道配置
     */
    async listChannels() {
      const keys = await this.list(KV_PREFIX.CHANNEL);
      const channels = [];

      for (const { name } of keys) {
        const channel = await this.get(name);
        if (channel) {
          channels.push(channel);
        }
      }

      return channels;
    },

    // ============ 系统配置操作 ============

    /**
     * 获取系统配置
     */
    async getConfig(key) {
      return await this.get(`${KV_PREFIX.CONFIG}${key}`);
    },

    /**
     * 保存系统配置
     */
    async setConfig(key, value) {
      await this.set(`${KV_PREFIX.CONFIG}${key}`, value);
    },

    // ============ 管理员操作 ============

    /**
     * 获取管理员列表
     * 优先从环境变量读取（逗号分隔），回退到 KV
     */
    async getAdminList() {
      // 优先从环境变量读取
      if (this._env.ADMIN_LIST) {
        return this._env.ADMIN_LIST.split(',').map(s => s.trim()).filter(Boolean);
      }
      const list = await this.getConfig('admin_list');
      return list || [];
    },

    /**
     * 检查用户是否是管理员
     */
    async isAdmin(uid) {
      const admins = await this.getAdminList();
      return admins.includes(uid);
    },

    /**
     * 添加管理员
     */
    async addAdmin(uid) {
      const admins = await this.getAdminList();
      if (!admins.includes(uid)) {
        admins.push(uid);
        await this.setConfig('admin_list', admins);
      }
    },

    /**
     * 移除管理员
     */
    async removeAdmin(uid) {
      const admins = await this.getAdminList();
      const index = admins.indexOf(uid);
      if (index > -1) {
        admins.splice(index, 1);
        await this.setConfig('admin_list', admins);
      }
    },

    /**
     * 获取用户总数
     */
    async getUserCount() {
      const keys = await this.list(KV_PREFIX.USER, 1);
      return keys.length;
    },

    // ============ OAuth 配置操作 ============

    /**
     * 获取 OAuth 配置
     * 优先从环境变量读取，回退到 KV
     * @returns {Promise<{client_id: string, client_secret: string, redirect_uri: string, frontend_url: string} | null>}
     */
    async getOAuthConfig() {
      // 优先从环境变量读取
      if (this._env.OAUTH_CLIENT_ID) {
        return {
          client_id: this._env.OAUTH_CLIENT_ID,
          client_secret: this._env.OAUTH_CLIENT_SECRET || '',
          redirect_uri: this._env.OAUTH_REDIRECT_URI || '',
          frontend_url: this._env.OAUTH_FRONTEND_URL || '/',
        };
      }
      return await this.getConfig('oauth');
    },

    /**
     * 保存 OAuth 配置
     */
    async setOAuthConfig(config) {
      await this.setConfig('oauth', {
        client_id: config.client_id || '',
        client_secret: config.client_secret || '',
        redirect_uri: config.redirect_uri || '',
        frontend_url: config.frontend_url || '/',
        updated_at: Date.now(),
      });
    },

    /**
     * 获取 JWT 密钥
     * 优先从环境变量读取，回退到 KV
     */
    async getJWTSecret() {
      // 优先从环境变量读取
      if (this._env.JWT_SECRET) {
        return this._env.JWT_SECRET;
      }
      const secret = await this.getConfig('jwt_secret');
      return secret;
    },

    /**
     * 保存 JWT 密钥
     */
    async setJWTSecret(secret) {
      await this.setConfig('jwt_secret', secret);
    },

    // ============ 支付配置操作 ============

    /**
     * 获取 EPay 支付配置
     * 优先从环境变量读取，回退到 KV
     * @returns {Promise<{pid: string, key: string, notify_url: string, return_url: string} | null>}
     */
    async getEPayConfig() {
      // 优先从环境变量读取
      if (this._env.EPAY_PID) {
        return {
          pid: this._env.EPAY_PID,
          key: this._env.EPAY_KEY || '',
          notify_url: this._env.EPAY_NOTIFY_URL || '',
          return_url: this._env.EPAY_RETURN_URL || '',
        };
      }
      return await this.getConfig('epay');
    },

    /**
     * 保存 EPay 支付配置
     */
    async setEPayConfig(config) {
      await this.setConfig('epay', {
        pid: config.pid || '',
        key: config.key || '',
        notify_url: config.notify_url || '',
        return_url: config.return_url || '',
        updated_at: Date.now(),
      });
    },
  };
}
