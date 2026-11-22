# MandateAccount: ERC-4337 mandate-limited spending with Gatekeeper co-signature (experimental)

> **Status: experimental, testnet only, not audited. A security review is required before any value
> beyond testnet.** The contract and client refuse chain id 1. The bundled `TestStablecoin` is a
> test-only ERC-20 and is never shipped to the web bundle.

`contracts/src/MandateAccount.sol` is an ERC-4337 (EntryPoint v0.7, `PackedUserOperation`) smart
account. It lets an agent session key spend one ERC-20 stablecoin, but only inside an owner-registered
[Attest agent mandate](agent-mandates.md) chain and only when a Gatekeeper decision co-signs the exact
operation. The client lives in `packages/chain-evm/src/mandates.ts`.

## Roles

| Role | Key | Can | Cannot |
| --- | --- | --- | --- |
| Owner | EOA, direct calls only | register/revoke mandates and session keys, set Gatekeeper/guardian/owner, unpause, arbitrary `execute` (withdraw) | act through the EntryPoint (owner operations are never user operations) |
| Agent session key | secp256k1, bound to one mandate | sign user operations that transfer the mandate's token to an allowlisted payee | make arbitrary calls, spend without a Gatekeeper co-signature, change policy |
| Gatekeeper | secp256k1 decision key | co-sign one specific transfer | spend alone, change policy |
| Pause guardian | address | `pause()` | unpause, move funds, change policy |
| EntryPoint | v0.7 contract | call `validateUserOp` / `executeUserOp` | anything else (all other entry points are owner-only) |

## On-chain policy (mirrors an Attest mandate)

Each mandate is registered under its **mandate digest** (SHA-256 of the canonical mandate JSON,
`documentDigest` in `@attest/mandates`) with: parent digest (zero for a root), token, per-action cap,
aggregate cap, validity window (seconds; the client rounds `validFrom` up and `validUntil` down so the
on-chain window never widens) and a payee allowlist. Only commitments and limits are stored; no mandate
contents, identities or evidence go on-chain.

Registration enforces attenuation like `verifyMandateChain`: a child has the same token, caps no larger
than its parent, a validity window inside its parent's, payees that are a subset of its parent's, and a
depth below 8.

A spend of `amount` to `payee` with `token` under leaf mandate `L` is allowed only if **every** mandate on
the path from `L` to its root is registered, not revoked, inside its window, uses `token`, allowlists
`payee`, has `amount <= maxPerAction` and `spent + amount <= maxTotal`. Execution then adds `amount` to
`spent` on every ancestor. So:

- a child can never exceed its parent's remaining ceiling;
- siblings share their parent's budget (the parent's `spent` includes all descendants' spends);
- registering a new child never resets an ancestor (budgets live on the ancestor, not the child);
- revoking an ancestor disables every descendant.

The only effect a session-key operation can have is `token.transfer(payee, amount)`. `callData` must be
exactly `executeUserOp.selector ++ abi.encode(bytes32 mandate, address token, address payee, uint256 amount)`.

## Two-of-two authorisation

`userOp.signature = abi.encode(uint48 decisionValidUntil, bytes sessionSignature, bytes gatekeeperSignature)`.

1. **Session key**: an EIP-191 personal-message signature over the `userOpHash`. The key must be registered,
   not revoked, bound to the op's mandate, and inside its own validity window.
2. **Gatekeeper decision**: an EIP-712 signature with domain
   `{name: "AttestMandateAccount", version: "1", chainId, verifyingContract: account}` over

   ```
   GatekeeperDecision(address entryPoint,bytes32 userOpHash,uint256 nonce,bytes32 mandateDigest,
                      address token,address payee,uint256 amount,uint48 validUntil)
   ```

   This binds chain id and account (domain), the entry point, the exact user operation (`userOpHash`,
   which itself commits to sender, nonce, callData, gas fields, entry point and chain id), the nonce
   (explicitly, for auditors), the mandate digest, token, payee, amount and an expiry. A co-signature
   therefore cannot be replayed onto another op, another account, another chain, another entry point, or a
   different amount, payee or token. `validUntil = 0` is refused (it would mean "forever" in ERC-4337).

Both signatures use 65-byte `r||s||v`, `v ∈ {27,28}` and low-`s` only (malleable signatures fail).

### What the Gatekeeper co-signature attests

Exactly: "Gatekeeper's policy decision point evaluated this transfer — this account, this mandate
digest, this token, payee and amount, in this user operation — and allowed it, until `validUntil`."
It is a policy decision receipt from a trusted key, **not** a zero-knowledge proof, not a proof that the
mandate JWS chain verified, and not a statement about the payee. The account still enforces every cap
itself; a compromised Gatekeeper key combined with a compromised session key can spend only up to the
remaining on-chain mandate ceilings to allowlisted payees until the owner or guardian reacts. Gatekeeper
is expected to have verified the mandate chain (`verifyMandateChain`) and its live status before signing;
the contract cannot check that.

## ERC-4337 conformance notes

- `validateUserOp` is `onlyEntryPoint`, returns `SIG_VALIDATION_FAILED` (1) for any signature mismatch
  (unknown/revoked/mis-bound session key, wrong co-signer, malformed or high-`s` signature) instead of
  reverting, and reverts with a reason for malformed operations or policy violations (wrong sender,
  `initCode`, callData shape, replay, pause, token, payee, caps, revoked or unknown mandate).
- Time limits are returned, not checked: `validationData = validUntil << 160 | validAfter << 208`, with
  `validUntil = min(decision expiry, every mandate's validUntil, session key validUntil)` and
  `validAfter = max(every mandate's validAfter, session key validAfter)`. Validation uses no
  `TIMESTAMP`/`NUMBER` opcodes.
- Storage access during validation is limited to the account's own storage; the only external call is the
  `missingAccountFunds` prefund to the EntryPoint (its failure is ignored; the EntryPoint checks the
  deposit). `ecrecover` is the only precompile used.
- Execution uses the v0.7 `IAccountExecute.executeUserOp(userOp, userOpHash)` hook so the account sees the
  signed op again. It re-checks everything that can change between validation and execution in a bundle
  (pause, session key and mandate revocation, timestamps, remaining budgets), marks the `userOpHash`
  consumed (defence in depth on top of the EntryPoint nonce), debits every ancestor, then transfers.
  Budget debits happen only at execution, so two ops validated in the same bundle cannot both spend the
  last of a ceiling.
- No `initCode`/factory: accounts are deployed directly by the owner. No paymaster or aggregator support.
- The client's `userOperationHash` implements the v0.7 hash and is tested against viem's
  `getUserOperationHash`.

### Test harness

The tests do **not** deploy a real EntryPoint (its bytecode is not available without adding heavy
dependencies). They impersonate the canonical v0.7 address `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
with `anvil_impersonateAccount` and play its role: compute the real v0.7 `userOpHash`, call
`validateUserOp`, treat a revert or `sigFailed` as rejection, enforce `validAfter`/`validUntil` against the
block timestamp, then call `executeUserOp`. Bundler simulation rules (ERC-7562) are not executed by a
tracer; they are followed by construction as described above. Running against a real EntryPoint and a
rule-checking bundler is a prerequisite for any non-local deployment.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Stolen session key | Cannot spend without a fresh Gatekeeper co-signature; bounded by caps; owner revokes the key, guardian pauses |
| Stolen Gatekeeper key | Cannot spend without a session key; owner rotates `gatekeeper`; guardian pauses |
| Both keys stolen | Loss bounded by remaining on-chain ceilings to allowlisted payees; pause/revoke |
| Co-signature replay (same op, other account, other chain, other entry point, altered amount/payee/token) | EIP-712 domain binds chain and account; struct binds entry point, `userOpHash`, nonce, mandate, token, payee, amount; consumed `userOpHash` set |
| Child mandate widens or resets parent budget | Registration attenuation checks; spends debit and check every ancestor |
| Sibling mandates double-spend a parent | Parent `spent` is shared state checked on every descendant spend |
| Arbitrary calls by the agent | Only one callData shape is accepted; the only effect is `token.transfer` |
| Wrong token / currency confusion | Token checked on every mandate in the chain and bound by the co-signature |
| Stale decision / expired mandate | `validUntil` packing for the EntryPoint plus `block.timestamp` re-checks at execution |
| Revocation racing a bundle | Execution re-checks revocation and pause |
| Signature malleability | Low-`s`, `v ∈ {27,28}`, exact 65-byte length |
| Malicious guardian | Can only pause (denial of service); cannot unpause or move funds |
| Mainnet misuse | Constructor and client refuse chain id 1; `TestStablecoin` refuses chain id 1 |
| Privacy | Only digests, limits, addresses and amounts are on-chain; amounts and payees are public by nature of ERC-20 transfers |

Out of scope / known gaps: no factory or counterfactual deployment, no paymaster, no real-EntryPoint or
bundler-tracer test, no on-chain verification of the mandate JWS chain or its status list (owner
registration is the trust root), no per-period (rate) budgets, no owner key rotation ceremony beyond
`setOwner`, no upgradeability, and no audit.

## Running

```
pnpm --filter @attest/contracts build
pnpm exec vitest run packages/chain-evm/test/mandate-account.test.ts
MANDATE_FUZZ_SEED=7 pnpm exec vitest run packages/chain-evm/test/mandate-account.test.ts
```

The property test runs 260 seeded random operations (honest spends and attacks: replay, cross-account,
cross-chain, tampered amount/payee, wrong token, expired decision, wrong co-signer, unknown key, direct
execution) against a mandate tree with shared sibling budgets, a late-registered sibling, a session key
revoked mid-run, a mandate that expires mid-run, an ancestor revoked mid-run and random pauses. After
every op it checks the on-chain `spent` of every mandate against a reference model and that no cap is
exceeded.
