/**
 * OpenRouter API Client
 */
import type { OpenRouterClientConfig, CallOptions } from './types.js';
export declare class OpenRouterClient {
    private apiKey;
    private baseUrl;
    private defaultMaxTokens;
    private defaultTemperature;
    private timeout;
    constructor(config: OpenRouterClientConfig);
    /**
     * Make a chat completion request
     */
    chat(modelKey: string, userPrompt: string, options?: CallOptions): Promise<{
        content: string;
        tokensUsed: number;
    }>;
    /**
     * Make a raw API request with retry logic
     */
    private makeRequest;
}
export declare function getOpenRouterClient(): OpenRouterClient;
/**
 * Convenience function to call OpenRouter
 */
export declare function callOpenRouter(modelKey: string, prompt: string, options?: CallOptions): Promise<{
    content: string;
    tokensUsed: number;
}>;
//# sourceMappingURL=client.d.ts.map