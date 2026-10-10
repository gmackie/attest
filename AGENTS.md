# AGENTS.md

## Product boundary

Attest is an open assurance protocol and reference implementation. Keep the protocol kernel independent of any one chain, marketplace, credential brand, or customer workflow.

## Engineering rules

- Use Effect 4 for fallible and asynchronous application flows. Pure policy/authority functions may remain pure and receive Effect wrappers at service boundaries.
- Keep cryptographic claims precise. A local policy match is not a zero-knowledge proof; label it accordingly.
- Never place raw insurance, audit, identity, or other sensitive evidence on-chain. Contracts anchor commitments and verification receipts only.
- Preserve issuer boundaries, subject bindings, validity, scope, and provenance. Do not combine individually valid facts into an unsupported conclusion.
- Tests must cover negative joins: mismatched subjects, stale evidence, unauthorized issuers, duplicate evidence, and insufficient hidden values.
- POD/GPC is a proof-of-concept backend. Its upstream implementation is beta and not audited; do not describe it as production-ready.
- Domain packs are examples and profiles. They do not speak for ACORD, AICPA, ISO, accreditation bodies, insurers, or regulators.

## Web UI

- Build controls and surfaces with `@cloudflare/kumo` components (Button, InputGroup, Badge, Banner, Collapsible, LayerCard). Use app CSS for layout and illustration, not replacement control implementations.
- Keep the Kumo Tailwind `@source` path relative to `apps/web/src/styles.css`: `../node_modules/@cloudflare/kumo/dist`.
