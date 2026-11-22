# MandateAccount: ERC-4337 mandate-limited spending with Gatekeeper co-signature (experimental)

> **Status: experimental, testnet only, not audited. A security review is required before any value
> beyond testnet.** The contract, the test-only `TestStablecoin` and the client accept only an allowlist of
> test networks: 31337 (anvil/hardhat), 1337, 11155111 (Sepolia) and 84532 (Base Sepolia). `TestStablecoin`
> is never shipped to the web bundle.

`contracts/src/MandateAccount.sol` is an ERC-4337 (EntryPoint v0.7, `PackedUserOperation`) smart
account. It lets an agent session key spend one ERC-20 stablecoin, but only inside an owner-registered
[Attest agent mandate](agent-mandates.md) chain, only within an owner-set gas-cost cap, and only when a
Gatekeeper decision co-signs the exact operation. The client lives in `packages/chain-evm/src/mandates.ts`.

## Roles

| Role | Key | Can | Cannot |
| --- | --- | --- | --- |
| Owner | EOA, direct calls only | register/revoke mandates and session keys, set Gatekeeper/guardian, propose a new owner, unpause, arbitrary `execute` (withdraw) | act through the EntryPoint (owner operations are never user operations) |
| Pending owner | EOA | `acceptOwner()` | anything else until accepted |
| Agent session key | secp256k1, bound to one mandate | sign user operations that transfer the mandate's token to an allowlisted payee | make arbitrary calls, spend without a Gatekeeper co-signature, exceed the gas-cost cap, change policy |
| Gatekeeper | secp256k1 decision key | co-sign one specific transfer at one maximum gas cost | spend alone, change policy |
| Pause guardian | address | `pause()` | unpause, move funds, change policy |
| EntryPoint | v0.7 contract | call `validateUserOp` / `executeUserOp` | anything else (all other entry points are owner-only) |

Roles are kept disjoint so one key never satisfies both halves of 2-of-2 or more than one role:
`setGatekeeper` rejects any address ever registered as a session key (revoked ones included), the guardian
and the owner; `setGuardian` rejects session keys and the Gatekeeper; `registerSessionKey` rejects the
owner, pending owner, Gatekeeper and guardian; `acceptOwner` rejects session keys, the Gatekeeper and the
guardian. Ownership moves in two steps (`proposeOwner`, then `acceptOwner` from the proposed address).

## On-chain policy (mirrors an Attest mandate)

Each mandate is registered under its **mandate digest** (SHA-256 of the canonical mandate JSON,
`documentDigest` in `@attest/mandates`) with: parent digest (zero for a root), token, per-action cap,
aggregate cap, **per-op gas-cost cap** (wei), validity window (seconds; the client rounds `validFrom` up
and `validUntil` down so the on-chain window never widens) and a payee allowlist. Only commitments and
limits are stored; no mandate contents, identities or evidence go on-chain. The gas-cost cap has no
counterpart in the mandate format; the operator chooses it (`maxGasCostWei` in `mandateRegistration`).

Registration enforces attenuation like `verifyMandateChain`: a child has the same token, a per-action
cap, aggregate cap and gas-cost cap no larger than its parent's, a validity window inside its parent's,
payees that are a subset of its parent's, and a depth below 8.

A spend of `amount` to `payee` with `token` under leaf mandate `L` is allowed only if **every** mandate on
the path from `L` to its root is registered, not revoked, inside its window, uses `token`, allowlists
`payee`, has `amount <= maxPerAction` and `spent + amount <= maxTotal`, and the op's maximum gas cost is
within the smallest gas-cost cap on the path. Execution then adds `amount` to `spent` on every ancestor. So:

- a child can never exceed its parent's remaining ceiling;
- siblings share their parent's budget (the parent's `spent` includes all descendants' spends);
- registering a new child never resets an ancestor (budgets live on the ancestor, not the child);
- revoking an ancestor disables every descendant.

The only effect a session-key operation can have is `token.transfer(payee, amount)`. `callData` must be
exactly `executeUserOp.selector ++ abi.encode(bytes32 mandate, address token, address payee, uint256 amount)`.

## Gas-cost cap (prefund bound)

Without a bound, a session key could set huge `preVerificationGas` and fees and submit the op through
`handleOps` with itself as beneficiary: the account prefunds `gasLimit * maxFeePerGas` from its own ETH
deposit/balance and the unused part of `preVerificationGas` goes to the beneficiary. The account therefore
derives, from the `PackedUserOperation` calldata itself,

```
totalGasLimit = verificationGasLimit + callGasLimit + preVerificationGas   (accountGasLimits high/low 128 bits)
maxFeePerGas  = low 128 bits of gasFees
```

and requires `totalGasLimit * maxFeePerGas <= min(maxGasCost along the chain)` (checked as
`totalGasLimit <= cap / maxFeePerGas`, which is exact for integers and cannot overflow). This equals the v0.7
EntryPoint's required prefund because `paymasterAndData` must be empty (paymasters are rejected, so their
gas limits cannot sit outside the cap). `preVerificationGas` above 2^128 is rejected. Both `totalGasLimit`
and `maxFeePerGas` are also part of the Gatekeeper decision, so the co-signer explicitly approves the cost.
There is no cumulative gas budget yet; each op is bounded and needs a fresh co-signature.

## Two-of-two authorisation

`userOp.signature = abi.encode(uint48 decisionValidUntil, bytes sessionSignature, bytes gatekeeperSignature)`.

1. **Session key**: an EIP-191 personal-message signature over the `userOpHash`. The key must be registered,
   not revoked, bound to the op's mandate, and inside its own validity window.
2. **Gatekeeper decision**: an EIP-712 signature with domain
   `{name: "AttestMandateAccount", version: "1", chainId, verifyingContract: account}` over this type
   (exported as `GATEKEEPER_DECISION_TYPE`; the contract's `GATEKEEPER_DECISION_TYPEHASH` is its keccak256):

   ```
   GatekeeperDecision(address entryPoint,bytes32 userOpHash,uint256 nonce,bytes32 mandateDigest,address token,address payee,uint256 amount,uint256 totalGasLimit,uint256 maxFeePerGas,uint48 validUntil)
   ```

   The account builds this struct itself from the op (entry point, the userOpHash it was given, `nonce`,
   decoded callData, the gas fields above, and the expiry from the signature), so nothing in it is
   attacker-chosen apart from what the op commits to. It binds chain id and account (domain), the entry
   point, the exact user operation (`userOpHash` commits to sender, nonce, callData, gas fields, entry point
   and chain id), the nonce (explicitly, for auditors), mandate digest, token, payee, amount, total gas
   limit, max fee per gas and an expiry. A co-signature therefore cannot be replayed onto another op,
   account, chain or entry point, or a different amount, payee, token or gas cost. `validUntil = 0` is
   refused (it would mean "forever" in ERC-4337).

Both signatures use 65-byte `r||s||v`, `v ∈ {27,28}` and low-`s` only (malleable signatures fail).

### Co-signer requirements (Gatekeeper)

The co-signer **must never sign a bare `userOpHash` or caller-supplied decision fields.** It must receive
the full `PackedUserOperation`, check that the RPC it trusts reports the chain id it is signing for, and
derive every field from the op: `gatekeeperDecisionFromUserOp(op, {chainId, entryPoint, validUntil})`
decodes callData, reads gas fields and recomputes the userOpHash. `cosignMandateUserOp` does all of this
(including `assertRpcChain`) and passes the decision plus its `maxGasCost` to a policy hook before signing.

### What the Gatekeeper co-signature attests

Exactly: "Gatekeeper's policy decision point evaluated this transfer — this account, this mandate
digest, this token, payee and amount, in this user operation, at this maximum gas cost — and allowed it,
until `validUntil`." It is a policy decision receipt from a trusted key, **not** a zero-knowledge proof,
not a proof that the mandate JWS chain verified, and not a statement about the payee. The account still
enforces every cap itself; a compromised Gatekeeper key combined with a compromised session key can spend
only up to the remaining on-chain mandate ceilings to allowlisted payees, and at most the gas-cost cap per
op, until the owner or guardian reacts. Gatekeeper is expected to have verified the mandate chain
(`verifyMandateChain`) and its live status before signing; the contract cannot check that.

## ERC-4337 conformance notes

- `validateUserOp` is `onlyEntryPoint`. It first runs the structural checks (sender, no `initCode`, no
  paymaster, not replayed, not paused), decodes callData and gas fields, and **always** runs the full policy
  walk and gas-cost check, whether or not the signatures turn out valid, so validation gas does not depend on
  signature validity. Policy and format violations revert with a reason.
- Every signature problem returns `SIG_VALIDATION_FAILED` (1) instead of reverting: unknown, revoked or
  mis-bound session key; wrong co-signer; high-`s` or wrong-length signatures; and malformed encodings. The
  signature envelope is decoded manually with bounds checks (short data, offsets inside the header or past
  the end, lengths past the end, a dirty `uint48` word or a zero expiry), never by `abi.decode`. Extra
  trailing bytes or padding changes are harmless, because the signature is not part of the userOpHash and
  replay protection is keyed on the userOpHash.
- Time limits are returned, not checked: `validationData = validUntil << 160 | validAfter << 208`, with
  `validUntil = min(decision expiry, every mandate's validUntil, session key validUntil)` and
  `validAfter = max(every mandate's validAfter, session key validAfter)`. Validation uses no
  `TIMESTAMP`/`NUMBER` opcodes.
- Storage access during validation is limited to the account's own storage; the only external call is the
  `missingAccountFunds` prefund to the EntryPoint (its failure is ignored; the EntryPoint checks the
  deposit). `ecrecover` is the only precompile used.
- Execution uses the v0.7 `IAccountExecute.executeUserOp(userOp, userOpHash)` hook. It re-checks everything
  that can change between validation and execution in a bundle (pause, session-key and mandate revocation,
  timestamps, remaining budgets) and both signatures, so it is safe even if called without a successful
  validation. It marks the `userOpHash` consumed (defence in depth on top of the EntryPoint nonce), debits
  every ancestor, then transfers. Budgets are debited only at execution, so two ops validated in the same
  bundle cannot both spend the last of a ceiling: the second execution fails with `aggregate cap`.
- No `initCode`/factory: the owner deploys accounts directly. No paymaster or aggregator support.
- The client's `userOperationHash` implements the v0.7 hash and is tested against viem's
  `getUserOperationHash`. `packUints` and `buildMandateUserOp` reject gas values of 2^128 or more.
- The contract is compiled with the optimizer and via-IR (set for this contract only in
  `contracts/scripts/compile.mjs`); without them its runtime code exceeds the EIP-170 size limit.

### Test harness

The tests do **not** deploy a real EntryPoint, because its bytecode is not available without adding heavy
dependencies. They impersonate the canonical v0.7 address `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
with `anvil_impersonateAccount` and play its role: compute the real v0.7 `userOpHash`, call
`validateUserOp`, treat a revert or `sigFailed` as rejection, enforce `validAfter`/`validUntil` against the
block timestamp, then call `executeUserOp`. Bundler simulation rules (ERC-7562) are not executed by a
tracer; they are followed by construction as described above. Running against a real EntryPoint and a
rule-checking bundler is a prerequisite for any non-local deployment. The anvil tests fail instead of
skipping when `CI` is set and anvil is missing.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Stolen session key | Cannot spend without a fresh Gatekeeper co-signature; bounded by caps; owner revokes the key, guardian pauses |
| Stolen Gatekeeper key | Cannot spend without a session key; owner rotates `gatekeeper`; guardian pauses |
| Both keys stolen | Loss bounded by remaining on-chain ceilings to allowlisted payees and the gas-cost cap per op; pause/revoke |
| ETH drain via inflated gas (`preVerificationGas`, fees) and a self-chosen beneficiary | Per-op gas-cost cap computed from the op's own fields; paymasters rejected; gas fields are co-signed |
| Co-signature replay (same op, other account, other chain, other entry point, altered amount/payee/token/gas) | EIP-712 domain binds chain and account; struct binds entry point, `userOpHash`, nonce, mandate, token, payee, amount, gas limit, fee; consumed `userOpHash` set |
| Co-signer tricked into signing a hash for a different op | Co-signer derives the decision from the full op and recomputes the hash; never signs a bare hash |
| Signing against the wrong network | Allowlisted chain ids only (contract, test token, client), and the client checks the RPC's `eth_chainId` before signing |
| Child mandate widens or resets parent budget | Registration attenuation checks; spends debit and check every ancestor |
| Sibling mandates double-spend a parent | Parent `spent` is shared state checked on every descendant spend |
| Same-bundle double-spend | Budgets debited and re-checked at execution, not validation |
| Arbitrary calls by the agent | Only one callData shape is accepted; the only effect is `token.transfer` |
| Wrong token / currency confusion | Token checked on every mandate in the chain and bound by the co-signature |
| Stale decision / expired mandate / expired session key | `validUntil`/`validAfter` packing for the EntryPoint plus `block.timestamp` re-checks at execution |
| Revocation racing a bundle | Execution re-checks revocation and pause |
| Signature malleability or malformed envelopes | Low-`s`, `v ∈ {27,28}`, exact 65-byte length; bounds-checked manual decode returning `SIG_VALIDATION_FAILED` |
| Role collapse (one key as Gatekeeper and session key, or owner) | Disjoint-role checks on every role setter; two-step ownership transfer |
| Malicious guardian | Can only pause (denial of service); cannot unpause or move funds |
| Privacy | Only digests, limits, addresses and amounts are on-chain; amounts and payees are public by nature of ERC-20 transfers |

Out of scope and known gaps:

- No factory or counterfactual deployment, and no paymaster.
- No test against a real EntryPoint or a bundler rule tracer.
- No cumulative gas budget; each op is bounded only by the per-op cap.
- No on-chain verification of the mandate JWS chain or its status list; owner registration is the trust root.
- No per-period (rate) budgets.
- No upgradeability.
- No audit.

## Running

```
pnpm --filter @attest/contracts build
pnpm exec vitest run packages/chain-evm/test/mandate-account.test.ts
MANDATE_FUZZ_SEED=7 pnpm exec vitest run packages/chain-evm/test/mandate-account.test.ts
```

The property test runs 260 seeded random operations against a mandate tree with shared sibling budgets.
The operations mix honest spends and attacks: replay, cross-account, cross-chain, tampered amount or payee,
wrong token, expired decision, wrong co-signer, unknown key and direct execution. During the run a sibling
is registered late, a session key is revoked, a mandate expires, an ancestor is revoked and the account is
paused at random. After every op the test checks that each mandate's on-chain `spent` matches a reference
model and that no cap is exceeded. Named tests cover gas-cost cap boundaries, chain allowlisting,
malformed signatures, disjoint roles and two-step ownership, exact validity-window boundaries, and the
same-bundle double-spend.
