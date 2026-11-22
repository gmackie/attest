/**
 * Per-network configuration for Attest's EVM adapter (ATTE-26).
 *
 * One entry per supported chain: chain ID and viem chain, two independent default public
 * RPC providers, the finality policy verifiers read at, the explorer and the manifest of
 * checked-in contract deployments. See specs/networks.md for the RPC measurements and the
 * reasoning behind each finality choice.
 *
 * Writes are gated in one place, `assertWritable`: every write helper in this package goes
 * through it, and Ethereum mainnet stays refused until the GMA-748 release requirements in
 * specs/production-readiness.md are met. There is deliberately no flag to open it.
 */
import { createPublicClient, http, type Address, type Chain } from "viem";
import { baseSepolia, mainnet, sepolia } from "viem/chains";
import { codeReadingEndpoint } from "./manifest";
import {
  ChainStatusError,
  createChainStatusReader,
  type ChainEndpoint,
  type ChainStatusReader,
  type ChainStatusReaderOptions,
  type Finality,
} from "./status";

export const networkIds = ["sepolia", "base-sepolia", "mainnet"] as const;
export type NetworkId = (typeof networkIds)[number];

/** Contract names as produced by contracts/scripts/compile.mjs. */
export type ContractName =
  | "WorkspaceRegistry"
  | "InstitutionRegistry"
  | "IndustryRegistry"
  | "DemoJourneyRegistry"
  | "AttestToken"
  | "AttestClaims"
  | "AttestPassport"
  | "PrivateClaimRoots"
  | "ZkAttestMinterV1"
  | "DecisionLogAnchor"
  | "AssuranceAnchor"
  | "StatusRegistry"
  | "RevocationRoots";
/** Deployed instances per contract, keyed by profile (for example an industry id) or "default". */
export type ContractManifest = Readonly<Partial<Record<ContractName, Readonly<Record<string, Address>>>>>;

/** Contracts whose constructors revert unless block.chainid is 11155111 (fictional Sepolia demo). */
export const sepoliaOnlyContracts: readonly ContractName[] = [
  "DemoJourneyRegistry",
  "InstitutionRegistry",
  "IndustryRegistry",
  "AttestToken",
  "AttestClaims",
  "AttestPassport",
  "PrivateClaimRoots",
  "ZkAttestMinterV1",
];

export interface RpcEndpointConfig {
  /** Operator label used in errors and logs. */
  name: string;
  /** Keyless public URL. Never put credentialed URLs in source; pass them as overrides. */
  url: string;
}

export interface NetworkConfig {
  id: NetworkId;
  chainId: number;
  name: string;
  chain: Chain;
  layer: "l1" | "op-stack-l2";
  testnet: boolean;
  /** False keeps every write helper closed for this network (assertWritable). */
  writable: boolean;
  /** Two independent providers; ChainStatusReader requires both to agree. */
  rpcUrls: readonly RpcEndpointConfig[];
  /** The settled height verifiers read at by default. */
  finality: Finality;
  /** Refuse a settled head older than this (ms). Sized from measured finalized-head age. */
  maxBlockAgeMs: number;
  /** Measured average block interval, seconds. */
  blockTimeSeconds: number;
  explorer: { name: string; url: string };
  /** Contracts that cannot be deployed on this chain (constructor chain guard). */
  unsupportedContracts: readonly ContractName[];
  contracts: ContractManifest;
}

const sepoliaConfig = {
  id: "sepolia",
  chainId: 11155111,
  name: "Ethereum Sepolia",
  chain: sepolia,
  layer: "l1",
  testnet: true,
  writable: true,
  // Same pair the hosted issuer uses (wrangler.jsonc, ATTE-27).
  rpcUrls: [
    { name: "publicnode", url: "https://ethereum-sepolia-rpc.publicnode.com" },
    { name: "tenderly", url: "https://sepolia.gateway.tenderly.co" },
  ],
  // Casper FFG finality: two justified epochs, about 13 to 19 minutes behind head.
  finality: { kind: "finalized" },
  maxBlockAgeMs: 30 * 60_000,
  blockTimeSeconds: 12,
  explorer: { name: "Etherscan", url: "https://sepolia.etherscan.io" },
  unsupportedContracts: [],
  // Mirrors apps/web/public/demo-deployment.json and industry-deployments.json (a test keeps them in sync).
  contracts: {
    InstitutionRegistry: {
      "attest.institutional.contractor.v2": "0xA90cD05e3CC5bB10EE359D50DC4c75aE685DC678",
    },
    IndustryRegistry: {
      healthcare: "0xaa2d9c6CFD18C3aE55a6d8fB762783DF0866cFFD",
      education: "0xB4da675c1b1E6caa14ab7Cd2A69A19b677b8b75a",
      logistics: "0x267c3A587c1Bde2b12E847F6Abb6C94641aD619C",
    },
    // Trust-stack contracts, pinned in contracts/deployments/11155111.json (ATTE-15).
    DecisionLogAnchor: { default: "0x7020EE914B517Da8F7F8D42Dc436763898FaA8Ad" },
    StatusRegistry: { default: "0xCe5d1042f9fA72303e9F58e2962b620Dc57Ec181" },
    RevocationRoots: { default: "0x1fb289f7E77a2C9cAB906183dde5Bcd47955c714" },
  },
} as const satisfies NetworkConfig;

const baseSepoliaConfig = {
  id: "base-sepolia",
  chainId: 84532,
  name: "Base Sepolia",
  chain: baseSepolia,
  layer: "op-stack-l2",
  testnet: true,
  writable: true,
  rpcUrls: [
    { name: "publicnode", url: "https://base-sepolia-rpc.publicnode.com" },
    { name: "tenderly", url: "https://base-sepolia.gateway.tenderly.co" },
  ],
  // OP-stack "finalized": the L2 block was derived from batch data in a finalized Sepolia L1
  // block, so only an L1 finality failure can reorg it. "safe" depends on unfinalized L1 data and
  // "latest" on the sequencer alone; confirmation counts on 0.2 s blocks add no settlement.
  finality: { kind: "finalized" },
  maxBlockAgeMs: 45 * 60_000,
  blockTimeSeconds: 0.2,
  explorer: { name: "Basescan", url: "https://sepolia.basescan.org" },
  unsupportedContracts: sepoliaOnlyContracts,
  contracts: {},
} as const satisfies NetworkConfig;

const mainnetConfig = {
  id: "mainnet",
  chainId: 1,
  name: "Ethereum",
  chain: mainnet,
  layer: "l1",
  testnet: false,
  // GMA-748: read-only until the reviewed release profile exists.
  writable: false,
  rpcUrls: [
    { name: "publicnode", url: "https://ethereum-rpc.publicnode.com" },
    { name: "tenderly", url: "https://mainnet.gateway.tenderly.co" },
  ],
  finality: { kind: "finalized" },
  maxBlockAgeMs: 30 * 60_000,
  blockTimeSeconds: 12,
  explorer: { name: "Etherscan", url: "https://etherscan.io" },
  unsupportedContracts: sepoliaOnlyContracts,
  contracts: {},
} as const satisfies NetworkConfig;

export const networkConfigs = {
  sepolia: sepoliaConfig,
  "base-sepolia": baseSepoliaConfig,
  mainnet: mainnetConfig,
} as const;
export type NetworkConfigs = typeof networkConfigs;
export type AnyNetworkConfig = NetworkConfigs[NetworkId];

/** Legacy selectors from connected.ts: "testnet" is Sepolia, "production" is Ethereum mainnet. */
export const legacyNetworkAliases = { testnet: "sepolia", production: "mainnet" } as const;
export type NetworkRef = NetworkId | keyof typeof legacyNetworkAliases | NetworkConfig;

/** Local development chain IDs that may be written (anvil/hardhat defaults). */
export const localDevChainIds: readonly number[] = [31337, 1337];

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === "string" && (networkIds as readonly string[]).includes(value);
}

export function networkConfig(ref: NetworkRef): AnyNetworkConfig {
  if (typeof ref === "object" && ref !== null) {
    const known = networkConfigs[ref.id];
    if (!known || known.chainId !== ref.chainId) throw new ChainStatusError("unknown_network", String(ref.id));
    return known;
  }
  const id = ref in legacyNetworkAliases ? legacyNetworkAliases[ref as keyof typeof legacyNetworkAliases] : ref;
  if (!isNetworkId(id)) throw new ChainStatusError("unknown_network", String(ref));
  return networkConfigs[id];
}

export function networkByChainId(chainId: number): AnyNetworkConfig | undefined {
  return Object.values(networkConfigs).find((n) => n.chainId === chainId);
}

export const productionWritesDisabled =
  "Production writes are disabled pending reviewed contracts, custody, authority and proof configuration";

/**
 * The single write gate. Accepts a network id, a legacy selector, a config or a raw chain ID
 * (for adapters that only know the connected chain). Fails closed: mainnet and any other
 * non-writable network throw production_writes_disabled; an unknown chain ID throws
 * network_not_writable unless it is a local development chain.
 */
export function assertWritable(ref: NetworkRef | number): void {
  if (typeof ref === "number") {
    const known = networkByChainId(ref);
    if (known) return assertWritable(known);
    if (localDevChainIds.includes(ref)) return;
    throw new ChainStatusError("network_not_writable", `unknown chain ${ref}`);
  }
  const config = networkConfig(ref);
  if (!config.writable)
    throw new ChainStatusError("production_writes_disabled", `${productionWritesDisabled} (${config.name}, chain ${config.chainId})`);
}

export function explorerTxUrl(ref: NetworkRef, hash: string): string {
  return `${networkConfig(ref).explorer.url}/tx/${hash}`;
}
export function explorerAddressUrl(ref: NetworkRef, address: string): string {
  return `${networkConfig(ref).explorer.url}/address/${address}`;
}

/** Reader endpoints for a network's RPC URLs (defaults, or operator-supplied overrides). */
export function networkEndpoints(ref: NetworkRef, rpcUrls?: readonly RpcEndpointConfig[]): ChainEndpoint[] {
  const config = networkConfig(ref);
  return (rpcUrls ?? config.rpcUrls).map(({ name, url }) =>
    // Code-reading endpoints, so pinned-manifest checks (manifest.ts) work on network readers.
    codeReadingEndpoint(name, createPublicClient({ chain: config.chain, transport: http(url) }) as never),
  );
}

export type ChainStatusReaderOverrides = Partial<Omit<ChainStatusReaderOptions, "chainId">> & {
  /** Replace the default public RPCs, e.g. with credentialed provider URLs from secrets. Ignored when `endpoints` is given. */
  rpcUrls?: readonly RpcEndpointConfig[];
};

/**
 * A ChainStatusReader configured from the network's defaults: its chain ID (not overridable),
 * its two public RPCs, finality policy and staleness bound. Overrides replace individual options.
 */
export function chainStatusReaderFor(ref: NetworkRef, overrides: ChainStatusReaderOverrides = {}): ChainStatusReader {
  const config = networkConfig(ref);
  const { rpcUrls, ...rest } = overrides;
  return createChainStatusReader({
    finality: config.finality,
    maxBlockAgeMs: config.maxBlockAgeMs,
    now: () => Date.now(),
    ...rest,
    endpoints: rest.endpoints ?? networkEndpoints(config, rpcUrls),
    chainId: config.chainId,
  });
}
