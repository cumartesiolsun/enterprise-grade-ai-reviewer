import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOpenRouter } from './client.js';
import type { OpenRouterConfig, ChatMessage } from './client.js';

vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function mockResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const defaultConfig: OpenRouterConfig = {
  apiKey: 'test-api-key',
  baseUrl: 'https://openrouter.test',
  timeoutMs: 30000,
};

const defaultMessages: ChatMessage[] = [
  { role: 'system', content: 'You are a reviewer.' },
  { role: 'user', content: 'Review this code.' },
];

const successBody = {
  id: 'gen-123',
  choices: [
    {
      message: { role: 'assistant', content: 'Looks good!' },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  },
};

describe('callOpenRouter', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns content and tokensUsed on successful response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(successBody));

    const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000, 0.5);

    expect(result).toEqual({ content: 'Looks good!', tokensUsed: 15 });
  });

  it('returns tokensUsed as 0 when usage is not provided', async () => {
    const bodyWithoutUsage = {
      id: 'gen-456',
      choices: [
        {
          message: { role: 'assistant', content: 'No usage info.' },
          finish_reason: 'stop',
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(bodyWithoutUsage));

    const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    expect(result.content).toBe('No usage info.');
    expect(result.tokensUsed).toBe(0);
  });

  it('throws immediately on 400 error without retrying', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'Bad request' }, 400));

    await expect(
      callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000)
    ).rejects.toThrow('OpenRouter API error 400');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on next attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ error: 'Rate limited' }, 429))
      .mockResolvedValueOnce(mockResponse(successBody));

    const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    expect(result).toEqual({ content: 'Looks good!', tokensUsed: 15 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 and succeeds on next attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ error: 'Internal server error' }, 500))
      .mockResolvedValueOnce(mockResponse(successBody));

    const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    expect(result).toEqual({ content: 'Looks good!', tokensUsed: 15 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries exhausted on 5xx', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ error: 'Server error' }, 503))
      .mockResolvedValueOnce(mockResponse({ error: 'Server error' }, 503))
      .mockResolvedValueOnce(mockResponse({ error: 'Server error' }, 503));

    await expect(
      callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000)
    ).rejects.toThrow('OpenRouter API error 503');

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws on empty response with no choices', async () => {
    const emptyBody = {
      id: 'gen-789',
      choices: [],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(emptyBody));

    await expect(
      callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000)
    ).rejects.toThrow('OpenRouter returned empty response');
  });

  it('sends correct headers including Authorization Bearer and Content-Type', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(successBody));

    await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = fetchCall[1].headers as Record<string, string>;

    expect(headers['Authorization']).toBe('Bearer test-api-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends correct request body with model, messages, max_tokens, and temperature', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(successBody));

    await callOpenRouter(defaultConfig, 'my-model', defaultMessages, 2000, 0.7);

    const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string) as Record<string, unknown>;

    expect(fetchCall[0]).toBe('https://openrouter.test/chat/completions');
    expect(body.model).toBe('my-model');
    expect(body.messages).toEqual(defaultMessages);
    expect(body.max_tokens).toBe(2000);
    expect(body.temperature).toBe(0.7);
  });
});
