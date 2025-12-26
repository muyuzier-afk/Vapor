/**
 * 管理员后台 API
 * /api/admin/*
 */

import { createKVClient } from '../../../src/lib/kv.js';
import { jsonResponse, errorResponse } from '../../../src/lib/utils.js';

/**
 * 验证管理员权限
 */
async function requireAdmin(ctx, env) {
  if (!ctx.user) {
    return errorResponse('未登录', 401);
  }

  const kv = createKVClient(env.KV);
  const isAdmin = await kv.isAdmin(ctx.user.uid);

  if (!isAdmin) {
    return errorResponse('无管理员权限', 403);
  }

  return null;
}

// ============ 模型管理 ============

/**
 * 获取所有模型
 * GET /api/admin/models
 */
async function handleListModels(request, env, ctx) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const kv = createKVClient(env.KV);
  const models = await kv.listModels();

  return jsonResponse({ models });
}

/**
 * 创建/更新模型
 * POST /api/admin/models
 */
async function handleSaveModel(request, env, ctx) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const { model_id, name, provider, channel_id, upstream_model, input_price, output_price, enabled } = body;

  if (!model_id || !channel_id) {
    return errorResponse('缺少必要参数: model_id, channel_id', 400);
  }

  const kv = createKVClient(env.KV);

  await kv.setModel(model_id, {
    name: name || model_id,
    provider: provider || 'openai',
    channel_id,
    upstream_model: upstream_model || model_id,
    input_price: parseFloat(input_price) || 0,
    output_price: parseFloat(output_price) || 0,
    enabled: enabled !== false,
    created_at: Date.now(),
  });

  return jsonResponse({ success: true, model_id });
}

/**
 * 删除模型
 * DELETE /api/admin/models/:model_id
 */
async function handleDeleteModel(request, env, ctx, modelId) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const kv = createKVClient(env.KV);
  await kv.deleteModel(modelId);

  return jsonResponse({ success: true });
}

// ============ 渠道管理 ============

/**
 * 获取所有渠道
 * GET /api/admin/channels
 */
async function handleListChannels(request, env, ctx) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const kv = createKVClient(env.KV);
  const channels = await kv.listChannels();

  // 隐藏 API Key
  const safeChannels = channels.map(c => ({
    ...c,
    api_key: c.api_key ? '***' + c.api_key.slice(-4) : '',
  }));

  return jsonResponse({ channels: safeChannels });
}

/**
 * 创建/更新渠道
 * POST /api/admin/channels
 */
async function handleSaveChannel(request, env, ctx) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const { channel_id, name, provider, base_url, api_key, version, headers, enabled } = body;

  if (!channel_id || !provider || !api_key) {
    return errorResponse('缺少必要参数: channel_id, provider, api_key', 400);
  }

  const kv = createKVClient(env.KV);

  // 如果 api_key 是 *** 开头，说明没有修改，保留原值
  let finalApiKey = api_key;
  if (api_key.startsWith('***')) {
    const existing = await kv.getChannel(channel_id);
    if (existing) {
      finalApiKey = existing.api_key;
    }
  }

  await kv.setChannel(channel_id, {
    name: name || channel_id,
    provider,
    base_url: base_url || '',
    api_key: finalApiKey,
    version: version || '',
    headers: headers || {},
    enabled: enabled !== false,
    created_at: Date.now(),
  });

  return jsonResponse({ success: true, channel_id });
}

/**
 * 删除渠道
 * DELETE /api/admin/channels/:channel_id
 */
async function handleDeleteChannel(request, env, ctx, channelId) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const kv = createKVClient(env.KV);
  await kv.delete(`channel:${channelId}`);

  return jsonResponse({ success: true });
}

// ============ 用户管理 ============

/**
 * 获取用户列表
 * GET /api/admin/users
 */
async function handleListUsers(request, env, ctx) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const kv = createKVClient(env.KV);
  const keys = await kv.list('user:', 500);
  const users = [];

  for (const { name } of keys) {
    const user = await kv.get(name);
    if (user) {
      users.push(user);
    }
  }

  // 按创建时间倒序
  users.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  return jsonResponse({ users });
}

/**
 * 更新用户（封禁/解封、调整余额等）
 * PUT /api/admin/users/:uid
 */
async function handleUpdateUser(request, env, ctx, uid) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const kv = createKVClient(env.KV);

  const user = await kv.getUser(uid);
  if (!user) {
    return errorResponse('用户不存在', 404);
  }

  // 允许修改的字段
  if (body.is_blocked !== undefined) {
    user.is_blocked = Boolean(body.is_blocked);
  }
  if (body.balance !== undefined) {
    user.balance = parseFloat(body.balance) || 0;
  }

  await kv.setUser(uid, user);

  return jsonResponse({ success: true, user });
}

// ============ 统计数据 ============

/**
 * 获取系统统计
 * GET /api/admin/stats
 */
async function handleGetStats(request, env, ctx) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const kv = createKVClient(env.KV);

  // 统计用户数
  const userKeys = await kv.list('user:', 1000);
  const totalUsers = userKeys.length;

  // 统计模型数
  const modelKeys = await kv.list('model:', 100);
  const totalModels = modelKeys.length;

  // 统计渠道数
  const channelKeys = await kv.list('channel:', 100);
  const totalChannels = channelKeys.length;

  // 今日用量统计
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const usageKeys = await kv.list(`usage:`, 1000);

  let todayRequests = 0;
  let todayTokens = 0;
  let todayCost = 0;

  for (const { name } of usageKeys) {
    if (name.includes(`:${today}`)) {
      const usage = await kv.get(name);
      if (usage) {
        todayRequests += usage.requests || 0;
        todayTokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
        todayCost += usage.cost || 0;
      }
    }
  }

  return jsonResponse({
    stats: {
      total_users: totalUsers,
      total_models: totalModels,
      total_channels: totalChannels,
      today_requests: todayRequests,
      today_tokens: todayTokens,
      today_cost: todayCost,
    },
  });
}

// ============ 系统配置 ============

/**
 * 获取系统配置
 * GET /api/admin/settings
 */
async function handleGetSettings(request, env, ctx) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const kv = createKVClient(env.KV);

  const oauth = await kv.getOAuthConfig();
  const jwtSecret = await kv.getJWTSecret();
  const epay = await kv.getEPayConfig();

  return jsonResponse({
    oauth: oauth ? {
      client_id: oauth.client_id || '',
      client_secret: oauth.client_secret ? '***' + oauth.client_secret.slice(-4) : '',
      redirect_uri: oauth.redirect_uri || '',
      frontend_url: oauth.frontend_url || '/',
    } : null,
    jwt_configured: !!jwtSecret,
    epay: epay ? {
      pid: epay.pid || '',
      key: epay.key ? '***' + epay.key.slice(-4) : '',
      notify_url: epay.notify_url || '',
      return_url: epay.return_url || '',
    } : null,
  });
}

/**
 * 保存系统配置
 * POST /api/admin/settings
 */
async function handleSaveSettings(request, env, ctx) {
  const error = await requireAdmin(ctx, env);
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const kv = createKVClient(env.KV);

  // 保存 OAuth 配置
  if (body.oauth) {
    const existingOAuth = await kv.getOAuthConfig();

    // 如果 client_secret 是 *** 开头，保留原值
    let clientSecret = body.oauth.client_secret;
    if (clientSecret && clientSecret.startsWith('***') && existingOAuth) {
      clientSecret = existingOAuth.client_secret;
    }

    await kv.setOAuthConfig({
      client_id: body.oauth.client_id || '',
      client_secret: clientSecret || '',
      redirect_uri: body.oauth.redirect_uri || '',
      frontend_url: body.oauth.frontend_url || '/',
    });
  }

  // 保存 JWT 密钥（仅当提供了新值时）
  if (body.jwt_secret && !body.jwt_secret.startsWith('***')) {
    await kv.setJWTSecret(body.jwt_secret);
  }

  // 保存 EPay 支付配置
  if (body.epay) {
    const existingEPay = await kv.getEPayConfig();

    // 如果 key 是 *** 开头，保留原值
    let epayKey = body.epay.key;
    if (epayKey && epayKey.startsWith('***') && existingEPay) {
      epayKey = existingEPay.key;
    }

    await kv.setEPayConfig({
      pid: body.epay.pid || '',
      key: epayKey || '',
      notify_url: body.epay.notify_url || '',
      return_url: body.epay.return_url || '',
    });
  }

  return jsonResponse({ success: true });
}

/**
 * 路由处理器
 */
export async function handleAdmin(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/admin', '');
  const method = request.method;

  // 模型管理
  if (path === '/models' && method === 'GET') {
    return handleListModels(request, env, ctx);
  }
  if (path === '/models' && method === 'POST') {
    return handleSaveModel(request, env, ctx);
  }
  if (path.startsWith('/models/') && method === 'DELETE') {
    const modelId = decodeURIComponent(path.replace('/models/', ''));
    return handleDeleteModel(request, env, ctx, modelId);
  }

  // 渠道管理
  if (path === '/channels' && method === 'GET') {
    return handleListChannels(request, env, ctx);
  }
  if (path === '/channels' && method === 'POST') {
    return handleSaveChannel(request, env, ctx);
  }
  if (path.startsWith('/channels/') && method === 'DELETE') {
    const channelId = decodeURIComponent(path.replace('/channels/', ''));
    return handleDeleteChannel(request, env, ctx, channelId);
  }

  // 用户管理
  if (path === '/users' && method === 'GET') {
    return handleListUsers(request, env, ctx);
  }
  if (path.startsWith('/users/') && method === 'PUT') {
    const uid = path.replace('/users/', '');
    return handleUpdateUser(request, env, ctx, uid);
  }

  // 统计数据
  if (path === '/stats' && method === 'GET') {
    return handleGetStats(request, env, ctx);
  }

  // 系统配置
  if (path === '/settings' && method === 'GET') {
    return handleGetSettings(request, env, ctx);
  }
  if (path === '/settings' && method === 'POST') {
    return handleSaveSettings(request, env, ctx);
  }

  return errorResponse('Not found', 404);
}
