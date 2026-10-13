# Token lifecycle animations in the Attest demos

This guide documents the educational token visualizations added after the
experimental Claim NFT / $ATTEST / dynamic ERC-721 reference implementation.

## Surfaces

- Homepage: existing three-stage trust hero grows to four states, explicitly
  labeling optional test-token conversion. A seven-stage, interactive animated
  lifecycle follows the main hero.
- Browser demo directory: a **fifth** browser experience links to the
  $ATTEST Economy Lab and a complete compact interactive lifecycle is visible.
- All four industry browser proof demos: collapsed, optional stepper showing
  how token conversion differs from their ordinary verification receipts.
- Wallet guide: optional seven-stage token walkthrough alongside its separate
  five-stage private credential guide.
- Testnet launcher, contractor and industry journeys: collapsed optional
  token walkthrough that emphasizes none of these existing journeys mint
  $ATTEST.
- `#/economy`: visible lifecycle stepper + real GPC/synthetic-status
  interactive claim demonstration + an animated, entirely local color-mixing
  transfer.

The shared React component is `apps/web/src/TokenStory.tsx`, with responsive
styles in `token-story.css`. Its pure, deterministic state model lives in
`packages/demo/src/token-story.ts` and is exercised by
`packages/demo/test/token-story.test.ts`.

## Seven scenes and critical truth boundaries

1. **Private claim:** an issuer signs a claim/POD. Its contents remain in
   wallet/evidence custody. It is NOT automatically an ERC-721.
2. **Optional public Claim NFT:** subject opts in to an opaque commitment
   on-chain; the token is nontransferable and does not confer a right to
   someone else's professional qualification.
3. **Private proof:** qualification predicate can be established without
   revealing the signed private score.
4. **$ATTEST conversion:** fixed policy release is shown as 200 *fictional*
   units. A single entitlement is spent once. Original private claim
   survives the conversion.
5. **ERC-20 transfer:** Alice sends 50 of 200 units; recipient Bob already
   has 80 gold units. Four-channel composition is conserved and transferred
   proportionally (Bob 80 → 130). Credentials DO NOT move.
6. **Living economic ERC-721:** optionally nontransferable passport artwork
   updates as token balances and provenance mixes change. The colors
   represent historical economic lineage, not an objective trustworthiness
   score.
7. **Revocation:** issuer revocation blocks future authorizations; earlier
   $ATTEST mint/transfer history remains unless a separate explicit
   financial instrument rule changes it.

The **trusted bridge** comparison is the existing holder POD/GPC proof
verified off-chain, followed by EIP-712 mint authorization. The **native ZK**
comparison is a separate Groth16 circuit proving inclusion in an
issuer-maintained Poseidon root, checked by an on-chain test-only verifier.
Native-ZK does NOT yet consume the existing private POD as its input and its
proving setup is deliberately insecure. Do not imply either test path is
deployed as a valuable token or guarantees actual issuer honesty.

## Accessibility and safe interaction

- Scenes are **manual by default**; play/pause controls are optional.
- A stage selector and Previous/Next buttons support keyboard navigation.
- Play automatically turns off on manual selection, when the last scene is
  reached, or when the OS requests reduced motion.
- CSS `prefers-reduced-motion` disables transitions, packet movement and
  animated entrances. All text, token quantities and proof-path distinctions
  remain readable without motion.
- Dynamic stage explanations have a polite live region. The Economy Lab
  explicitly announces the fictional transfer count as its wallets change.
- The diagrams deliberately use fixed, synthetic amounts and color channels;
  never derive public artwork directly from a confidential claim or score.

## Validation

- `pnpm typecheck` and `pnpm --filter @attest/web build` catch React/Kumo
  and JSX integration issues.
- `pnpm exec vitest run packages/demo/test/token-story.test.ts` asserts
  scene ordering, correct pre-conversion state, conservation across transfer,
  proof-path separation, revocation semantics and invalid scene rejection.
- `pnpm check` runs the repository-wide CI suite.
- Before launch, manually verify desktop/mobile responsive layout, screen
  reader output, keyboard navigation, reduced-motion preference, autoplay
  cleanup and visual contrast.
