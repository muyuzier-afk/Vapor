/**
 * LLM API 代理层
 * /v1/* - 智能路由，支持 OpenAI/Anthropic/Gemini 格式
 */

import { createKVClient } from '../../src/lib/kv.js';
import { jsonResponse, errorResponse, extractBearerToken } from '../../src/lib/utils.js';
import {
  detectRequestFormat,
  ProviderType,
  OpenAIAdapter,
  anthropicToOpenAI,
  geminiToOpenAI,
  estimateInputTokens,
} from '../../src/providers/adapter.js';
import { OpenAIProvider } from '../../src/providers/openai.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { GeminiProvider } from '../../src/providers/gemini.js';

/**
 * 验证 API Key 并获取用户
 */
async function authenticateRequest(request, env) {
  const token = extractBearerToken(request);
  if (!token) {
    return { error: errorResponse('缺少 API Key', 401) };
  }

  const kv = createKVClient(env.KV);
  const result = await kv.validateApiKey(token);

  if (!result) {
    return { error: errorResponse('API Key 无效或已禁用', 401) };
  }

  if (result.user.is_blocked) {
    return { error: errorResponse('账户已被封禁', 403) };
  }

  return { user: result.user, keyData: result.keyData, kv };
}

/**
 * 获取模型配置和渠道信息
 */
async function getModelConfig(kv, modelId) {
  const model = await kv.getModel(modelId);
  if (!model || !model.enabled) {
    return null;
  }

  // 获取关联的渠道配置
  const channel = await kv.getChannel(model.channel_id);
  if (!channel || !channel.enabled) {
    return null;
  }

  return { model, channel };
}

/**
 * 计算请求费用
 */
function calculateCost(model, inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1000) * (model.input_price || 0);
  const outputCost = (outputTokens / 1000) * (model.output_price || 0);
  return inputCost + outputCost;
}

/**
 * 创建上游提供商实例
 */
function createProvider(channel) {
  switch (channel.provider) {
    case ProviderType.OPENAI:
      return new OpenAIProvider({
        base_url: channel.base_url,
        api_key: channel.api_key,
        headers: channel.headers,
      });

    case ProviderType.ANTHROPIC:
      return new AnthropicProvider({
        base_url: channel.base_url,
        api_key: channel.api_key,
        version: channel.version,
        headers: channel.headers,
      });

    case ProviderType.GEMINI:
      return new GeminiProvider({
        base_url: channel.base_url,
        api_key: channel.api_key,
        headers: channel.headers,
      });

    default:
      throw new Error(`不支持的提供商类型: ${channel.provider}`);
  }
}

/**
 * 处理 SSE 流式响应转换
 */
function createStreamTransformer(channel, model) {
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      buffer += text;

      // 按行处理 SSE 数据
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          continue;
        }

        try {
          const parsed = JSON.parse(data);

          // 根据提供商类型转换格式
          let transformed;
          if (channel.provider === ProviderType.ANTHROPIC) {
            // Anthropic 流式响应处理
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              transformed = {
                id: parsed.message?.id || `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model.model_id,
                choices: [{
                  index: 0,
                  delta: { content: parsed.delta.text },
                  finish_reason: null,
                }],
              };
              outputTokens += Math.ceil(parsed.delta.text.length / 4);
            } else if (parsed.type === 'message_delta') {
              transformed = {
                object: 'chat.completion.chunk',
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: parsed.delta?.stop_reason === 'end_turn' ? 'stop' : null,
                }],
              };
              if (parsed.usage) {
                inputTokens = parsed.usage.input_tokens || inputTokens;
                outputTokens = parsed.usage.output_tokens || outputTokens;
              }
            } else if (parsed.type === 'message_start' && parsed.message) {
              inputTokens = parsed.message.usage?.input_tokens || 0;
              transformed = {
                id: parsed.message.id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model.model_id,
                choices: [{
                  index: 0,
                  delta: { role: 'assistant' },
                  finish_reason: null,
                }],
              };
            } else {
              continue;
            }
          } else if (channel.provider === ProviderType.GEMINI) {
            // Gemini 流式响应处理
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              transformed = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model.model_id,
                choices: [{
                  index: 0,
                  delta: { content: text },
                  finish_reason: parsed.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : null,
                }],
              };
              outputTokens += Math.ceil(text.length / 4);
            }
            if (parsed.usageMetadata) {
              inputTokens = parsed.usageMetadata.promptTokenCount || inputTokens;
              outputTokens = parsed.usageMetadata.candidatesTokenCount || outputTokens;
            }
          } else {
            // OpenAI 格式直接透传
            transformed = parsed;
            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens || inputTokens;
              outputTokens = parsed.usage.completion_tokens || outputTokens;
            }
          }

          if (transformed) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(transformed)}\n\n`));
          }
        } catch (e) {
          console.error('解析流数据失败:', e);
        }
      }
    },

    flush(controller) {
      // 返回最终的 token 统计
      this.finalUsage = { inputTokens, outputTokens };
    },
  });
}

/**
 * 处理 /v1/chat/completions
 */
async function handleChatCompletions(request, env) {
  // 认证
  const auth = await authenticateRequest(request, env);
  if (auth.error) return auth.error;

  const { user, kv } = auth;

  // 解析请求体
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('无效的 JSON 请求体', 400);
  }

  const modelId = body.model;
  if (!modelId) {
    return errorResponse('缺少 model 参数', 400);
  }

  // 检测请求格式（智能路由）
  const requestFormat = detectRequestFormat(body);

  // 获取模型配置
  const config = await getModelConfig(kv, modelId);
  if (!config) {
    return errorResponse(`模型 ${modelId} 不存在或未启用`, 404);
  }

  const { model, channel } = config;

  // 预估 input tokens（用于余额预检）
  const estimatedInputTokens = estimateInputTokens(body);
  const estimatedCost = calculateCost(model, estimatedInputTokens, 100);

  // 检查余额
  if (user.balance < estimatedCost) {
    return errorResponse('余额不足，请先充值', 402);
  }

  // 创建提供商实例
  const provider = createProvider(channel);

  // 根据提供商类型转换请求格式
  let upstreamBody = body;
  let upstreamModel = model.upstream_model || modelId;

  if (channel.provider === ProviderType.ANTHROPIC) {
    upstreamBody = OpenAIAdapter.toAnthropic(body);
    upstreamBody.model = upstreamModel;
  } else if (channel.provider === ProviderType.GEMINI) {
    upstreamBody = OpenAIAdapter.toGemini(body);
  } else {
    upstreamBody = { ...body, model: upstreamModel };
  }

  const isStream = body.stream === true;

  try {
    let response;

    if (channel.provider === ProviderType.ANTHROPIC) {
      response = await provider.messages(upstreamBody, isStream);
    } else if (channel.provider === ProviderType.GEMINI) {
      response = await provider.generateContent(upstreamModel, upstreamBody, isStream);
    } else {
      response = await provider.chatCompletions(upstreamBody, isStream);
    }

    if (isStream) {
      // 流式响应
      const transformer = createStreamTransformer(channel, model);
      const transformedStream = response.body.pipeThrough(transformer);

      // 异步记录用量（流式响应无法同步获取最终 token 数）
      // 这里使用估算值，后续可以通过解析流数据获取准确值
      const estimatedOutputTokens = 500;
      const cost = calculateCost(model, estimatedInputTokens, estimatedOutputTokens);

      // 异步扣费和记录
      env.waitUntil?.(
        (async () => {
          try {
            await kv.updateBalance(user.uid, -cost);
            await kv.recordUsage(user.uid, modelId, estimatedInputTokens, estimatedOutputTokens, cost);
          } catch (e) {
            console.error('记录用量失败:', e);
          }
        })()
      );

      return new Response(transformedStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } else {
      // 非流式响应
      let result = await response.json();

      // 转换响应格式为 OpenAI 格式
      if (channel.provider === ProviderType.ANTHROPIC) {
        result = anthropicToOpenAI(result);
      } else if (channel.provider === ProviderType.GEMINI) {
        result = geminiToOpenAI(result);
      }

      // 覆盖模型名称为用户请求的模型
      result.model = modelId;

      // 计算实际费用
      const inputTokens = result.usage?.prompt_tokens || estimatedInputTokens;
      const outputTokens = result.usage?.completion_tokens || 0;
      const cost = calculateCost(model, inputTokens, outputTokens);

      // 扣费和记录用量
      try {
        await kv.updateBalance(user.uid, -cost);
        await kv.recordUsage(user.uid, modelId, inputTokens, outputTokens, cost);
      } catch (e) {
        console.error('记录用量失败:', e);
      }

      return jsonResponse(result);
    }
  } catch (error) {
    console.error('API 请求失败:', error);
    return errorResponse(`上游 API 错误: ${error.message}`, 502);
  }
}

/**
 * 处理 /v1/models
 */
async function handleListModels(request, env) {
  // API Key 可选，未登录也能查看模型列表
  const token = extractBearerToken(request);
  const kv = createKVClient(env.KV);

  const models = await kv.listModels();
  const enabledModels = models.filter(m => m.enabled);

  // 转换为 OpenAI 格式
  const data = enabledModels.map(m => ({
    id: m.model_id,
    object: 'model',
    created: Math.floor(m.created_at / 1000) || Math.floor(Date.now() / 1000),
    owned_by: m.provider || 'vapor',
    permission: [],
    root: m.model_id,
    parent: null,
  }));

  return jsonResponse({
    object: 'list',
    data,
  });
}

/**
 * 处理 /v1/messages (Anthropic 兼容)
 */
async function handleMessages(request, env) {
  // 转换为 OpenAI 格式后处理
  return handleChatCompletions(request, env);
}

/**
 * 路由处理器
 */
export async function handleV1(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS 预检
  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // /v1/chat/completions
  if (path === '/v1/chat/completions' && method === 'POST') {
    return handleChatCompletions(request, env);
  }

  // /v1/models
  if (path === '/v1/models' && method === 'GET') {
    return handleListModels(request, env);
  }

  // /v1/messages (Anthropic 兼容)
  if (path === '/v1/messages' && method === 'POST') {
    return handleMessages(request, env);
  }

  return errorResponse('Not found', 404);
}
