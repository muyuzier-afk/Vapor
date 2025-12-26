/**
 * Anthropic 提供商
 */

export class AnthropicProvider {
  constructor(config) {
    this.baseUrl = config.base_url || 'https://api.anthropic.com';
    this.apiKey = config.api_key;
    this.version = config.version || '2023-06-01';
    this.defaultHeaders = config.headers || {};
  }

  /**
   * 发送消息请求
   */
  async messages(body, stream = false) {
    const url = `${this.baseUrl}/v1/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.version,
        ...this.defaultHeaders,
      },
      body: JSON.stringify({
        ...body,
        stream,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    return response;
  }
}
