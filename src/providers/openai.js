/**
 * OpenAI 提供商
 */

export class OpenAIProvider {
  constructor(config) {
    this.baseUrl = config.base_url || 'https://api.openai.com/v1';
    this.apiKey = config.api_key;
    this.defaultHeaders = config.headers || {};
  }

  /**
   * 发送聊天补全请求
   */
  async chatCompletions(body, stream = false) {
    const url = `${this.baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.defaultHeaders,
      },
      body: JSON.stringify({
        ...body,
        stream,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    return response;
  }

  /**
   * 获取模型列表
   */
  async listModels() {
    const url = `${this.baseUrl}/models`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.defaultHeaders,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }

    return await response.json();
  }
}
