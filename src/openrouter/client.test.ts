import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOpenRouter } from './client.js';
import type { OpenRouterConfig, ChatMessage } from './client.js';
import { logger } from '../utils/logger.js';

vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function mockResponse(
  body: object,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const defaultConfig: OpenRouterConfig = {
  apiKey: 'test-api-key',
  baseUrl: 'https://openrouter.test',
  timeoutMs: 60000,
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
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns content, tokensUsed, and finishReason on successful response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(successBody));

    const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000, 0.5);

    expect(result).toEqual({ content: 'Looks good!', tokensUsed: 15, finishReason: 'stop' });
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

  it('does not retry a 400 error whose body contains the word "timeout"', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Request timeout while validating prompt', { status: 400 })
    );

    await expect(
      callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000)
    ).rejects.toThrow('OpenRouter API error 400: Request timeout while validating prompt');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds on next attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ error: 'Rate limited' }, 429))
      .mockResolvedValueOnce(mockResponse(successBody));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ content: 'Looks good!', tokensUsed: 15, finishReason: 'stop' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 and succeeds on next attempt', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ error: 'Internal server error' }, 500))
      .mockResolvedValueOnce(mockResponse(successBody));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ content: 'Looks good!', tokensUsed: 15, finishReason: 'stop' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('makes 4 attempts with 1s, 2s, 4s backoff before failing on persistent 5xx', async () => {
    mockFetch.mockImplementation(async () => mockResponse({ error: 'Server error' }, 503));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);
    const assertion = expect(promise).rejects.toThrow('OpenRouter API error 503');

    // Initial attempt fires without any timer
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // First backoff: 1000ms
    await vi.advanceTimersByTimeAsync(999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second backoff: 2000ms
    await vi.advanceTimersByTimeAsync(1999);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Third backoff: 4000ms
    await vi.advanceTimersByTimeAsync(3999);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // No 5th attempt — the 4th failure is final
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('honors Retry-After (seconds) on 429 when larger than the backoff', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({ error: 'Rate limited' }, 429, { 'Retry-After': '10' })
      )
      .mockResolvedValueOnce(mockResponse(successBody));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Backoff would be 1s, but Retry-After: 10 wins
    await vi.advanceTimersByTimeAsync(9999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const result = await promise;
    expect(result.content).toBe('Looks good!');
  });

  it('caps a huge Retry-After at 30 seconds', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({ error: 'Rate limited' }, 429, { 'Retry-After': '3600' })
      )
      .mockResolvedValueOnce(mockResponse(successBody));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const result = await promise;
    expect(result.content).toBe('Looks good!');
  });

  it('falls back to normal backoff when Retry-After is unparseable', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({ error: 'Rate limited' }, 429, { 'Retry-After': 'whenever' })
      )
      .mockResolvedValueOnce(mockResponse(successBody));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const result = await promise;
    expect(result.content).toBe('Looks good!');
  });

  it('retries when fetch rejects with an AbortError (timeout)', async () => {
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    mockFetch
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(mockResponse(successBody));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.content).toBe('Looks good!');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries when fetch rejects with a network TypeError', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(mockResponse(successBody));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.content).toBe('Looks good!');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries when the error cause carries a network error code', async () => {
    const networkError = new Error('request failed');
    (networkError as { cause?: unknown }).cause = { code: 'ECONNRESET' };
    mockFetch
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(mockResponse(successBody));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.content).toBe('Looks good!');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unrecognized fetch rejection', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom'));

    await expect(
      callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000)
    ).rejects.toThrow('boom');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('clears the abort timer even when fetch rejects (no timer leak)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom'));

    await expect(
      callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000)
    ).rejects.toThrow('boom');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the abort timer after a successful call', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(successBody));

    await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns successfully when content is an empty string', async () => {
    const emptyContentBody = {
      id: 'gen-empty',
      choices: [
        {
          message: { role: 'assistant', content: '' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(emptyContentBody));

    const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    expect(result).toEqual({ content: '', tokensUsed: 10, finishReason: 'stop' });
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

  it('throws when the message has no content field', async () => {
    const missingContentBody = {
      id: 'gen-missing',
      choices: [
        {
          message: { role: 'assistant' },
          finish_reason: 'stop',
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(missingContentBody));

    await expect(
      callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000)
    ).rejects.toThrow('OpenRouter returned empty response');
  });

  it('truncates upstream error bodies to 300 chars in error messages', async () => {
    mockFetch.mockResolvedValueOnce(new Response('x'.repeat(500), { status: 400 }));

    await expect(
      callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000)
    ).rejects.toThrow(`OpenRouter API error 400: ${'x'.repeat(300)}…`);
  });

  it('logs a warning when finish_reason is "length"', async () => {
    const lengthBody = {
      id: 'gen-length',
      choices: [
        {
          message: { role: 'assistant', content: '{"findings": [' },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 1000, total_tokens: 1010 },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(lengthBody));

    const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    expect(result.finishReason).toBe('length');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('max_tokens'),
      expect.objectContaining({ model: 'test-model' })
    );
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
