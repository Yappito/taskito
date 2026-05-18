---
agent: security-auditor
created: 2026-05-18T14:30:00Z
scope: supply-chain
type: threat-intelligence-review
confidence: high
---

# Shai-Hulud npm Supply-Chain Attack — Taskito Exposure Assessment

## Summary

The Shai-Hulud campaign (CVE-2026-45321, GHSA-g7cv-rxg3-hmpx) is a critical npm supply-chain attack attributed to TeamPCP. On 2026-05-11, 84 malicious versions across 42 `@tanstack/*` Router/Start packages were published with valid SLSA Build Level 3 provenance attestations, using stolen OIDC tokens from the TanStack/router CI. The broader campaign also compromised Mistral AI, Guardrails AI, UiPath, OpenSearch, Bitwarden CLI, and SAP packages (160+ npm packages per Endor Labs; 416 artifacts across npm/PyPI per Socket).

## Taskito Exposure Assessment

**Result: NOT AFFECTED by the TanStack Router compromise (CVE-2026-45321).**

Taskito uses only two `@tanstack/*` packages, both from the Query ecosystem:
- `@tanstack/react-query` 5.90.21
- `@tanstack/query-core` 5.90.20

Neither package appears in the CVE-2026-45321 affected-products list, which exclusively covers TanStack Router/Start ecosystem packages (router, start, history, devtools, adapters, etc.). The Query ecosystem was not compromised.

No other taskito dependencies (direct or transitive) match the known compromised package names (Mistral AI, Guardrails AI, UiPath, OpenSearch, Bitwarden CLI, SAP).

## Evidence

- Sources: NVD CVE-2026-45321, GHSA-g7cv-rxg3-hmpx, BleepingComputer (2026-05-12), OSV.dev
- Affected packages: 42 `@tanstack/*` Router/Start packages with specific malicious versions (see CVE for full list)
- Malicious indicator: `optionalDependencies` containing `"@tanstack/setup": "github:tanstack/router#79ac49eedf774dd4b0cfa308722bc463cfe5885c"`
- Payload: `router_init.js` (~2.3 MB obfuscated credential stealer)
- Publish window: 2026-05-11 19:20–19:26 UTC
- npm audit: no Shai-Hulud findings; only a pre-existing Next.js high-severity advisory

## Unresolved Questions

- The full list of 160+ npm packages from Endor Labs' report was not accessible for exhaustive cross-check. Taskito's direct dependencies are confirmed clear, but transitive dependencies should be verified against the full list once published.
- The broader Shai-Hulud campaign has had multiple waves since September 2025; earlier waves may have affected different packages.