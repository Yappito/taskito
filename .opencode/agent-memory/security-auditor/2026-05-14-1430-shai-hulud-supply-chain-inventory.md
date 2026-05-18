---
agent: security-auditor
created: 2026-05-14T14:30:00Z
scope: taskito-repo-dependencies
type: supply-chain-inventory
confidence: high
---

# Shai-Hulud Supply Chain Audit – Dependency Inventory

## Summary
Full dependency inventory of taskito repo for Shai-Hulud npm supply-chain compromise cross-reference. No packages matching known Shai-Hulud compromise indicators were found in the initial scan. One confirmed high-severity vulnerability in Next.js (installed 15.5.15, fix available at >=15.5.18). The repo has ~732 total packages (228 prod, 452 dev, 150 optional) across multiple high-risk ecosystems.

## Evidence

### Known Vulnerability (npm audit)
- **next@15.5.15** – 12 advisories (1 HIGH bucket): SSRF via WebSocket upgrades (CVSS 8.6), middleware/proxy bypass (CVSS 8.1, 7.5×2), DoS via Server Components (CVSS 7.5), XSS via CSP nonces (CVSS 4.7), cache poisoning (CVSS 5.4, 3.7). Fix: upgrade to >=15.5.18.

### Direct Production Dependencies (package.json)
| Package | Version | Ecosystem/Risk |
|---------|---------|----------------|
| @auth/prisma-adapter | ^2.9.0 | Auth |
| @node-rs/argon2 | ^2.0.2 | Crypto (native) |
| @prisma/client | ^6.6.0 | ORM/DB |
| @radix-ui/react-slot | ^1.2.4 | UI |
| @t3-oss/env-nextjs | ^0.12.0 | Config |
| @tanstack/react-query | ^5.72.2 | Data fetching |
| @trpc/client | ^11.3.2 | API |
| @trpc/next | ^11.3.2 | API |
| @trpc/react-query | ^11.3.2 | API |
| @trpc/server | ^11.3.2 | API |
| bcryptjs | ^3.0.2 | Crypto |
| class-variance-authority | ^0.7.1 | UI |
| clsx | ^2.1.1 | Utility |
| d3 | ^7.9.0 | Visualization |
| elkjs | ^0.9.3 | Layout |
| lucide-react | ^0.501.0 | UI |
| next | ^15.3.1 | Framework (HIGH RISK) |
| next-auth | ^5.0.0-beta.25 | Auth (HIGH RISK) |
| rbush | ^4.0.1 | Data structure |
| react | ^19.1.0 | UI Framework |
| react-dom | ^19.1.0 | UI Framework |
| react-markdown | ^10.1.0 | Markdown |
| remark-gfm | ^4.0.1 | Markdown |
| superjson | ^2.2.2 | Serialization |
| tailwind-merge | ^3.2.0 | UI |
| zod | ^3.24.4 | Validation |

### Direct Dev Dependencies
| Package | Version | Ecosystem/Risk |
|---------|---------|----------------|
| @playwright/test | ^1.58.2 | E2E testing |
| @tailwindcss/postcss | ^4.1.4 | CSS |
| @types/d3 | ^7.4.3 | Types |
| @types/node | ^22.15.3 | Types |
| @types/rbush | ^4.0.0 | Types |
| @types/react | ^19.1.2 | Types |
| @types/react-dom | ^19.1.2 | Types |
| eslint | ^9.25.1 | Linting |
| eslint-config-next | ^15.3.1 | Linting |
| postcss | ^8.5.3 | CSS |
| prisma | ^6.6.0 | ORM/DB |
| tailwindcss | ^4.1.4 | CSS |
| tsx | ^4.19.4 | Runtime |
| typescript | ^5.8.3 | Language |
| vitest | ^4.1.0 | Testing |

### Notable Transitive Dependencies (Security-Relevant)
| Package | Version | Notes |
|---------|---------|-------|
| @auth/core | 0.41.1/0.41.2 | Auth.js core |
| @panva/hkdf | 1.2.1 | Crypto (HKDF) |
| jose | ^6.0.6 | JWT/JWK |
| oauth4webapi | ^3.3.0/3.8.5 | OAuth |
| preact | 10.24.3 | Auth.js internal |
| sharp | 0.34.5 | Image processing (native) |
| esbuild | 0.27.4 | Bundler (native) |
| @img/sharp-* | 0.34.5 | Native image libs |
| @node-rs/argon2-* | 2.0.2 | Native crypto libs |
| @next/swc-* | 15.5.15 | Native SWC bindings |
| @tailwindcss/oxide-* | 4.2.1 | Native Tailwind engine |
| @rolldown/binding-* | 1.0.0-rc.17 | Native bundler |
| @unrs/resolver-binding-* | 1.11.1 | Native resolver |
| @emnapi/core | 1.10.0 | WASM runtime |
| @emnapi/runtime | 1.10.0 | WASM runtime |
| @emnapi/wasi-threads | 1.2.1 | WASM runtime |
| @napi-rs/wasm-runtime | 0.2.12/1.1.4 | WASM runtime |
| effect | 3.21.0 | Effect system (Prisma dep) |
| c12 | 3.1.0 | Config (Prisma dep) |
| giget | 2.0.0 | Git template (Prisma dep) |
| playwright | 1.58.2 | Browser automation |
| vitest | 4.1.0 | Test framework |
| vite | 8.0.10 | Build tool |
| rolldown | 1.0.0-rc.17 | Bundler |

### High-Risk Ecosystems Present
1. **Next.js / React** – Full-stack framework with SSR, middleware, API routes
2. **Auth.js (next-auth)** – Authentication with OAuth, session management
3. **Prisma** – ORM with native engine binaries
4. **tRPC** – Type-safe API layer
5. **ESLint** – Code analysis with plugin ecosystem
6. **Vite / Vitest** – Build and test tooling
7. **Playwright** – Browser automation (dev only)
8. **Native binary packages** – argon2, sharp, SWC, Tailwind oxide, rolldown, unrs-resolver

## Details
- Lockfile: package-lock.json v3, 11028 lines, ~732 total packages
- All resolved URLs point to registry.npmjs.org (no alternate registries observed)
- No typosquatting-like package names detected in initial scan
- No packages with suspicious version patterns (0.0.x, extremely recent publish dates with high version jumps)
- The .opencode/ directory has its own package-lock.json with a small set of dependencies (opencode-ai, msgpackr, etc.)

## Next Steps
- Cross-reference all 732 package names against the Shai-Hulud compromised package list once supplied
- Upgrade Next.js to >=15.5.18 to address known HIGH-severity vulnerabilities
- Review native binary packages for integrity (argon2, sharp, SWC, oxide, rolldown, unrs-resolver)
- Verify integrity hashes in lockfile against npm registry for all production dependencies
- Review .opencode/package-lock.json separately for supply chain concerns