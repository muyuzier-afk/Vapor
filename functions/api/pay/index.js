/**
 * 支付相关 API
 * /api/pay/*
 */

import { createKVClient } from '../../../src/lib/kv.js';
import { createPaymentUrl, handleNotify, queryOrder } from '../../../src/lib/payment.js';
import { jsonResponse, errorResponse } from '../../../src/lib/utils.js';

/**
 * 创建充值订单
 * POST /api/pay/create
 */
async function handleCreateOrder(request, env, ctx) {
  if (!ctx.user) {
    return errorResponse('未登录', 401);
  }

  const body = await request.json().catch(() => ({}));
  const { money } = body;

  // 验证金额
  if (!money || money <= 0 || !/^\d+(\.\d{1,2})?$/.test(String(money))) {
    return errorResponse('金额无效，必须大于0且最多2位小数', 400);
  }

  const kv = createKVClient(env.KV, env);

  // 获取支付配置
  const epayConfig = await kv.getEPayConfig();
  if (!epayConfig || !epayConfig.pid || !epayConfig.key) {
    return errorResponse('支付未配置，请联系管理员', 500);
  }

  // 创建订单记录
  const tradeNo = await kv.createOrder(ctx.user.uid, parseFloat(money));

  // 生成支付跳转 URL
  const payUrl = createPaymentUrl({
    pid: epayConfig.pid,
    key: epayConfig.key,
    outTradeNo: tradeNo,
    name: `Vapor 充值 ${money} 积分`,
    money,
    notifyUrl: epayConfig.notify_url,
    returnUrl: epayConfig.return_url,
  });

  return jsonResponse({
    trade_no: tradeNo,
    pay_url: payUrl,
  });
}

/**
 * 处理支付异步通知
 * GET /api/pay/notify
 */
async function handlePayNotify(request, env) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams);

  const kv = createKVClient(env.KV, env);

  // 获取支付配置
  const epayConfig = await kv.getEPayConfig();
  if (!epayConfig || !epayConfig.key) {
    console.error('支付回调失败: 支付未配置');
    return new Response('fail', { status: 500 });
  }

  // 验证签名和处理回调
  const result = handleNotify(params, epayConfig.key);

  if (!result.success) {
    console.error('支付回调验证失败:', result.error);
    return new Response('fail', { status: 400 });
  }

  try {
    // 完成订单（增加余额）
    await kv.completeOrder(result.data.tradeNo);
    console.log('订单完成:', result.data.tradeNo);

    // 返回 success 通知平台处理成功
    return new Response('success', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error) {
    console.error('处理支付回调失败:', error);
    return new Response('fail', { status: 500 });
  }
}

/**
 * 查询订单状态
 * GET /api/pay/query/:trade_no
 */
async function handleQueryOrder(request, env, ctx, tradeNo) {
  if (!ctx.user) {
    return errorResponse('未登录', 401);
  }

  const kv = createKVClient(env.KV, env);
  const order = await kv.getOrder(tradeNo);

  if (!order) {
    return errorResponse('订单不存在', 404);
  }

  // 验证订单归属
  if (order.uid !== ctx.user.uid) {
    return errorResponse('无权访问此订单', 403);
  }

  // 如果订单未完成，尝试从上游查询最新状态
  if (order.status === 0) {
    try {
      const epayConfig = await kv.getEPayConfig();
      if (epayConfig && epayConfig.pid && epayConfig.key) {
        const upstreamResult = await queryOrder(
          epayConfig.pid,
          epayConfig.key,
          tradeNo
        );

        if (upstreamResult.code === 1 && upstreamResult.status === 1) {
          // 上游已完成，更新本地
          await kv.completeOrder(tradeNo);
          order.status = 1;
          order.paid_at = Date.now();
        }
      }
    } catch (error) {
      console.error('查询上游订单失败:', error);
    }
  }

  return jsonResponse({ order });
}

/**
 * 支付成功后的回跳页面
 * GET /api/pay/return
 */
async function handlePayReturn(request, env) {
  const url = new URL(request.url);
  const tradeNo = url.searchParams.get('out_trade_no');

  const kv = createKVClient(env.KV, env);

  // 从 OAuth 配置读取前端 URL
  const oauthConfig = await kv.getOAuthConfig();
  const frontendUrl = oauthConfig?.frontend_url || '';

  const redirectUrl = tradeNo
    ? `${frontendUrl}/orders?trade_no=${tradeNo}`
    : `${frontendUrl}/orders`;

  return Response.redirect(redirectUrl, 302);
}

/**
 * 路由处理器
 */
export async function handlePay(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/pay', '');
  const method = request.method;

  // POST /api/pay/create
  if (path === '/create' && method === 'POST') {
    return handleCreateOrder(request, env, ctx);
  }

  // GET /api/pay/notify
  if (path === '/notify' && method === 'GET') {
    return handlePayNotify(request, env);
  }

  // GET /api/pay/return
  if (path === '/return' && method === 'GET') {
    return handlePayReturn(request, env);
  }

  // GET /api/pay/query/:trade_no
  if (path.startsWith('/query/')) {
    const tradeNo = path.replace('/query/', '');
    return handleQueryOrder(request, env, ctx, tradeNo);
  }

  return errorResponse('Not found', 404);
}
