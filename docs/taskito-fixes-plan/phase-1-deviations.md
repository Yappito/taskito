# Phase 1 Deviations

## Interpretation notes (no spec violation)

- **T1.1 allowlist semantics at fetch time:** The phase text says "each resolved IP must
  match an allowlist entry (hostname match OR resolved-IP match against allowlist entries
  that are IPs; at minimum hostname must be allowlisted — keep it simple and strict:
  hostname must be in the allowlist)". Implemented as the union the parenthetical
  describes: a fetch is allowed when the hostname is in `AI_PROVIDER_HOST_ALLOWLIST`, or
  every resolved IP matches an allowlist entry that is an IP. The strict hostname floor
  remains enforced at registration time in `normalizeBaseUrl` (unchanged), so a hostname
  outside the allowlist can never be registered while the allowlist is set; the
  resolved-IP check acts as defense-in-depth when the allowlist is introduced/changed
  after providers were registered. `localhost`/private ranges are never blocked (Bence
  directive 1).

## Test changes

- No existing test was deleted, skipped, or weakened. Assertions were only added.
- `src/lib/__tests__/ai-provider-validation.test.ts`: the `lookup` mock was retyped
  (vi.hoisted, `all: true` overload) to fix the baseline `tsc` error required by T1.7;
  this changes mock plumbing, not assertions.
- `src/lib/__tests__/ai-crypto.test.ts`: env manipulation switched to `vi.stubEnv` /
  `vi.unstubAllEnvs` (required because `@types/node` types `NODE_ENV` as read-only).
