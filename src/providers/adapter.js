/**
 * LLM 提供商适配器基类
 * 负责请求格式转换和响应处理
 */

/**
 * 提供商类型枚举
 */
export const ProviderType = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
};

/**
 * 检测请求格式类型
 * 根据请求体结构智能识别是 OpenAI、Anthropic 还是 Gemini 格式
 */
export function detectRequestFormat(body) {
  // Anthropic 格式特征：有 messages 且消息格式不同，或者有 anthropic_version
  if (body.anthropic_version || (body.messages && body.messages[0]?.content && typeof body.messages[0].content === 'object')) {
    // Anthropic 消息的 content 可以是数组
    return ProviderType.ANTHROPIC;
  }

  // Gemini 格式特征：有 contents 字段而非 messages
  if (body.contents) {
    return ProviderType.GEMINI;
  }

  // 默认按 OpenAI 格式处理
  return ProviderType.OPENAI;
}

/**
 * OpenAI 格式转换器
 */
export const OpenAIAdapter = {
  /**
   * 转换为 OpenAI 请求格式（passthrough）
   */
  toOpenAI(body) {
    return body;
  },

  /**
   * 从 OpenAI 响应转换
   */
  fromOpenAI(response) {
    return response;
  },

  /**
   * 转换为 Anthropic 请求格式
   */
  toAnthropic(body) {
    const messages = [];
    let system = '';

    for (const msg of body.messages || []) {
      if (msg.role === 'system') {
        system += (system ? '\n' : '') + msg.content;
      } else {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    return {
      model: body.model,
      max_tokens: body.max_tokens || 4096,
      system: system || undefined,
      messages,
      stream: body.stream || false,
      temperature: body.temperature,
      top_p: body.top_p,
      stop_sequences: body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : undefined,
    };
  },

  /**
   * 转换为 Gemini 请求格式
   */
  toGemini(body) {
    const contents = [];
    let systemInstruction = '';

    for (const msg of body.messages || []) {
      if (msg.role === 'system') {
        systemInstruction += (systemInstruction ? '\n' : '') + msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return {
      contents,
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      generationConfig: {
        maxOutputTokens: body.max_tokens,
        temperature: body.temperature,
        topP: body.top_p,
        stopSequences: body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : undefined,
      },
    };
  },
};

/**
 * 从 Anthropic 响应转换为 OpenAI 格式
 */
export function anthropicToOpenAI(response) {
  const content = response.content?.map(c => c.text).join('') || '';

  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
      },
      finish_reason: response.stop_reason === 'end_turn' ? 'stop' : response.stop_reason,
    }],
    usage: {
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
      total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    },
  };
}

/**
 * 从 Gemini 响应转换为 OpenAI 格式
 */
export function geminiToOpenAI(response) {
  const candidate = response.candidates?.[0];
  const content = candidate?.content?.parts?.map(p => p.text).join('') || '';

  return {
    id: `gemini-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.modelVersion || 'gemini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
      },
      finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : candidate?.finishReason?.toLowerCase(),
    }],
    usage: {
      prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
      completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: response.usageMetadata?.totalTokenCount || 0,
    },
  };
}

/**
 * 从 Anthropic SSE 流转换为 OpenAI SSE 格式
 */
export function* transformAnthropicStream(chunk) {
  const data = JSON.parse(chunk);

  switch (data.type) {
    case 'message_start':
      yield {
        id: data.message.id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: data.message.model,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        }],
      };
      break;

    case 'content_block_delta':
      if (data.delta?.type === 'text_delta') {
        yield {
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: { content: data.delta.text },
            finish_reason: null,
          }],
        };
      }
      break;

    case 'message_delta':
      yield {
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: data.delta?.stop_reason === 'end_turn' ? 'stop' : data.delta?.stop_reason,
        }],
        usage: {
          prompt_tokens: data.usage?.input_tokens || 0,
          completion_tokens: data.usage?.output_tokens || 0,
        },
      };
      break;

    case 'message_stop':
      yield { done: true };
      break;
  }
}

/**
 * 从 Gemini SSE 流转换为 OpenAI SSE 格式
 */
export function transformGeminiStreamChunk(chunk) {
  const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const finishReason = chunk.candidates?.[0]?.finishReason;

  return {
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { content: text },
      finish_reason: finishReason === 'STOP' ? 'stop' : null,
    }],
  };
}

/**
 * 估算 token 数量（简单实现）
 * 实际使用中建议接入 tiktoken 或使用 API 返回的 usage
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // 粗略估算：英文约 4 字符一个 token，中文约 1.5 字符一个 token
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 从请求体估算 input tokens
 */
export function estimateInputTokens(body) {
  let total = 0;

  // OpenAI 格式
  if (body.messages) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        total += estimateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            total += estimateTokens(part.text);
          }
        }
      }
    }
  }

  // Gemini 格式
  if (body.contents) {
    for (const content of body.contents) {
      for (const part of content.parts || []) {
        if (part.text) {
          total += estimateTokens(part.text);
        }
      }
    }
  }

  return total;
}
