# Networks

Status: experimental. Tracked by ATTE-26. Source: `packages/chain-evm/src/networks.ts`.

Attest's EVM adapter describes each supported chain in one configuration entry. The
protocol kernel stays chain-independent: these entries only configure where
commitments, grants and receipts are anchored and how verifiers read them back.

| Network | Chain ID | Layer | Writes | Default RPCs | Read finality | Stale bound | Explorer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sepolia` | 11155111 | L1 | allowed (testnet) | publicnode, Tenderly | `finalized` | 30 min | sepolia.etherscan.io |
| `base-sepolia` | 84532 | OP-stack L2 | allowed (testnet) | publicnode, Tenderly | `finalized` | 45 min | sepolia.basescan.org |
| `mainnet` | 1 | L1 | **refused** (GMA-748) | publicnode, Tenderly | `finalized` | 30 min | etherscan.io |

Each entry holds the chain ID and viem chain, two independent keyless public RPC
URLs, the finality policy, a staleness bound for the settled head, the explorer, the
contracts whose constructors refuse the chain, and a manifest of checked-in
deployments. The legacy `networks` export and the `"testnet"` / `"production"`
selectors in `connected.ts` still work and map to `sepolia` and `mainnet`.

## Write gate

`assertWritable(network)` is the only write gate. It accepts a network id, a legacy
selector, a configuration object or a raw chain ID, and it fails closed:

- `mainnet` (however it is named) throws `production_writes_disabled`.
- An unknown chain ID throws `network_not_writable`. Other mainnets such as Base
  (8453) are therefore refused too. Only the local development IDs 31337 and 1337
  are allowed.
- A configuration object is looked up by id and chain ID. A copy with
  `writable: true` cannot reopen mainnet.

Every write path in `@attest/chain-evm` goes through the gate. `assertContext(...,
writing = true)` calls it before any provider access, and registry actions, registry
deployment, journey, institution, industry, host-setup and economy writes all use
`assertContext`. The decision-log adapter asks its clients for the chain ID at every
`anchor()` call and gates on that value before any read or write (see below), and
`deploy-network.mjs` calls the gate before it touches a signer. `test/write-gate.test.ts`
covers every write entry point with a wallet on chain 1 and asserts that nothing is
sent, signed or deployed. It runs in the normal `pnpm test`, so CI runs the
direct-adapter rejection tests that `production-readiness.md` requires. There is no
flag, environment variable or configuration override that opens mainnet. Opening it
needs a reviewed source change once the GMA-748 requirements are met.

### Decision-log adapter

Before ATTE-26 the adapter trusted a `chainId` number supplied by its caller. A
mainnet client labelled as Sepolia would have passed the gate. Now:

- `AnchorPublisherClients` has a required `getChainId()`. `anchor()` calls it first
  and passes the result to `assertWritable` before `latestEpoch`, `getEpoch` or
  `simulateAndWrite`. The receipt `ref` (`eip155:<chain>:…`) uses that value.
- `AnchorPublisherClients.chainId` is now optional. If it is given, it is gated when
  the adapter is constructed (fail fast). `anchor()` then requires it to equal
  `getChainId()`, or it throws `chain_mismatch`.
- `viemAnchorClients(publicClient, walletClient, account, chainId?)`: `chainId` is
  optional and used only as that cross-check. `getChainId()` reads the public client.
  If the wallet client also exposes `getChainId()` (viem wallet clients do), both
  must agree, so the chain checked is the one the transaction is sent on.

## Finality

`chainStatusReaderFor(networkId, overrides?)` builds a `ChainStatusReader` from the
entry: its chain ID (which cannot be overridden), both default RPCs, the finality
policy and the staleness bound. Overrides replace individual options, for example
`rpcUrls` for credentialed provider URLs kept in secrets, or `finality` for a
demo that accepts confirmations (the ATTE-27 issuer uses 3 confirmations on Sepolia).
`createChainStatusReader` is unchanged.

**Sepolia and mainnet (L1).** `finalized` is the Casper FFG checkpoint, two justified
epochs (about 13 minutes) behind the head when the network is healthy. A finalized
block can be reverted only if a third of the stake is slashable. The measured
finalized head was 15 to 19 minutes old on Sepolia and 14 to 16 minutes on mainnet.
The 30-minute bound leaves headroom, and a
finality stall then fails closed with `chain_stale` instead of reading old state.

**Base Sepolia (OP-stack L2).** An OP-stack node exposes three heads:

- `latest` (unsafe): the sequencer has gossiped the block. Only the sequencer
  vouches for it, and it can be reorged if the batch never reaches L1.
- `safe`: the block is derived from batch data in an L1 block that is not yet
  finalized. An L1 reorg can still change it.
- `finalized`: the block is derived from batch data in a finalized Sepolia L1 block.
  Only an L1 finality failure can reorg it.

The fault-proof challenge window (days) applies to L2-to-L1 withdrawals, not to the
L2 chain's own history. A verifier reading L2 state can therefore treat `finalized`
as settled. Attest reads Base Sepolia at `finalized`. Confirmation counts are not
used there: blocks arrive every 0.2 s, so even the reader's 256-confirmation maximum
is about 51 s of sequencer-only blocks and gives no settlement guarantee. The
measured finalized head was 16 to 25 minutes old, because it waits for both the
batcher's post and L1 finality. The bound is 45 minutes.

## Contract manifests

| Network | Deployed contracts |
| --- | --- |
| `sepolia` | `InstitutionRegistry` `attest.institutional.contractor.v2` at `0xA90cD05e3CC5bB10EE359D50DC4c75aE685DC678` (`apps/web/public/demo-deployment.json`); `IndustryRegistry` healthcare `0xaa2d9c6CFD18C3aE55a6d8fB762783DF0866cFFD`, education `0xB4da675c1b1E6caa14ab7Cd2A69A19b677b8b75a`, logistics `0x267c3A587c1Bde2b12E847F6Abb6C94641aD619C` (`apps/web/public/industry-deployments.json`) |
| `base-sepolia` | none yet |
| `mainnet` | none (writes refused) |

`test/networks.test.ts` fails if the Sepolia entry drifts from the two public JSON
manifests. `WorkspaceRegistry` instances are deployed per workspace from the
connected-workspace UI and are not listed. No shared `WorkspaceRegistry`,
`DecisionLogAnchor`, `AttestEconomy` or `DemoJourneyRegistry` deployment is checked
in for Sepolia.

`DemoJourneyRegistry`, `InstitutionRegistry`, `IndustryRegistry`, the economy
contracts (`AttestToken`, `AttestClaims`, `AttestPassport`) and the ZK minter
contracts revert in their constructors unless `block.chainid == 11155111`. They are
fictional Sepolia demos and are listed in `unsupportedContracts` for every other
network. `WorkspaceRegistry`, `DecisionLogAnchor` and `AssuranceAnchor` have no
chain guard.

## Deploying a network

`packages/chain-evm/scripts/deploy-network.mjs` deploys `WorkspaceRegistry` and
`DecisionLogAnchor` to a writable network and prints the manifest JSON on stdout.
The `contracts` field has the same shape as `NetworkConfig.contracts`, and
`transactions` records each hash, block, administrator and runtime code hash.

```sh
pnpm --filter @attest/contracts build
ATTEST_DEPLOYER_PRIVATE_KEY=0x... pnpm exec tsx packages/chain-evm/scripts/deploy-network.mjs \
  --network base-sepolia [--rpc-url URL] [--administrator 0x...] [--confirmations 2] [--key-env NAME]
```

- The signer is injected. Programmatic callers pass an EIP-1193 provider to
  `deployNetwork({ network, provider })`. The CLI reads a private key from an
  environment variable (default `ATTEST_DEPLOYER_PRIVATE_KEY`). The script writes
  no files.
- It calls `assertWritable` first, so mainnet is refused before any signer or RPC
  access. It then checks that the RPC reports the network's chain ID
  (`chain_mismatch` otherwise). After each deployment it checks the receipt
  status and that the runtime code at the address equals the compiled artifact's
  `deployedBytecode`. The comparison uses the same length and the same keccak256
  hash with immutable slots zeroed, using solc's `immutableReferences`, which
  `contracts/scripts/compile.mjs` now writes to `contracts/artifacts/*.json`. It
  then checks the administrator by value. That also covers `WorkspaceRegistry`'s
  only immutable.
- `WorkspaceRegistry`'s administrator is the deployer and cannot be changed.
  `DecisionLogAnchor`'s administrator defaults to the deployer, can be set with
  `--administrator`, and can be handed over in two steps later.
- Error output is limited to viem's short message, so a credentialed `--rpc-url`
  is not echoed.

The anvil decision-log suite deploys its anchor with this script on both chain IDs.
The script has not been run against a public network. Deploying to Base Sepolia,
then recording the addresses in `networkConfigs["base-sepolia"].contracts`, is a
separate step that needs a funded wallet.

## Tests on both chain IDs

The registry, status and decision-log anvil suites run once per testnet. Each one
starts anvil with `--chain-id 11155111` and again with `--chain-id 84532`
(`test/anvil-networks.ts`) and uses that network's viem chain. Anvil reproduces the
chain ID and the EVM, but not OP-stack derivation or L1 finality. Those were checked
against the live public endpoints below.

## RPC measurements

Measured 2026-11-22 from a developer machine with plain JSON-RPC over HTTPS. A
script made 10 rounds per endpoint, then 20 rounds for the shortlisted ones, with 1.5 s
between rounds. Each round called `eth_chainId`, `eth_getBlockByNumber("finalized")`
and `eth_getBlockByNumber("latest")`, then compared block hashes across providers at
the lowest finalized height (the `ChainStatusReader` pattern). Where an endpoint ran
in both batches, the finalized-age median is given as a range across the two runs.

| Network | Endpoint | chainId | finalized | Median / max latency | Finalized age (median / max) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Sepolia | publicnode `ethereum-sepolia-rpc.publicnode.com` | 30/30 | 30/30 | 80 / 502 ms | 939–1077 / 1093 s | **chosen** (kept from ATTE-27) |
| Sepolia | Tenderly `sepolia.gateway.tenderly.co` | 30/30 | 30/30 | 90 / 236 ms | 939–1077 / 1093 s | **chosen** (kept from ATTE-27) |
| Sepolia | dRPC `sepolia.drpc.org` | 0/30 | 0/30 | – | – | "chain is not available on free plan" |
| Base Sepolia | publicnode `base-sepolia-rpc.publicnode.com` | 30/30 | 30/30 | 96 / 440 ms | 986–1055 / 1520 s | **chosen** |
| Base Sepolia | Tenderly `base-sepolia.gateway.tenderly.co` | 30/30 | 30/30 | 97 / 317 ms | 984–1053 / 1455 s | **chosen** |
| Base Sepolia | Base `sepolia.base.org` | 30/30 | 30/30 | 81 / 790 ms | 977–1053 / 1069 s | reliable fallback; Base documents it as rate-limited and not for production |
| Base Sepolia | thirdweb `84532.rpc.thirdweb.com` | 10/10 | 10/10 | 209 / 591 ms | 977 / 987 s | slower |
| Base Sepolia | dRPC `base-sepolia.drpc.org` | 10/10 | 7/10 | 113 / 391 ms | 1457 / 1472 s | free-plan timeouts |
| Mainnet | publicnode `ethereum-rpc.publicnode.com` | 10/10 | 10/10 | 98 / 535 ms | 856 / 866 s | chosen (reads only) |
| Mainnet | Tenderly `mainnet.gateway.tenderly.co` | 10/10 | 10/10 | 64 / 205 ms | 856 / 865 s | chosen (reads only) |
| Mainnet | LlamaRPC `eth.llamarpc.com` | 0/10 | 0/10 | – | – | returned an HTML page |

The chosen pairs agreed on the block hash at the common finalized height in every
round: Sepolia 30/30, Base Sepolia 30/30 and mainnet 10/10. A separate check measured
Base Sepolia blocks at 0.2 s (1,000 blocks in 200 s), `safe` 60 to 300 s behind the
head and `finalized` about 5,100 blocks (about 17 minutes) behind. Sepolia blocks
arrived every 12.4 s, with `finalized` 79 to 85 blocks behind. Finally,
`chainStatusReaderFor(id).snapshot()` with the default endpoints succeeded 5 of 5
times on each of the three networks (read-only).

These are free public endpoints with no SLA. Their availability and rate limits can
change. Pilot or production verifiers should pass credentialed providers from
secrets through the `rpcUrls` override, still from two independent operators.

## Behaviour changes

Notes for the ATTE-26 pull request:

- **Decision-log adapter refuses unlisted chains.** Before, it refused only chain 1.
  Now `anchor()` refuses every chain that is not a configured writable network
  (Sepolia, Base Sepolia) or a local development chain (31337, 1337). Base mainnet
  (8453) and other L2 mainnets fail with `network_not_writable`.
- **Decision-log adapter checks the real chain.** The gate uses the chain ID from
  `getChainId()` at anchor time, not a caller-supplied number.
  - `AnchorPublisherClients` gains a required `getChainId()`. Custom implementations
    must add it; callers using `viemAnchorClients` need no change.
  - `chainId` becomes optional and serves only as a cross-check (`chain_mismatch`).
  - The fourth argument of `viemAnchorClients` becomes optional.
  - A viem wallet client on a different chain from the reader is refused with
    `chain_mismatch`.
- **Mainnet refusal message.** The refusal from `assertContext(..., writing = true)`
  and the other write helpers is now a `ChainStatusError` with code
  `production_writes_disabled`. Its message gains a prefix and suffix:
  `production_writes_disabled: Production writes are disabled pending reviewed
  contracts, custody, authority and proof configuration (Ethereum, chain 1)`.
  Before, it was a plain `Error` with only the middle sentence. Substring matches on
  "Production writes are disabled" still work, but the UI would show the prefix.
- **Build artifacts.** `contracts/artifacts/*.json` gains `deployedBytecode` and
  `immutableReferences`. The files under `apps/web/public/contracts/` are unchanged.
- **Network ids accepted.** `connected.ts` helpers accept the new network ids
  (`sepolia`, `base-sepolia`, `mainnet`) as well as `testnet` / `production`. The
  `networks` export is unchanged.
