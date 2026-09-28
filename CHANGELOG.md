# Changelog

All notable changes to this project are documented here. Versions follow the
fixed release tags (`v0.X.Y`); the floating `latest` / `v0` tags point at the
newest one.

## v0.6.0

### Added
- `judge-reasoning-effort` input (default `high`): sent as OpenRouter
  `reasoning: { effort }` on the aggregation judge call **and** the judge scan.
- `scanner-reasoning-effort` input (default `medium`): sent as
  `reasoning: { effort }` on every regular scanner call and the rescue pass.
- `judge-provider-sort` input (default `price`; also `throughput`, `latency`):
  sent as `provider: { sort, allow_fallbacks: true }` on both judge calls
  (aggregation and judge scan). An explicitly empty value sends no `provider`
  block.
- Effort and provider-sort values are validated at startup
  (`none|low|medium|high|xhigh` / `price|throughput|latency`, case-insensitive);
  an invalid value fails the action with a message listing the valid values.

### Changed
- **Token defaults raised to make room for reasoning:** `max-tokens-judge`
  4000 → **32000**, `max-tokens-scanner` 2000 → **8000**. Budget-based
  reasoning models (e.g. Anthropic via OpenRouter) reserve a share of
  `max_tokens` for reasoning (`high` = 80%, `medium` = 50%); with the old
  defaults the judge would have had ~800 tokens left for its answer. At the new
  defaults that is ≈6400 (judge, `high`) and ≈4000 (scanner, `medium`).
- Request bodies now carry `reasoning` from the first attempt (previously only
  on retries after an empty response). A 400 on any request carrying
  `reasoning` is retried without the field, so a provider that rejects the
  effort parameter never fails the review. `provider.require_parameters` is
  never set.
- **`timeout-ms` default raised** 180000 → **600000** (10 minutes) so
  reasoning at the new token budgets fits in one attempt.
- **Judge calls retry a timeout at most once** (aggregation and judge scan),
  so a stuck judge call is abandoned after ~2 × `timeout-ms` instead of up to
  4 ×. Scanner calls keep the full retry budget. The limit counts timeouts
  only — empty-response, 429/5xx and network-error retries are unaffected.
- Empty-content retries lower the effort instead of always using `low`:
  judge calls (aggregation and judge scan) drop it at most to `medium`, scanner
  calls drop it to `low` as before; a lower configured effort is never raised
  and `none` stays `none`.

### Fixed
- Empty-content retries never shrink `max_tokens`: a configured budget above
  the 16000 doubling cap (such as the new 32000 judge default) is kept instead
  of being cut to 16000.

### Upgrade notes
- Workflows that pin `max-tokens-judge` / `max-tokens-scanner` to the old
  values keep them — lower the effort inputs along with them (or raise the
  budgets) to avoid `[TRUNCATED]` reviews on reasoning models.
- `max_tokens` is a ceiling, not a charge: cost follows tokens actually
  generated, but higher effort does generate more reasoning tokens and takes
  longer.
- Scanner calls can now wait up to 4 × 10 minutes on repeated timeouts. If
  your workflow sets a job-level `timeout-minutes`, make sure it leaves room
  for that, or pin a lower `timeout-ms`.
- Only message `content` is parsed for findings; model `reasoning` output is
  never mixed into the review (unchanged, now covered by tests).

## v0.5.3
- Verdict classes: all-clear → deterministic APPROVE (no judge call); no
  findings + a failed scanner → INCOMPLETE and a failed run; `DEGRADED`
  headline when a findings run lost a scanner.

## v0.5.2
- Visible `[TRUNCATED]` marker when the judge hits `max-tokens-judge`.

## v0.5.1
- Action runtime migrated to `node24`; fail fast on `content_filter`.

## v0.5.0
- Empty-response recovery, automatic role rescue, always-on judge scan,
  coverage reporting, `min-successful-scanners` gate.

## v0.4.0
- Role-specialized scanners, evidence-based findings, structured judge output,
  PR context injection.

## v0.3.0
- Inline review mode and source model attribution.
