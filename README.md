# Enterprise AI Code Reviewer

Multi-LLM AI-powered code review with parallel scanning and intelligent aggregation.

## Problem Statement

Traditional code review tools use a single AI model, which creates a single point of failure and limits the quality of feedback. Different models have different strengths—some excel at security analysis, others at performance optimization or logic errors.

**Enterprise AI Code Reviewer** solves this by running multiple LLM models in parallel (scanners) and then using a separate model (judge) to merge their outputs into a single, high-quality review.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GitHub Pull Request                          │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Diff Normalization                          │
│              (max_files, max_chars truncation)                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
            │  Scanner 1  │ │  Scanner 2  │ │  Scanner N  │
            │  (Model A)  │ │  (Model B)  │ │  (Model X)  │
            └─────────────┘ └─────────────┘ └─────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                              Judge                                   │
│      Merges scanner outputs: dedupe, resolve contradictions,        │
│      discard weak findings, prioritize critical issues              │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Single PR Comment                               │
│           (marker-based update/create mechanism)                    │
└─────────────────────────────────────────────────────────────────────┘
```

## Scanner vs Judge Model

### Scanners
- Multiple LLM models run **in parallel**
- Each scanner reviews the same diff **independently**
- Scanners **never see** each other's output
- Focus: bugs, security issues, incorrect logic, performance problems, missing edge cases
- Prompt: "Be concise. Bullet points only. Do not repeat the diff. Do not invent issues."

### Judge
- Single LLM model runs **after** all scanners complete
- Receives **all** scanner outputs as input
- Merges results into **one** unified review
- Tasks: remove duplicates, resolve contradictions, discard weak findings, prioritize critical issues
- Constraint: "Do NOT add new findings. Use only the provided inputs."

## How It Works

1. **Trigger**: GitHub Action runs on `pull_request` events
2. **Fetch Diff**: Retrieve PR files via GitHub API, normalize with truncation limits
3. **Parallel Scanning**: Run all scanner models simultaneously via OpenRouter
4. **Aggregation**: Judge model merges scanner outputs
5. **Post Comment**: Create or update a single PR comment with the final review

## Usage

### Basic Configuration

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: your-org/enterprise-grade-ai-reviewer@v0.1
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          scanner-models: |
            anthropic/claude-3-haiku
            openai/gpt-4o-mini
            google/gemini-flash-1.5
          judge-model: anthropic/claude-3-sonnet
```

### Scanner Models Input Formats

The `scanner-models` input accepts three formats:

**Multiline (recommended)**:
```yaml
scanner-models: |
  anthropic/claude-3-haiku
  openai/gpt-4o-mini
  google/gemini-flash-1.5
```

**CSV**:
```yaml
scanner-models: anthropic/claude-3-haiku,openai/gpt-4o-mini,google/gemini-flash-1.5
```

**JSON Array**:
```yaml
scanner-models: '["anthropic/claude-3-haiku", "openai/gpt-4o-mini"]'
```

## Configuration Options

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `openrouter-api-key` | Yes | - | OpenRouter API key for LLM access |
| `github-token` | Yes | - | GitHub token for API access |
| `scanner-models` | Yes | - | List of scanner models (CSV, multiline, or JSON) |
| `judge-model` | Yes | - | Model for aggregation/judging |
| `language` | No | `tr` | Output language (tr, en, etc.) |
| `base-url` | No | `https://openrouter.ai/api/v1` | OpenRouter API base URL |
| `max-files` | No | `10` | Maximum files to review |
| `max-chars` | No | `80000` | Maximum characters in diff |
| `timeout-ms` | No | `180000` | API call timeout (3 minutes) |
| `max-tokens-scanner` | No | `600` | Max tokens per scanner response |
| `max-tokens-judge` | No | `800` | Max tokens for judge response |
| `comment-marker` | No | `ENTERPRISE_AI_REVIEW` | Marker for finding/updating PR comment |

## Model-Agnostic Design

This action is **completely model-agnostic**. You choose:
- Which models to use as scanners
- Which model to use as the judge
- How many scanners to run in parallel

There are no hardcoded model names. The action works with any model available through OpenRouter.

### Why OpenRouter?

[OpenRouter](https://openrouter.ai) provides a unified API for 100+ LLM models from different providers:
- Single API key for all models
- Consistent request/response format
- Automatic fallback and load balancing
- Cost tracking and usage limits
- No vendor lock-in

## Retry Policy

API calls follow this retry policy:
- **Retry**: 429 (rate limit), 5xx (server errors), network/timeout errors
- **No Retry**: 400 (bad request) — fails immediately
- **Backoff**: Exponential (1s, 2s, 4s)
- **Max Retries**: 3

## Limitations (MVP v0.1)

- `auto-select-models` is not implemented (placeholder for future versions)
- No caching of results across runs
- No support for review suggestions (only comments)
- No support for file-level comments (only PR-level)
- No cost estimation or budget controls

## Project Structure

```
src/
├── index.ts              # GitHub Action entry point
├── github/
│   ├── diff.ts           # PR diff fetching and normalization
│   └── comments.ts       # PR comment management
├── openrouter/
│   └── client.ts         # OpenRouter API client with retry
├── review/
│   ├── scanner.ts        # Parallel scanner execution
│   ├── judge.ts          # Result aggregation
│   └── prompts.ts        # Centralized prompt management
└── utils/
    └── logger.ts         # Structured logging
```

## Roadmap

### v0.2
- Auto-select models based on PR size and complexity
- Cost estimation before execution
- Support for file-level inline comments

### v0.3
- Caching layer for repeated reviews
- Custom prompt templates
- Webhook support for external integrations
- Budget controls and spending limits

## License

MIT
