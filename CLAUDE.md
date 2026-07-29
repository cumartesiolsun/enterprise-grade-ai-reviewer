# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Enterprise-Grade AI Reviewer — a GitHub Action that runs multiple LLM models in parallel as independent "scanners" to review PR diffs, then uses a separate "judge" model to aggregate and deduplicate findings. Supports two output modes: `summary` (single PR comment) and `inline` (per-line review comments on the diff). Uses OpenRouter as the LLM gateway.

## Commands

```bash
npm run build          # ncc bundles src/index.ts directly → dist/ (index.js, index.js.map, licenses.txt only)
npm run build:tsc      # TypeScript compile only (emits to build/, gitignored)
npm run dev            # Run with tsx (requires INPUT_* env vars)
npm run start          # Run bundled dist/index.js
npm run lint           # ESLint (flat config: eslint.config.js, typescript-eslint recommended)
npm run typecheck      # tsc --noEmit
npm run test           # Vitest (run once)
npm run test:watch     # Vitest (watch mode)
```

## Development Workflow

- Requires Node >=20
- `dist/index.js` is committed to the repo (GitHub Actions runs it directly). After any source change, run `npm run build` and commit the updated `dist/` alongside your source changes.
- To test locally: export `INPUT_OPENROUTER-API-KEY`, `INPUT_GITHUB-TOKEN`, `INPUT_SCANNER-MODELS`, `INPUT_JUDGE-MODEL`, `GITHUB_REPOSITORY`, and `PR_NUMBER` (or `GITHUB_REF_NAME`) as environment variables, then `npm run dev`.

## Architecture

```
PR Trigger → Diff Normalization → Parallel Scanners → Judge Aggregation → Output (summary comment OR inline review)
```

**Entry point**: `src/index.ts` — parses GitHub Action inputs, orchestrates the full pipeline, handles fallback error comments.

### Core Modules

- **`src/github/diff.ts`** — Fetches PR files via Octokit, normalizes and truncates diffs (max_files, max_chars). Breaks at file boundaries to avoid mid-diff cuts. Also exports `parseDiffHunks()` and `isLineInDiff()` for inline mode hunk validation.
- **`src/github/comments.ts`** — Summary mode: creates/updates a single PR comment via HTML marker. Inline mode: `postInlineReview()` validates findings against diff hunks, posts matched findings as `octokit.pulls.createReview()` comments, unmatched findings go to review body. Falls back to summary if no findings match.
- **`src/openrouter/client.ts`** — HTTP client for OpenRouter API with exponential backoff retry (1s, 2s, 4s) on 429/5xx. No retry on 400.
- **`src/review/scanner.ts`** — Runs all scanner models in parallel via `Promise.all()`. Each scanner sees only the diff, never other scanners' output. Empty or "LGTM" responses → SKIPPED status.
- **`src/review/judge.ts`** — Aggregates scanner results. Summary mode: free-form text. Inline mode: instructs judge to output JSON `InlineFinding[]`, parses with `parseInlineFindings()` (strips markdown fences, validates fields). JSON parse failure → `findings: undefined` → triggers summary fallback.
- **`src/review/prompts.ts`** — Centralized prompt templates. Language-aware (tr/en). Scanner prompts are role-specialized (v0.4: `security`/`logic`/`performance`/`general` via `ScannerRole`) with a shared evidence-format block and the `NO_FINDINGS` sentinel; prompts must stay language/framework-agnostic. Untrusted content (diff, scanner reviews, PR context) is wrapped in escaped `<diff>`/`<scanner_review>`/`<pr_context>` delimiters. Inline mode has separate `buildJudgeSystemPromptInline`/`buildJudgeUserPromptInline` that request structured JSON output; the summary judge emits a four-section structure (Verdict / Findings / Impacted Flows / Manual Verification Checklist). Scanner prompts are unchanged across modes.
- **`src/utils/logger.ts`** — Structured logger with levels (debug/info/warn/error), JSON context, `timed()`/`timedAsync()` helpers. Controlled by `LOG_LEVEL` env var.

### Gotchas

- **Import extensions**: All imports must use `.js` extensions (NodeNext module resolution)
- **Input env vars preserve hyphens**: `github-token` → `INPUT_GITHUB-TOKEN`, not `INPUT_GITHUB_TOKEN`
- **Rebuild dist before committing**: `dist/index.js` is bundled with `@vercel/ncc` and committed — stale bundles break the action. CI enforces this with a dist-drift gate (`git diff --exit-code dist/` after a fresh build), so a PR with a stale bundle fails CI.
- **`auto-select-models` not implemented**: Setting it to `true` throws immediately (MVP limitation)
- **Strict TS**: `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are enabled — use `undefined` checks on indexed access
- **Minimal runtime dependencies**: official `@octokit` packages only (`@octokit/rest` + `plugin-retry` + `plugin-throttling`, composed in `src/github/client.ts`) — do not add runtime dependencies outside the `@octokit` family

### Configuration

All configuration comes from GitHub Action inputs (defined in `action.yml`), read as `INPUT_*` environment variables. Default language is Turkish (`tr`). Default `review-mode` is `summary`. Token defaults: scanner 2000, judge 4000.

## Release Workflow

This project uses a floating `latest` tag so consumers can pin to `@latest`. On every release:

```bash
git tag v0.X.Y                      # 1. Create fixed version tag
git tag -f latest v0.X.Y            # 2. Move latest to the new version
git push origin v0.X.Y              # 3. Push fixed tag (no force — prevents accidental overwrite)
git push origin latest -f           # 4. Force-push latest (must force since it moves each release)
```

- **Fixed tags** (`v0.1.0`, `v0.2.0`, `v0.3.0`, …) are never moved — they stay for rollback and changelog purposes.
- **`latest` tag** is force-updated to the latest fixed tag's commit on every release.
- Run `npm run build` and commit `dist/` **before** tagging.

## Code Conventions

- camelCase for variables/functions, PascalCase for types/interfaces
- Explicit type annotations on function signatures
- Error handling: try-catch with structured logging, fallback comment posting on failure
- All inter-module types are co-located with their module and re-exported
