# Phase 1: AI provider security (SSRF + authz + secret handling)

## Context

Quality-pass criticals S1/S2/S5 and highs S3/S4/C5 (secret part) from
`docs/taskito-fixes-plan/00-overview.md`. Bence's directives 1 and 2 apply:
private/loopback providers are intentional and must work; user provider
registration stays open; users must never be able to decrypt already-saved API keys.

## Scope (files you may touch)

- `src/lib/ai-provider-validation.ts`
- `src/lib/secret-crypto.ts`
- `src/server/services/ai/provider-openai-compatible.ts`
- `src/server/services/ai/provider-anthropic.ts`
- `src/server/routers/ai.ts`
- `src/lib/auth.ts` (only the invalid-secret blocklist)
- `.env.example` (only AUTH_SECRET placeholder note if needed)
- Tests: `src/lib/__tests__/ai-provider-validation.test.ts`, `src/lib/__tests__/ai-crypto.test.ts`,
  `src/server/routers/__tests__/ai-router.test.ts`, new `src/server/services/ai/__tests__/provider-redirect.test.ts`

## Tasks

### T1.1 — DNS re-check + private/loopback allowed, allowlist enforced at fetch
In `src/lib/ai-provider-validation.ts` (`assertAiProviderBaseUrlFetchAllowed`, line 66):
- Keep resolving with `lookup(hostname, { all: true, verbatim: true })`.
- Allow loopback (127.0.0.0/8, ::1) and private ranges (10/8, 172.16/12, 192.168/16, fc00::/7) — do NOT block them. Bence directive 1.
- When `AI_PROVIDER_HOST_ALLOWLIST` is set: each resolved IP must match an allowlist entry (hostname match OR resolved-IP match against allowlist entries that are IPs; at minimum hostname must be allowlisted — keep it simple and strict: hostname must be in the allowlist).
- Reject empty resolution (already done).
- Return the normalized URL.

### T1.2 — Block redirects, never leak secrets
In both provider adapters:
- `src/server/services/ai/provider-openai-compatible.ts` (lines ~72 and ~123) and
  `src/server/services/ai/provider-anthropic.ts` (lines ~58 and ~110):
  - Pass `redirect: "manual"` to every `fetch`.
  - After fetch, if `response.status >= 300 && response.status < 400` → throw an
    error ("AI provider returned a redirect, which is not allowed").
  - The Authorization / x-api-key header must only ever be sent to the validated
    base URL host — never follow redirects with the secret.

### T1.3 — revealProviderSecret admin-only
In `src/server/routers/ai.ts` `revealProviderSecret` (line 546):
- Require `requireGlobalAdmin` for ALL scopes (user, project, shared). Remove the
  per-scope branch so a normal user — even the owner of a user-scoped provider —
  cannot decrypt a stored key. Bence directive 2.
- Keep `getVisibleProviderOrThrow` call (404-style protection stays).

### T1.4 — testProvider ai_manage for project scope
In `src/server/routers/ai.ts` `testProvider` (line 559):
- After `getVisibleProviderOrThrow`, for `provider.scope === "project"` require
  `requireProjectAccess(..., provider.projectId, { permission: "ai_manage" })`
  (mirror `updateProvider` at line 461).
- Keep the existing shared-scope admin check.

### T1.5 — Master key policy
In `src/lib/secret-crypto.ts` (`getMasterKey`, line 7):
- In production (`process.env.NODE_ENV === "production"`): if `AI_SECRET_MASTER_KEY`
  is unset → throw (no AUTH_SECRET fallback). This makes the env var effectively
  required in prod.
- In development: keep the `SHA256(AUTH_SECRET)` fallback but emit
  `console.warn("AI_SECRET_MASTER_KEY is not set; falling back to SHA256(AUTH_SECRET) for secret encryption")`.
  (console.warn in a lib file is acceptable; do not use console.log.)
- Fallback length check: if AUTH_SECRET fallback is used and AUTH_SECRET is missing,
  throw as today.

### T1.6 — AUTH_SECRET blocklist
In `src/lib/auth.ts` `invalidSecrets` (line 11):
- Add `"replace-with-a-cryptographically-strong-secret"` (the `.env.example` value).
- Add `"change-me"`.

### T1.7 — Fix the tsc error in ai-provider-validation.test.ts
Line 39: `lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }])` — the
mock type expects a single `LookupAddress` because `vi.mocked(lookup)` resolves to
the non-`all` overload. Fix by typing the mock as
`vi.mocked<typeof lookup>` with the `all: true` overload, or cast the mock:
`(lookupMock as Mock).mockResolvedValue([...])`. Use the cleanest type-safe approach.

## Definition of done

1. `assertAiProviderBaseUrlFetchAllowed` allows loopback/private IPs, enforces the
   allowlist when set, rejects empty resolution.
2. Provider fetches never follow redirects and never send secrets off-host.
3. `revealProviderSecret` requires global admin for all scopes.
4. `testProvider` requires `ai_manage` for project-scoped providers.
5. Production without `AI_SECRET_MASTER_KEY` throws; dev falls back with a warning.
6. `invalidSecrets` includes the `.env.example` placeholder.
7. Tests: existing `ai-provider-validation.test.ts`, `ai-crypto.test.ts`, `ai-router.test.ts` pass;
   new cases for: allowlist enforcement, redirect rejection (mock fetch 302 → error, and assert
   no Authorization header sent on redirect), reveal gated to admin, testProvider project-scope gate,
   master key production throw / dev fallback.
8. `npm test` (all), `npx tsc --noEmit`, `npm run build` all pass.
