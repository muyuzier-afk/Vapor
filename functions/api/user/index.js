/**
 * 用户相关 API
 * /api/user/*
 */

import { createKVClient } from '../../../src/lib/kv.js';
import { jsonResponse, errorResponse } from '../../../src/lib/utils.js';

/**
 * 获取用户 API Keys
 * GET /api/user/keys
 */
async function handleListKeys(request, env, ctx) {
  if (!ctx.user) {
    return errorResponse('未登录', 401);
  }

  const kv = createKVClient(env.KV);
  const keys = await kv.listUserApiKeys(ctx.user.uid);

  // 返回时隐藏完整 key
  const safeKeys = keys.map(k => ({
    key: k.key,
    name: k.name,
    created_at: k.created_at,
    last_used: k.last_used,
    enabled: k.enabled,
  }));

  return jsonResponse({ keys: safeKeys });
}

/**
 * 创建 API Key
 * POST /api/user/keys
 */
async function handleCreateKey(request, env, ctx) {
  if (!ctx.user) {
    return errorResponse('未登录', 401);
  }

  const body = await request.json().catch(() => ({}));
  const name = body.name || 'default';

  const kv = createKVClient(env.KV);
  const key = await kv.createApiKey(ctx.user.uid, name);

  return jsonResponse({
    key,
    message: '请妥善保管此密钥，它只会显示一次',
  });
}

/**
 * 删除 API Key
 * DELETE /api/user/keys/:key
 */
async function handleDeleteKey(request, env, ctx, keyToDelete) {
  if (!ctx.user) {
    return errorResponse('未登录', 401);
  }

  const kv = createKVClient(env.KV);

  try {
    await kv.deleteApiKey(keyToDelete, ctx.user.uid);
    return jsonResponse({ success: true });
  } catch (error) {
    return errorResponse(error.message, 400);
  }
}

/**
 * 获取用户用量统计
 * GET /api/user/usage
 */
async function handleGetUsage(request, env, ctx) {
  if (!ctx.user) {
    return errorResponse('未登录', 401);
  }

  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get('days') || '30', 10);

  const kv = createKVClient(env.KV);
  const usage = await kv.getUserUsage(ctx.user.uid, Math.min(days, 90));

  // 汇总统计
  const summary = {
    total_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
  };

  for (const day of usage) {
    summary.total_requests += day.requests;
    summary.total_input_tokens += day.input_tokens;
    summary.total_output_tokens += day.output_tokens;
    summary.total_cost += day.cost;
  }

  return jsonResponse({
    summary,
    daily: usage,
  });
}

/**
 * 获取用户订单列表
 * GET /api/user/orders
 */
async function handleListOrders(request, env, ctx) {
  if (!ctx.user) {
    return errorResponse('未登录', 401);
  }

  const kv = createKVClient(env.KV);
  const orders = await kv.listUserOrders(ctx.user.uid);

  return jsonResponse({ orders });
}

/**
 * 路由处理器
 */
export async function handleUser(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/user', '');
  const method = request.method;

  // /api/user/keys
  if (path === '/keys') {
    if (method === 'GET') {
      return handleListKeys(request, env, ctx);
    }
    if (method === 'POST') {
      return handleCreateKey(request, env, ctx);
    }
    return errorResponse('Method not allowed', 405);
  }

  // /api/user/keys/:key
  if (path.startsWith('/keys/')) {
    const keyToDelete = path.replace('/keys/', '');
    if (method === 'DELETE') {
      return handleDeleteKey(request, env, ctx, keyToDelete);
    }
    return errorResponse('Method not allowed', 405);
  }

  // /api/user/usage
  if (path === '/usage') {
    return handleGetUsage(request, env, ctx);
  }

  // /api/user/orders
  if (path === '/orders') {
    return handleListOrders(request, env, ctx);
  }

  return errorResponse('Not found', 404);
}
