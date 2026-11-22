/**
 * Pinned deployment manifests: `contracts/deployments/<chainId>.json` records which contract
 * runs at which address on which chain, with the runtime code hash, deploy transaction and
 * compiler/source digests. Clients refuse a contract whose chain ID or on-chain runtime code
 * hash does not match the pinned record, or for which no record exists.
 *
 * Code is read through a ChainStatusReader, so every configured RPC endpoint must agree on the
 * code at one settled block (see status.ts). The module is self-contained so network
 * configuration (ATTE-26) can wire manifests in later without changing this format.
 */
import { getAddress, isAddress, keccak256, sha256, toBytes, type Address, type Hex } from "viem";
import {
  ChainStatusError, chainEvidence, type ChainEndpoint, type ChainReadClient, type ChainSnapshot, type ChainStatusReader,
} from "./status";

export const DEPLOYMENT_MANIFEST_SCHEMA = "attest.deployment-manifest/v1";

export interface DeploymentRecord {
  /** Contract name as compiled by contracts/scripts/compile.mjs, e.g. "WorkspaceRegistryV2". */
  contract: string;
  address: Address;
  deployTx: Hex;
  blockNumber: number;
  /** keccak256 of the deployed runtime bytecode (what EXTCODEHASH returns). */
  runtimeCodeHash: Hex;
  /** sha256 of the exact Solidity source file compiled. */
  sourceDigest: Hex;
  compiler: { solc: string; evmVersion: string; optimizer: { enabled: boolean; runs?: number } };
  /** Governance root at deployment, for the release dossier. Informational; read live state for current admin. */
  administrator?: Address;
}
export interface DeploymentManifest {
  schema: typeof DEPLOYMENT_MANIFEST_SCHEMA;
  chainId: number;
  deployments: DeploymentRecord[];
}

const fail = (code: string, detail?: string): never => { throw new ChainStatusError(code, detail); };
const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const record = (v: unknown, field: string): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail("manifest_invalid", field);

/** Validate untrusted manifest JSON. Unknown schema versions and malformed fields are refused. */
export function parseDeploymentManifest(value: unknown): DeploymentManifest {
  const m = record(value, "manifest");
  if (m.schema !== DEPLOYMENT_MANIFEST_SCHEMA) fail("manifest_invalid", "schema");
  if (!Number.isSafeInteger(m.chainId) || (m.chainId as number) <= 0) fail("manifest_invalid", "chainId");
  if (!Array.isArray(m.deployments)) fail("manifest_invalid", "deployments");
  const deployments = (m.deployments as unknown[]).map((raw, i): DeploymentRecord => {
    const d = record(raw, `deployments[${i}]`);
    const at = (field: string) => `deployments[${i}].${field}`;
    if (typeof d.contract !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(d.contract)) fail("manifest_invalid", at("contract"));
    if (typeof d.address !== "string" || !isAddress(d.address)) fail("manifest_invalid", at("address"));
    if (!isHash(d.deployTx)) fail("manifest_invalid", at("deployTx"));
    if (!Number.isSafeInteger(d.blockNumber) || (d.blockNumber as number) < 0) fail("manifest_invalid", at("blockNumber"));
    if (!isHash(d.runtimeCodeHash)) fail("manifest_invalid", at("runtimeCodeHash"));
    // keccak256 of empty code: an EOA or not-yet-deployed address can never be pinned.
    if ((d.runtimeCodeHash as string).toLowerCase() === keccak256("0x")) fail("manifest_invalid", at("runtimeCodeHash"));
    if (!isHash(d.sourceDigest)) fail("manifest_invalid", at("sourceDigest"));
    const c = record(d.compiler, at("compiler"));
    const o = record(c.optimizer, at("compiler.optimizer"));
    if (typeof c.solc !== "string" || typeof c.evmVersion !== "string" || typeof o.enabled !== "boolean" ||
      (o.runs !== undefined && !Number.isSafeInteger(o.runs))) fail("manifest_invalid", at("compiler"));
    if (d.administrator !== undefined && (typeof d.administrator !== "string" || !isAddress(d.administrator)))
      fail("manifest_invalid", at("administrator"));
    return {
      contract: d.contract as string, address: getAddress(d.address as string), deployTx: (d.deployTx as Hex).toLowerCase() as Hex,
      blockNumber: d.blockNumber as number, runtimeCodeHash: (d.runtimeCodeHash as Hex).toLowerCase() as Hex,
      sourceDigest: (d.sourceDigest as Hex).toLowerCase() as Hex,
      compiler: { solc: c.solc as string, evmVersion: c.evmVersion as string,
        optimizer: { enabled: o.enabled as boolean, ...(o.runs === undefined ? {} : { runs: o.runs as number }) } },
      ...(d.administrator === undefined ? {} : { administrator: getAddress(d.administrator as string) }),
    };
  });
  const keys = deployments.map((d) => d.address.toLowerCase());
  if (new Set(keys).size !== keys.length) fail("manifest_invalid", "duplicate address");
  return { schema: DEPLOYMENT_MANIFEST_SCHEMA, chainId: m.chainId as number, deployments };
}

/** Repository path of the manifest for a chain. */
export const deploymentManifestPath = (chainId: number) => `contracts/deployments/${chainId}.json`;

/** Load and validate a chain's manifest. `fetchJson` returns null when the file does not exist. */
export async function loadDeploymentManifest(
  chainId: number,
  fetchJson: (path: string) => Promise<unknown | null>,
): Promise<DeploymentManifest> {
  const raw = await fetchJson(deploymentManifestPath(chainId));
  if (raw === null || raw === undefined) fail("manifest_missing", `chain ${chainId}`);
  const manifest = parseDeploymentManifest(raw);
  if (manifest.chainId !== chainId) fail("manifest_chain_mismatch");
  return manifest;
}

/** The pinned record for (chain, contract, address), or a refusal. A missing manifest is refused, never skipped. */
export function pinnedDeployment(
  manifest: DeploymentManifest | null | undefined,
  expected: { chainId: number; contract: string; address: Address },
): DeploymentRecord {
  if (!manifest) return fail("manifest_missing");
  if (manifest.chainId !== expected.chainId) fail("manifest_chain_mismatch");
  const found = manifest.deployments.find((d) => d.address.toLowerCase() === expected.address.toLowerCase());
  if (!found) return fail("manifest_missing", `no record for ${expected.address}`);
  if (found.contract !== expected.contract) fail("manifest_contract_mismatch", `${found.contract} pinned, ${expected.contract} expected`);
  return found;
}

export const runtimeCodeHash = (code: Hex) => keccak256(code);
/** sha256 of a Solidity source file, for DeploymentRecord.sourceDigest. */
export const sourceDigest = (source: string) => sha256(toBytes(source));

/** A reader endpoint client that can also read contract code. */
export interface CodeReadClient extends ChainReadClient {
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
}
/** Like status.ts publicClientEndpoint, plus getCode, which manifest checks need. */
export function codeReadingEndpoint(
  name: string,
  client: {
    getChainId(): Promise<number>;
    getBlock(args: never): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
    readContract(args: never): Promise<unknown>;
    getCode(args: never): Promise<Hex | undefined>;
  },
): ChainEndpoint {
  const wrapped: CodeReadClient = {
    getChainId: () => client.getChainId(),
    getBlock: (args) => client.getBlock(args as never),
    readContract: (args) => client.readContract(args as never),
    getCode: (args) => client.getCode(args as never),
  };
  return { name, client: wrapped };
}

/** Runtime code hash at a block, from one endpoint client. Fails if the endpoint cannot read code. */
export async function codeHashAt(client: ChainReadClient, address: Address, blockNumber: bigint): Promise<Hex | null> {
  if (typeof (client as Partial<CodeReadClient>).getCode !== "function")
    fail("code_read_unsupported", "use codeReadingEndpoint for reader endpoints");
  const code = await (client as CodeReadClient).getCode({ address, blockNumber });
  return code && code !== "0x" ? runtimeCodeHash(code) : null;
}

/** Compare a code hash read from chain with the pinned record. */
export function assertPinnedCode(record: DeploymentRecord, codeHash: Hex | null) {
  if (codeHash === null) fail("no_code", record.address);
  if (codeHash!.toLowerCase() !== record.runtimeCodeHash) fail("codehash_mismatch", record.address);
}

export interface VerifiedDeployment {
  record: DeploymentRecord;
  snapshot: ChainSnapshot;
  evidence: ReturnType<typeof chainEvidence>;
}

/**
 * Verify that the pinned contract is what runs on chain: the reader's chain ID equals the
 * manifest's (every endpoint is checked by snapshot()), and every endpoint returns the pinned
 * runtime code hash at one settled block.
 */
export async function verifyPinnedDeployment(
  reader: ChainStatusReader,
  manifest: DeploymentManifest | null | undefined,
  expected: { contract: string; address: Address },
  snapshot?: ChainSnapshot,
): Promise<VerifiedDeployment> {
  const record = pinnedDeployment(manifest, { chainId: reader.options.chainId, ...expected });
  const at = snapshot ?? (await reader.snapshot());
  const hash = await reader.read(at, (client, blockNumber) => codeHashAt(client, record.address, blockNumber));
  assertPinnedCode(record, hash);
  return { record, snapshot: at, evidence: chainEvidence(at) };
}
