/**
 * Google Gemini 提供商
 */

export class GeminiProvider {
  constructor(config) {
    this.baseUrl = config.base_url || 'https://generativelanguage.googleapis.com/v1beta';
    this.apiKey = config.api_key;
    this.defaultHeaders = config.headers || {};
  }

  /**
   * 发送生成内容请求
   */
  async generateContent(model, body, stream = false) {
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    const url = `${this.baseUrl}/models/${model}:${endpoint}?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.defaultHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    return response;
  }

  /**
   * 获取模型列表
   */
  async listModels() {
    const url = `${this.baseUrl}/models?key=${this.apiKey}`;

    const response = await fetch(url, {
      headers: this.defaultHeaders,
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }

    return await response.json();
  }
}
