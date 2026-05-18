---
agent: security-auditor
created: "2026-05-12T15:00:00Z"
scope: taskito-full-stack
type: baseline-security-review
confidence: high
---

# Baseline Security Review — Pre-Feature Audit

## Summary

Full read-only audit of Taskito's current auth, AI provider validation, tRPC patterns, file handling, and infrastructure configuration. Documents both current strengths and gaps that must inform the planned feature implementations (AI streaming, function calling, workflow automation, PWA/offline, command palette, time tracking, sprints/dashboard).

## Current Strengths

- All tRPC routes use `protectedProcedure` or `adminProcedure`; no unauthenticated mutations.
- Project-scoped authorization (`requireProjectAccess`, `requireTaskAccess`) is consistently applied.
- AI provider secrets encrypted at rest with AES-256-GCM; separate master key supported.
- AI provider base URL validated (protocol, no credentials in URL, host allowlist).
- AI provider headers validated against reserved names, CRLF injection, and invalid characters.
- DNS resolution check before outbound fetch to AI providers (SSRF mitigation).
- AI action permissions enforced at proposal time and re-checked at approval time.
- AI bulk actions constrained to selected tasks only.
- Rate limiting on login, AI chat, AI provider tests, and search.
- Argon2id password hashing with bcrypt migration path.
- Login rate limiting per IP and per account+IP.
- Auth secret validated in production (length >= 32, not a known placeholder).
- JWT session with 12-hour max age; role refreshed from DB on each JWT refresh.
- Security headers set at Next.js and nginx layers (CSP, X-Frame-Options, etc.).
- File uploads: magic-byte validation, size limits, sanitized filenames, UUID-based storage paths.
- Nginx rate limiting on /api/ endpoints.

## Gaps and Risks

See main audit output for detailed findings.

## Next Steps

- Track each planned feature area against these baseline findings.
- Re-audit after each feature is implemented.