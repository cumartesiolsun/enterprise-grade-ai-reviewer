/**
 * OpenRouter API Client
 */

import type {
  OpenRouterClientConfig,
  OpenRouterRequest,
  OpenRouterResponse,
  CallOptions,
} from './types.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { getModelId } from '../config/models.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT = 60000; // 60 seconds

export class OpenRouterClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultMaxTokens: number;
  private defaultTemperature: number;
  private timeout: number;

  constructor(config: OpenRouterClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 1000;
    this.defaultTemperature = config.defaultTemperature ?? 0.3;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Make a chat completion request
   */
  async chat(
    modelKey: string,
    userPrompt: string,
    options: CallOptions = {}
  ): Promise<{ content: string; tokensUsed: number }> {
    const modelId = getModelId(modelKey);
    const messages: OpenRouterRequest['messages'] = [];

    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    messages.push({ role: 'user', content: userPrompt });

    const request: OpenRouterRequest = {
      model: modelId,
      messages,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      temperature: options.temperature ?? this.defaultTemperature,
    };

    logger.debug('OpenRouter request', { model: modelId, promptLength: userPrompt.length });

    const response = await this.makeRequest(request);

    const content = response.choices[0]?.message.content ?? '';
    const tokensUsed = response.usage.total_tokens;

    logger.debug('OpenRouter response', {
      model: modelId,
      tokensUsed,
      responseLength: content.length,
    });

    return { content, tokensUsed };
  }

  /**
   * Make a raw API request with retry logic
   */
  private async makeRequest(request: OpenRouterRequest): Promise<OpenRouterResponse> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`,
              'HTTP-Referer': 'https://github.com/enterprise-grade-ai-reviewer',
              'X-Title': 'Enterprise AI Reviewer',
            },
            body: JSON.stringify(request),
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
          }

          return (await response.json()) as OpenRouterResponse;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        isRetryable: (error) => {
          if (error instanceof Error) {
            const message = error.message.toLowerCase();
            return (
              message.includes('429') ||
              message.includes('rate limit') ||
              message.includes('timeout') ||
              message.includes('503') ||
              message.includes('502')
            );
          }
          return false;
        },
      }
    );
  }
}

// Singleton instance factory
let clientInstance: OpenRouterClient | null = null;

export function getOpenRouterClient(): OpenRouterClient {
  if (!clientInstance) {
    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY environment variable is required');
    }
    clientInstance = new OpenRouterClient({ apiKey });
  }
  return clientInstance;
}

/**
 * Convenience function to call OpenRouter
 */
export async function callOpenRouter(
  modelKey: string,
  prompt: string,
  options: CallOptions = {}
): Promise<{ content: string; tokensUsed: number }> {
  const client = getOpenRouterClient();
  return client.chat(modelKey, prompt, options);
}
