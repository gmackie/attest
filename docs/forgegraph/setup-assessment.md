# Attest delivery through ForgeGraph

Attest is registered as `attest` in the `gmacko` workspace. Its native repository is `https://git.forgegraf.com/gmackie/attest`, with the existing `https://github.com/gmackie/attest` configured as a GitHub mirror. The initial native main is the already merged `893611febb7f03066c5b63cd62354cd4df242221`; no source history was rewritten.

## Checks and publication

`.forge/workflows/ci.toml` runs the checked-in Node 24/pnpm toolchain, contract compilation, strict TypeScript, web build and the full test suite. Anvil is pinned as a workspace development dependency; the build explicitly checks it exists so contract integration tests cannot silently skip because the runner lacks Foundry.

Use the `forge` remote to publish native changesets and PRs. Include the owning Kanbanger issue in the branch and PR; link every PR with `kanbanger issue link` and the current T3 thread. Keep GitHub Actions for the existing GitHub checkout; native CI supplies ForgeGraph revision evidence independently of GitHub Actions quotas.

## Production target

The production `web` target uses platform `cloudflare-workers` on the online `hetzner-fg` agent. Its worker is **attest-demo**, its app directory is the repository root, its build command is `pnpm build`, and its deploy command is `pnpm exec wrangler deploy`. The authoritative domain/bindings/migrations remain in `wrangler.jsonc`.

The configured health URL is `https://attest.gmac.io/api/v3/institutions`. Additional delivery verification must check both v2/v3 institution directories, configured issuer services, live setup rendering and build asset hashes. The existing Cloudflare workspace integration has the matching account ID. `syncSecrets=false` preserves the existing separately provisioned `INSTITUTION_WALLETS` and `INDUSTRY_WALLETS`; deployment does not regenerate institution identities or copy secrets into source.

After all exact-revision checks pass, approve the native PR through `forge pr approve`, verify approval, and merge. Run `forge deploy create production --target web`; record the ForgeGraph deployment ID, source SHA, actual Cloudflare version, complete required target inventory and passing health evidence. The workspace Kanbanger integration is enabled; verify receipt consumption and issue readback rather than assuming linkage implies synchronization.

## Boundaries and recovery

No staging target is configured; staging must receive a separate Worker and domain before deployment. Do not deploy the production wrangler configuration to an unconfigured stage. External Sepolia registry activation and wallet funding remain separate requirements in GMA-727/GMA-750/ATTE-4. The mandate library added in PR #3 is not imported by the Attest website or issuer; its runtime consumer is Gatekeeper.

Use `forge deploy rollback <deployment-id>` for a failed managed deployment and verify live health after rollback. The pre-enrollment successful Cloudflare version was `9891a8cb-1231-446b-bbfb-ef2808704eab`; this identifies the prior artifact, not a ForgeGraph-managed deployment.

## Enrollment repair

Initial CLI onboarding selected the offline `vanuc` node for all stages and the repository adopted that host on its first push. Production and repository CI were explicitly moved to `hetzner-fg`, with repository `ciProvider=manifest`. The guarded repository registry repair affected only Attest. FORGE-52 tracks online-node selection and a supported host-reassignment command; changing a target alone does not update an already pinned repository host.

After a managed deployment, run `node scripts/verify-production.mjs` from its built checkout to verify exact public asset bytes and both configured institution directories. The JSON output records resource hashes and health observations for the delivery issue. Override `ATTEST_VERIFY_URL` only when validating a separately configured environment.
