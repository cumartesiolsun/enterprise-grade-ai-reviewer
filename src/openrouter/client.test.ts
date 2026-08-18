import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOpenRouter, OpenRouterEmptyError } from './client.js';
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

  it('returns emptyReason when content is an empty string with finish_reason stop', async () => {
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

    expect(result).toEqual({
      content: '',
      tokensUsed: 10,
      finishReason: 'stop',
      emptyReason: 'stop',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on empty response with no choices instead of failing immediately', async () => {
    const emptyBody = {
      id: 'gen-789',
      choices: [],
    };
    mockFetch
      .mockResolvedValueOnce(mockResponse(emptyBody))
      .mockResolvedValueOnce(mockResponse(successBody));

    const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.content).toBe('Looks good!');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('treats a missing content field with finish_reason stop as a legitimate empty completion', async () => {
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

    const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

    expect(result).toEqual({
      content: '',
      tokensUsed: 0,
      finishReason: 'stop',
      emptyReason: 'stop',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
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

  describe('content extraction', () => {
    it('joins the text fields of text-type parts when content is an array', async () => {
      const partsBody = {
        id: 'gen-parts',
        choices: [
          {
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Part one. ' },
                { type: 'image_url', image_url: { url: 'https://example.test/x.png' } },
                { type: 'text', text: 'Part two.' },
                { type: 'audio', data: 'zzz' },
              ],
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      };
      mockFetch.mockResolvedValueOnce(mockResponse(partsBody));

      const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

      expect(result.content).toBe('Part one. Part two.');
      expect(result.finishReason).toBe('stop');
    });

    it('returns content and never leaks the reasoning field into it', async () => {
      const reasoningBody = {
        id: 'gen-reasoning',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'The final answer.',
              reasoning: 'SECRET chain of thought that must not leak',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 500, total_tokens: 510 },
      };
      mockFetch.mockResolvedValueOnce(mockResponse(reasoningBody));

      const result = await callOpenRouter(defaultConfig, 'test-model', defaultMessages, 1000);

      expect(result.content).toBe('The final answer.');
      expect(result.content).not.toContain('SECRET');
      expect(result.emptyReason).toBeUndefined();
    });
  });

  describe('empty-content adaptive retry', () => {
    const emptyLengthBody = {
      id: 'gen-empty-length',
      choices: [
        {
          message: { role: 'assistant', content: '' },
          finish_reason: 'length',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2000, total_tokens: 2010 },
    };

    function requestBodyOfCall(index: number): Record<string, unknown> {
      const fetchCall = mockFetch.mock.calls[index] as [string, RequestInit];
      return JSON.parse(fetchCall[1].body as string) as Record<string, unknown>;
    }

    it('retries empty + finish_reason length with doubled max_tokens and reasoning exclusion', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(emptyLengthBody))
        .mockResolvedValueOnce(mockResponse(successBody));

      const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 2000);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.content).toBe('Looks good!');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First attempt body is byte-identical to the pre-v0.5 request:
      // original max_tokens and no reasoning field at all.
      const firstRawBody = (mockFetch.mock.calls[0] as [string, RequestInit])[1].body;
      expect(firstRawBody).toBe(
        JSON.stringify({
          model: 'test-model',
          messages: defaultMessages,
          max_tokens: 2000,
          temperature: 0.3,
        })
      );

      const retryBody = requestBodyOfCall(1);
      expect(retryBody.max_tokens).toBe(4000);
      expect(retryBody.reasoning).toEqual({ exclude: true, effort: 'low' });
    });

    it('throws OpenRouterEmptyError with diagnostics after 4 empty length attempts', async () => {
      mockFetch.mockImplementation(async () => mockResponse(emptyLengthBody));

      const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 2000);
      const captured = promise.catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await captured;

      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(error).toBeInstanceOf(OpenRouterEmptyError);
      const message = (error as OpenRouterEmptyError).message;
      expect(message).toContain('finish_reason=length');
      expect(message).toContain('completion_tokens=2000');
      expect(message).toContain('reasoning=absent');
    });

    it('retries when content is empty but hidden reasoning is present', async () => {
      const emptyWithReasoningBody = {
        id: 'gen-empty-reasoning',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning: 'thought about it for a very long time',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 900, total_tokens: 910 },
      };
      mockFetch
        .mockResolvedValueOnce(mockResponse(emptyWithReasoningBody))
        .mockResolvedValueOnce(mockResponse(successBody));

      const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 2000);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.content).toBe('Looks good!');
      expect(result.emptyReason).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const retryBody = requestBodyOfCall(1);
      expect(retryBody.max_tokens).toBe(4000);
      expect(retryBody.reasoning).toEqual({ exclude: true, effort: 'low' });
    });

    it('includes reasoning presence and length in the error diagnostics', async () => {
      const emptyWithReasoningBody = {
        id: 'gen-empty-reasoning-diag',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning: 'x'.repeat(42),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 900, total_tokens: 910 },
      };
      mockFetch.mockImplementation(async () => mockResponse(emptyWithReasoningBody));

      const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 2000);
      const captured = promise.catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await captured;

      expect(error).toBeInstanceOf(OpenRouterEmptyError);
      const message = (error as OpenRouterEmptyError).message;
      expect(message).toContain('finish_reason=stop');
      expect(message).toContain('completion_tokens=900');
      expect(message).toContain('reasoning=present (42 chars)');
    });

    it('retries empty content with an unrecognized finish_reason (conservative)', async () => {
      const contentFilterBody = {
        id: 'gen-filtered',
        choices: [
          {
            message: { role: 'assistant', content: '' },
            finish_reason: 'content_filter',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      };
      mockFetch
        .mockResolvedValueOnce(mockResponse(contentFilterBody))
        .mockResolvedValueOnce(mockResponse(successBody));

      const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 2000);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.content).toBe('Looks good!');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries a missing message instead of dying on attempt 1', async () => {
      const noMessageBody = {
        id: 'gen-no-message',
        choices: [{ finish_reason: 'stop' }],
      };
      mockFetch
        .mockResolvedValueOnce(mockResponse(noMessageBody))
        .mockResolvedValueOnce(mockResponse(successBody));

      const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 2000);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.content).toBe('Looks good!');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('drops the reasoning field but keeps doubled max_tokens after a 400 on a reasoning body', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse(emptyLengthBody)) // attempt 1: empty → adaptive retry
        .mockResolvedValueOnce(mockResponse({ error: 'reasoning is not supported' }, 400)) // attempt 2 carried reasoning
        .mockResolvedValueOnce(mockResponse(successBody)); // attempt 3: no reasoning, tokens kept

      const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 2000);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.content).toBe('Looks good!');
      expect(mockFetch).toHaveBeenCalledTimes(3);

      const secondBody = requestBodyOfCall(1);
      expect(secondBody.reasoning).toEqual({ exclude: true, effort: 'low' });
      expect(secondBody.max_tokens).toBe(4000);

      const thirdBody = requestBodyOfCall(2);
      expect(thirdBody).not.toHaveProperty('reasoning');
      expect(thirdBody.max_tokens).toBe(4000);
    });

    it('caps compounding max_tokens doubling at 16000', async () => {
      mockFetch.mockImplementation(async () => mockResponse(emptyLengthBody));

      const promise = callOpenRouter(defaultConfig, 'test-model', defaultMessages, 6000);
      const captured = promise.catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await captured;

      expect(error).toBeInstanceOf(OpenRouterEmptyError);
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // 6000 → 12000 → 16000 (cap of 24000) → 16000
      expect(requestBodyOfCall(0).max_tokens).toBe(6000);
      expect(requestBodyOfCall(1).max_tokens).toBe(12000);
      expect(requestBodyOfCall(2).max_tokens).toBe(16000);
      expect(requestBodyOfCall(3).max_tokens).toBe(16000);

      // First attempt never carries the reasoning field; retries do.
      expect(requestBodyOfCall(0)).not.toHaveProperty('reasoning');
      expect(requestBodyOfCall(1)).toHaveProperty('reasoning');
    });
  });
});
