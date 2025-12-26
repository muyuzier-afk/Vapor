/**
 * LinuxDo Credit (EPay) 支付模块
 */

import { md5 } from './utils.js';

const EPAY_GATEWAY = 'https://credit.linux.do/epay';

/**
 * 生成 EPay 签名
 * 算法：非空字段按 ASCII 升序排列，拼接后追加密钥，MD5 取小写
 */
export function generateSign(params, secret) {
  // 过滤空值和签名字段
  const filtered = Object.entries(params)
    .filter(([key, value]) => {
      return value !== '' && value !== null && value !== undefined && key !== 'sign' && key !== 'sign_type';
    })
    .sort((a, b) => a[0].localeCompare(b[0]));

  // 拼接成 k1=v1&k2=v2 格式
  const str = filtered.map(([k, v]) => `${k}=${v}`).join('&');

  // 追加密钥并 MD5
  return md5(str + secret);
}

/**
 * 验证 EPay 签名
 */
export function verifySign(params, secret) {
  const sign = params.sign;
  if (!sign) return false;

  const expectedSign = generateSign(params, secret);
  return sign.toLowerCase() === expectedSign.toLowerCase();
}

/**
 * 创建支付订单
 * 返回支付跳转 URL
 */
export function createPaymentUrl(options) {
  const { pid, key, outTradeNo, name, money, notifyUrl, returnUrl, device } = options;

  const params = {
    pid,
    type: 'epay',
    out_trade_no: outTradeNo,
    name,
    money: String(money),
    notify_url: notifyUrl || '',
    return_url: returnUrl || '',
    device: device || '',
  };

  // 生成签名
  params.sign = generateSign(params, key);
  params.sign_type = 'MD5';

  // 构建跳转 URL
  const urlParams = new URLSearchParams(params);
  return `${EPAY_GATEWAY}/pay/submit.php?${urlParams.toString()}`;
}

/**
 * 查询订单状态
 */
export async function queryOrder(pid, key, tradeNo, outTradeNo) {
  const params = new URLSearchParams({
    act: 'order',
    pid,
    key,
    trade_no: tradeNo,
  });

  if (outTradeNo) {
    params.set('out_trade_no', outTradeNo);
  }

  const response = await fetch(`${EPAY_GATEWAY}/api.php?${params.toString()}`);

  if (!response.ok) {
    throw new Error('订单查询失败');
  }

  return await response.json();
}

/**
 * 订单退款
 */
export async function refundOrder(pid, key, tradeNo, money, outTradeNo) {
  const body = {
    pid,
    key,
    trade_no: tradeNo,
    money: String(money),
  };

  if (outTradeNo) {
    body.out_trade_no = outTradeNo;
  }

  const response = await fetch(`${EPAY_GATEWAY}/api.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return await response.json();
}

/**
 * 处理异步通知
 * 返回处理结果，成功返回 { success: true, data }，失败返回 { success: false, error }
 */
export function handleNotify(params, secret) {
  // 验证签名
  if (!verifySign(params, secret)) {
    return { success: false, error: '签名验证失败' };
  }

  // 验证交易状态
  if (params.trade_status !== 'TRADE_SUCCESS') {
    return { success: false, error: '交易状态异常' };
  }

  return {
    success: true,
    data: {
      pid: params.pid,
      tradeNo: params.trade_no,
      outTradeNo: params.out_trade_no,
      money: parseFloat(params.money),
      name: params.name,
    },
  };
}
