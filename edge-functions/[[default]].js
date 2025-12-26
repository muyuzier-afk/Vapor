/**
 * EdgeOne Pages Edge Functions 入口
 * 捕获所有请求并转发到主路由处理器
 */

import { createKVClient } from '../src/lib/kv.js';
import { verifyJWT, getCookie, jsonResponse, errorResponse } from '../src/lib/utils.js';
import { handleAuth } from '../functions/api/auth/index.js';
import { handleUser } from '../functions/api/user/index.js';
import { handlePay } from '../functions/api/pay/index.js';
import { handleAdmin } from '../functions/api/admin/index.js';
import { handleV1 } from '../functions/v1/index.js';

/**
 * 从请求中解析用户身份
 */
async function resolveUser(request, env) {
  // 优先从 Cookie 获取 token
  let token = getCookie(request, 'vapor_token');

  // 其次从 Authorization header 获取（用于 API 调用）
  if (!token) {
    const auth = request.headers.get('Authorization');
    if (auth?.startsWith('Bearer ')) {
      token = auth.slice(7);
    }
  }

  if (!token) {
    return { user: null, session: null };
  }

  // 从 KV 获取 JWT 密钥
  const kv = createKVClient(env.KV, env);
  const jwtSecret = await kv.getJWTSecret();
  if (!jwtSecret) {
    return { user: null, session: null };
  }

  // 验证 JWT
  const payload = await verifyJWT(token, jwtSecret);
  if (!payload) {
    return { user: null, session: null };
  }

  // 验证 Session
  const session = await kv.getSession(payload.sid);
  if (!session) {
    return { user: null, session: null };
  }

  // 获取用户数据
  const user = await kv.getUser(payload.uid);
  if (!user) {
    return { user: null, session: null };
  }

  return { user, session: { ...session, sid: payload.sid } };
}

/**
 * EdgeOne Pages Edge Functions 入口
 * @param {Object} context - EdgeOne context 对象
 * @param {Request} context.request - 客户端请求
 * @param {Object} context.params - 动态路由参数
 * @param {Object} context.env - 环境变量
 * @param {Function} context.waitUntil - 延长事件处理生命周期
 */
export async function onRequest(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // 解析用户身份（对于需要认证的路由）
  const ctx = await resolveUser(request, env);

  // 添加 waitUntil 到 env，供异步任务使用
  env.waitUntil = waitUntil;

  try {
    // API 路由分发
    if (path.startsWith('/api/auth')) {
      return handleAuth(request, env, ctx);
    }

    if (path.startsWith('/api/user')) {
      return handleUser(request, env, ctx);
    }

    if (path.startsWith('/api/pay')) {
      return handlePay(request, env, ctx);
    }

    if (path.startsWith('/api/admin')) {
      return handleAdmin(request, env, ctx);
    }

    // LLM API 路由
    if (path.startsWith('/v1')) {
      return handleV1(request, env);
    }

    // 根路径返回基本信息
    if (path === '/' || path === '') {
      return jsonResponse({
        name: 'Vapor',
        version: '1.0.0',
        description: 'LLM API Gateway',
        endpoints: {
          auth: '/api/auth/*',
          user: '/api/user/*',
          pay: '/api/pay/*',
          admin: '/api/admin/*',
          llm: '/v1/*',
        },
      });
    }

    // 其他路径返回 404（静态资源由 EdgeOne Pages 自动处理）
    return errorResponse('Not Found', 404);
  } catch (error) {
    console.error('Unhandled error:', error);
    return errorResponse(`Internal Server Error: ${error.message}`, 500);
  }
}
