/**
 * LinuxDo OAuth 认证模块
 */

const AUTHORIZATION_ENDPOINT = 'https://connect.linux.do/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://connect.linux.do/oauth2/token';
const USER_ENDPOINT = 'https://connect.linux.do/api/user';

/**
 * 生成 OAuth 授权 URL
 */
export function getAuthorizationUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });

  return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

/**
 * 用授权码换取 access_token
 */
export async function exchangeCodeForToken(code, clientId, clientSecret, redirectUri) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return await response.json();
}

/**
 * 获取用户信息
 */
export async function getUserInfo(accessToken) {
  const response = await fetch(USER_ENDPOINT, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch user info: ${error}`);
  }

  return await response.json();
}

/**
 * 生成随机 state
 */
export function generateState() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}
