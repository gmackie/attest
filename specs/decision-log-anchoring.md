# Decision-log anchoring (experimental, testnet)

`DecisionLogAnchor` (ATTE-19) publishes commitments to sealed epochs of hash-chained decision logs, such as
Gatekeeper's decision ledger (GATE-12). Third parties can then check a decision receipt against a root the log
operator cannot later change. The work is part of the trust-stack roadmap, ATTE-15.

## What is on-chain

For each log ID and epoch, the contract stores:
- `root`: the RFC 6962 Merkle root over the epoch's leaf hashes
- `firstSeq` and `lastSeq`
- `firstPrevHash` and `lastLeafHash`
- `anchoredAt`

The leaves are Gatekeeper's salted, hash-chained commitments. Neither the contract nor its events hold decision
content: no principal, action or outcome.

Correlation is possible from public metadata only: anchoring times, epoch sizes and the publisher's address. Those
reveal the volume of receipt-bearing decisions per epoch.

## What the contract enforces

- Only the log's current `publisher` can anchor. The administrator can rotate the publisher. Administration is
  handed over in two steps (propose, then accept), unlike the immutable admin of the older registries.
- Epochs are strictly sequential (`epoch == latestEpoch + 1`). An anchored epoch can never be rewritten.
- Each epoch continues the previous one: `firstSeq == previous.lastSeq + 1` and
  `firstPrevHash == previous.lastLeafHash`. Epoch 1 must start at sequence 1 with a zero predecessor. Once a
  span is anchored, the operator cannot drop, reorder or fork history across epochs.
- The contract does **not** recompute the Merkle root. It fixes what the publisher committed to.
- Tail decisions that are not yet sealed and anchored are still unprotected. That gap is inherent to hash chains
  without an external anchor, and it now shrinks to the sealing interval.

## TypeScript (`@attest/chain-evm`)

- **`decisionLogAnchorAdapter`:** a publisher matching Gatekeeper's `RootAnchor` port.
  - It is idempotent: re-anchoring the same commitment returns a receipt.
  - It refuses with `anchor_conflict` when the same epoch is sent with a different commitment, and with
    `anchor_out_of_order` when the epoch skips ahead.
  - Mainnet (chain ID 1) is refused while production writes are gated.
- **`readAnchoredEpoch`:** reads an epoch through `ChainStatusReader`. The read uses a settled block, two agreeing
  RPCs and reorg detection. It returns Gatekeeper's `AnchoredEpoch` shape plus chain evidence.
- **`merkleRoot`, `inclusionProof`, `verifyInclusion`:** RFC 6962 / RFC 9162 Merkle functions, checked against
  the RFC vectors.
- **`verifyAnchoredInclusion`:** checks a leaf against an epoch read from chain. The leaf index comes from the
  anchored span and the tree size from the chain, never from the proof bundle. That matters because an audit path
  alone does not fix the tree size.

Gatekeeper's own `verifyDecisionProof(bundle, anchoredEpoch)` recomputes the decision's commitment and leaf.
Pass it the result of `readAnchoredEpoch`.

## Status

The contract is not audited. Its deployment (manifest and address) and Gatekeeper's adapter wiring are tracked as
follow-ups. Mainnet stays gated by `specs/production-readiness.md`.
