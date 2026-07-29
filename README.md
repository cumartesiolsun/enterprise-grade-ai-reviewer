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
│                      Review Output                                  │
│       summary: Single PR Comment (marker-based update)              │
│       inline:  Per-line review comments on PR diff                  │
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
      - uses: cumartesiolsun/enterprise-grade-ai-reviewer@latest
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          scanner-models: |
            anthropic/claude-3-haiku
            openai/gpt-4o-mini
            google/gemini-flash-1.5
          judge-model: anthropic/claude-3-sonnet
```

> **⚠️ Default language is Turkish.** The review output language defaults to `tr` (Turkish). If you want reviews in English (or another language), set the `language` input explicitly:
>
> ```yaml
>           language: en
> ```

### Inline Review Mode

Use `review-mode: inline` to post findings as line-level comments directly on the PR diff instead of a single summary comment:

```yaml
      - uses: cumartesiolsun/enterprise-grade-ai-reviewer@latest
        with:
          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          scanner-models: |
            anthropic/claude-3-haiku
            openai/gpt-4o-mini
            google/gemini-flash-1.5
          judge-model: anthropic/claude-3-sonnet
          review-mode: inline
```

In inline mode:
- The judge produces structured JSON findings with file paths and line numbers
- Each finding is posted as an inline comment on the exact line in the PR diff
- Findings that cannot be matched to the diff are included in the review summary
- If JSON parsing fails, the action falls back to summary mode automatically

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
| `max-tokens-scanner` | No | `2000` | Max tokens per scanner response |
| `max-tokens-judge` | No | `4000` | Max tokens for judge response |
| `comment-marker` | No | `ENTERPRISE_AI_REVIEW` | Marker for finding/updating PR comment |
| `review-mode` | No | `summary` | Output mode: `summary` (single comment) or `inline` (per-line comments) |
| `exclude-paths` | No | lockfiles, minified/generated files (see below) | Glob patterns for files to skip (multiline or CSV). Set to `none` to disable exclusions |

### Excluding Files from Review

The `exclude-paths` input filters files out of the diff before it is sent to the scanners. It accepts glob patterns in multiline or CSV format:

```yaml
          exclude-paths: |
            **/*.generated.ts
            docs/**
```

By default, the following patterns are excluded:

```
**/package-lock.json
**/yarn.lock
**/pnpm-lock.yaml
**/*.min.js
**/*.min.css
**/*.snap
**/dist/**
**/build/**
**/vendor/**
```

Passing your own patterns replaces the defaults. To disable exclusions entirely, set the literal value `none`:

```yaml
          exclude-paths: none
```

## Action Outputs

The action exposes outputs that downstream steps can consume:

| Output | Description |
|--------|-------------|
| `total-tokens` | Total LLM tokens consumed across all scanner and judge calls |
| `findings-count` | Number of findings in the final review |
| `scanners-failed` | Number of scanner models that failed |

```yaml
      - uses: cumartesiolsun/enterprise-grade-ai-reviewer@latest
        id: review
        with:
          # ...
      - run: echo "Used ${{ steps.review.outputs.total-tokens }} tokens"
```

## Security & Hardening

### Pin the action to a commit SHA

Per [GitHub's security hardening guide](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions), the safest way to consume any third-party action is to pin it to a full commit SHA — the only reference that is truly immutable:

```yaml
      - uses: cumartesiolsun/enterprise-grade-ai-reviewer@<full-commit-sha>  # e.g. @b3ec50e...
```

Using `@latest` is the convenient alternative, but note that `latest` is a **force-moved tag**: it is updated to point at every new release, so you are trusting future releases of this action sight unseen. Fixed version tags (`@v0.3.0`) sit in between — they are never moved by policy, but tags are not cryptographically immutable the way a SHA is.

### Avoid paying for superseded runs

Add a `concurrency` group so that pushing new commits to a PR cancels the in-flight review of the old commits — each run costs real LLM tokens:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    concurrency:
      group: ai-review-${{ github.ref }}
      cancel-in-progress: true
```

### Never use `pull_request_target`

**Do not trigger this action with `pull_request_target`.** That event runs with a write-scoped token and access to repository secrets at a time chosen by the PR author — combining attacker-controlled diff content with a privileged token and your OpenRouter key is exactly the setup workflow-injection attacks exploit. Use the plain `pull_request` event, as shown in all examples above.

### Fork PRs

Pull requests from forks do not receive repository secrets on `pull_request` events, so `OPENROUTER_API_KEY` will be unavailable and the review will not run for fork PRs. This is a GitHub security feature, not a bug in the action.

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

## Scanner Status Tracking

PR comments show the status of each scanner model:

```
### Sources

- `anthropic/claude-3-haiku`: ✅ OK
- `openai/gpt-4o-mini`: ✅ OK
- `google/gemini-flash-1.5`: ⏭️ SKIPPED (empty/LGTM)
- `x-ai/grok-beta`: ❌ FAILED (timeout)
```

**Status Types:**
- `✅ OK` — Scanner returned meaningful review content
- `⏭️ SKIPPED (empty/LGTM)` — Scanner returned empty response or "looks good"
- `❌ FAILED (error)` — Scanner failed (timeout, 429, 5xx, etc.)

This helps identify which models are working and which are having issues.

## Retry Policy

API calls follow this retry policy:
- **Retry**: 429 (rate limit), 5xx (server errors), network/timeout errors
- **No Retry**: 400 (bad request) — fails immediately
- **Backoff**: Exponential (1s, 2s, 4s)
- **Max Retries**: 3

## Failure Behavior

- **Scanner failures are tolerated**: a failed scanner is reported as `❌ FAILED` in the Sources section and the remaining scanners' output is still aggregated.
- **Judge failure fails the action run**: if the judge model fails after retries, the action exits with a non-zero status and the check turns red. (Previous versions posted the error text as the review and stayed green — that silent-failure behavior has been removed.)

## Limitations (v0.3)

- `auto-select-models` is not implemented (placeholder for future versions)
- No caching of results across runs
- No support for review suggestions (only comments)
- Inline mode depends on LLM producing correct file paths and line numbers
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

### Shipped in v0.3
- ✅ Inline review mode (per-line comments on the diff)
- ✅ Source model attribution in findings

### Planned
- Caching layer for repeated reviews
- Custom prompt templates
- Webhook support for external integrations
- Budget controls and spending limits

## Development & CI

- CI runs on every push to `main` and every pull request: `typecheck`, `lint`, `test`, `build`, plus a **dist-drift check** — the committed `dist/` bundle must match a fresh build (`npm run build`), otherwise CI fails.
- Releases are automated: pushing a `v*` tag triggers the release workflow, which verifies the tagged commit's `dist/` is up to date, force-moves the floating `latest` tag to the new release, and creates a GitHub Release with generated notes.

## License

MIT
