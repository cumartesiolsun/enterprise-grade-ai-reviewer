/**
 * OpenRouter API Types
 */

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface OpenRouterChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
  };
  finish_reason: 'stop' | 'length' | 'content_filter' | null;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: OpenRouterChoice[];
  usage: OpenRouterUsage;
  created: number;
}

export interface OpenRouterError {
  error: {
    message: string;
    type: string;
    code: string;
  };
}

export interface OpenRouterClientConfig {
  apiKey: string;
  baseUrl?: string;
  defaultMaxTokens?: number;
  defaultTemperature?: number;
  timeout?: number;
}

export interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}
