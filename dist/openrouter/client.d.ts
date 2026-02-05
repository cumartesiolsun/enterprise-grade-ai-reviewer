/**
 * OpenRouter API Client
 * MVP v0.1 - Exact spec implementation
 */
export interface OpenRouterConfig {
    apiKey: string;
    baseUrl: string;
    timeoutMs: number;
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface OpenRouterRequest {
    model: string;
    messages: ChatMessage[];
    max_tokens: number;
    temperature: number;
}
export interface OpenRouterResponse {
    id: string;
    choices: Array<{
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
/**
 * Call OpenRouter API with retry policy
 * - Retry only for 429, 5xx, and network/timeout errors
 * - Exponential backoff: 1s, 2s, 4s (max 3 tries)
 * - Do not retry 400
 */
export declare function callOpenRouter(config: OpenRouterConfig, model: string, messages: ChatMessage[], maxTokens: number, temperature?: number): Promise<{
    content: string;
    tokensUsed: number;
}>;
//# sourceMappingURL=client.d.ts.map