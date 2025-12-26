/**
 * 认证相关 API
 * /api/auth/*
 */

import { createKVClient } from '../../src/lib/kv.js';
import { getAuthorizationUrl, exchangeCodeForToken, getUserInfo, generateState } from '../../src/lib/oauth.js';
import { signJWT, jsonResponse, errorResponse, setCookie } from '../../src/lib/utils.js';

/**
 * 处理 OAuth 登录发起
 * GET /api/auth/login
 */
export async function handleLogin(request, env) {
  const kv = createKVClient(env.KV, env);

  // 从 KV 获取 OAuth 配置
  const oauthConfig = await kv.getOAuthConfig();
  if (!oauthConfig || !oauthConfig.client_id) {
    return errorResponse('OAuth 未配置，请联系管理员', 500);
  }

  const state = generateState();

  // 将 state 存入 KV，用于回调验证
  await kv.set(`oauth_state:${state}`, { created_at: Date.now() }, { expirationTtl: 600 });

  const authUrl = getAuthorizationUrl(
    oauthConfig.client_id,
    oauthConfig.redirect_uri,
    state
  );

  return Response.redirect(authUrl, 302);
}

/**
 * 处理 OAuth 回调
 * GET /api/auth/callback
 */
export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return errorResponse('缺少必要参数', 400);
  }

  const kv = createKVClient(env.KV, env);

  // 验证 state
  const stateData = await kv.get(`oauth_state:${state}`);
  if (!stateData) {
    return errorResponse('State 验证失败或已过期', 401);
  }

  // 删除已使用的 state
  await kv.delete(`oauth_state:${state}`);

  // 从 KV 获取 OAuth 配置
  const oauthConfig = await kv.getOAuthConfig();
  if (!oauthConfig || !oauthConfig.client_id) {
    return errorResponse('OAuth 未配置', 500);
  }

  // 获取 JWT 密钥
  const jwtSecret = await kv.getJWTSecret();
  if (!jwtSecret) {
    return errorResponse('JWT 密钥未配置', 500);
  }

  try {
    // 用授权码换取 access_token
    const tokenData = await exchangeCodeForToken(
      code,
      oauthConfig.client_id,
      oauthConfig.client_secret,
      oauthConfig.redirect_uri
    );

    // 获取用户信息
    const userInfo = await getUserInfo(tokenData.access_token);
    const uid = String(userInfo.id);

    // 检查是否是第一个用户（自动成为管理员）
    const existingUser = await kv.getUser(uid);
    const isFirstUser = !existingUser && (await kv.getUserCount()) === 0;

    // 创建或更新用户
    const user = await kv.upsertUser(uid, {
      username: userInfo.username,
      avatar_url: userInfo.avatar_url,
      email: userInfo.email,
    });

    // 如果是第一个用户，自动设为管理员
    if (isFirstUser) {
      await kv.addAdmin(uid);
    }

    // 创建 Session
    const { sid, expiresAt } = await kv.createSession(user.uid);

    // 生成 JWT
    const token = await signJWT(
      { uid: user.uid, sid },
      jwtSecret,
      7 * 24 * 60 * 60
    );

    // 设置 Cookie 并重定向到首页
    const redirectUrl = oauthConfig.frontend_url || '/';

    return new Response(null, {
      status: 302,
      headers: {
        'Location': redirectUrl,
        'Set-Cookie': setCookie('vapor_token', token, {
          maxAge: 7 * 24 * 60 * 60,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        }),
      },
    });
  } catch (error) {
    console.error('OAuth callback error:', error);
    return errorResponse(`登录失败: ${error.message}`, 500);
  }
}

/**
 * 处理登出
 * POST /api/auth/logout
 */
export async function handleLogout(request, env, ctx) {
  const { user, session } = ctx;

  if (session?.sid) {
    const kv = createKVClient(env.KV, env);
    await kv.deleteSession(session.sid);
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setCookie('vapor_token', '', {
        maxAge: 0,
        path: '/',
      }),
    },
  });
}

/**
 * 获取当前用户信息
 * GET /api/auth/me
 */
export async function handleMe(request, env, ctx) {
  if (!ctx.user) {
    return errorResponse('未登录', 401);
  }

  // 从 KV 检查是否是管理员
  const kv = createKVClient(env.KV, env);
  const isAdmin = await kv.isAdmin(ctx.user.uid);

  return jsonResponse({
    user: {
      uid: ctx.user.uid,
      username: ctx.user.username,
      avatar: ctx.user.avatar,
      balance: ctx.user.balance,
      total_consumed: ctx.user.total_consumed,
      created_at: ctx.user.created_at,
      is_admin: isAdmin,
    },
  });
}

/**
 * 路由处理器
 */
export async function handleAuth(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/auth', '');

  switch (path) {
    case '/login':
      return handleLogin(request, env);

    case '/callback':
      return handleCallback(request, env);

    case '/logout':
      if (request.method !== 'POST') {
        return errorResponse('Method not allowed', 405);
      }
      return handleLogout(request, env, ctx);

    case '/me':
      return handleMe(request, env, ctx);

    default:
      return errorResponse('Not found', 404);
  }
}
