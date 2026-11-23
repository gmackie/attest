#!/usr/bin/env node
/**
 * Deploy the trust-stack contracts (DecisionLogAnchor, StatusRegistry, RevocationRoots) to a
 * writable testnet and print an `attest.deployment-manifest/v1` document (contracts/deployments/
 * <chainId>.json) to stdout.
 *
 *   ATTEST_DEPLOYER_PRIVATE_KEY=0x... node packages/chain-evm/scripts/deploy-trust-stack.mjs \
 *     --network sepolia [--contracts DecisionLogAnchor,StatusRegistry] [--administrator 0x...]
 *
 * Mainnet is refused before the key is read. The key is read from the environment only and never
 * written anywhere. After each deployment the runtime code hash is compared with the compiled
 * `deployedBytecode` (these contracts have no immutables) and the administrator is read back.
 * Progress goes to stderr; only the manifest goes to stdout.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import {
  createPublicClient, createWalletClient, encodeDeployData, getAddress, http, isAddress, keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

const networks = {
  sepolia: { chain: sepolia, rpc: "https://ethereum-sepolia-rpc.publicnode.com" },
  "base-sepolia": { chain: baseSepolia, rpc: "https://base-sepolia-rpc.publicnode.com" },
};
const supported = ["DecisionLogAnchor", "StatusRegistry", "RevocationRoots", "WorkspaceRegistryV2"];
const withAdministrator = new Set(["DecisionLogAnchor", "RevocationRoots", "WorkspaceRegistryV2"]);
// Must match contracts/scripts/compile.mjs.
const optimized = new Set(["WorkspaceRegistryV2"]);

const { values } = parseArgs({
  options: {
    network: { type: "string" },
    contracts: { type: "string", default: supported.join(",") },
    administrator: { type: "string" },
    "rpc-url": { type: "string" },
    "max-fee-wei": { type: "string", default: "1000000000" },
  },
});
const config = networks[values.network ?? ""];
if (!config) throw new Error(`--network must be one of ${Object.keys(networks).join(", ")} (mainnet is refused)`);
const names = values.contracts.split(",").map((s) => s.trim()).filter(Boolean);
for (const n of names) if (!supported.includes(n)) throw new Error(`unsupported contract ${n}`);
if (values.administrator !== undefined && !isAddress(values.administrator)) throw new Error("--administrator must be an address");

const key = process.env.ATTEST_DEPLOYER_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("ATTEST_DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
const account = privateKeyToAccount(key);
const transport = http(values["rpc-url"] ?? config.rpc);
const reader = createPublicClient({ chain: config.chain, transport });
const writer = createWalletClient({ chain: config.chain, transport, account });
const chainId = await reader.getChainId();
if (chainId !== config.chain.id) throw new Error(`RPC reports chain ${chainId}, expected ${config.chain.id}`);
const administrator = getAddress(values.administrator ?? account.address);

const root = new URL("../../../", import.meta.url);
// solc is a dependency of the contracts package, which compiled the artifacts.
const solcVersion = createRequire(new URL("contracts/package.json", root))("solc/package.json").version;
const block = await reader.getBlock();
const maxFeePerGas = BigInt(values["max-fee-wei"]);
const maxPriorityFeePerGas = (block.baseFeePerGas ?? 0n) < maxFeePerGas ? 2n : 0n;
const deployments = [];

for (const name of names) {
  const artifact = JSON.parse(await readFile(new URL(`contracts/artifacts/${name}.json`, root), "utf8"));
  if ((artifact.immutableReferences && Object.keys(artifact.immutableReferences).length) || !artifact.deployedBytecode)
    throw new Error(`${name}: artifact needs deployedBytecode and no immutables`);
  const source = await readFile(new URL(`contracts/src/${name}.sol`, root));
  const args = withAdministrator.has(name) ? [administrator] : [];
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const gas = (await reader.estimateGas({ account: account.address, data })) * 12n / 10n;
  console.error(`deploying ${name} on ${config.chain.name} from ${account.address} (gas ≤ ${gas})`);
  const hash = await writer.sendTransaction({ data, gas, maxFeePerGas, maxPriorityFeePerGas });
  const receipt = await reader.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name}: deployment ${hash} failed`);
  const address = getAddress(receipt.contractAddress);
  const code = await reader.getCode({ address, blockNumber: receipt.blockNumber });
  const runtimeCodeHash = keccak256(code ?? "0x");
  if (runtimeCodeHash !== keccak256(artifact.deployedBytecode)) throw new Error(`${name}: runtime code does not match the artifact`);
  if (withAdministrator.has(name)) {
    const actual = await reader.readContract({
      address, abi: artifact.abi, functionName: "administrator", blockNumber: receipt.blockNumber,
    });
    if (getAddress(actual) !== administrator) throw new Error(`${name}: administrator is ${actual}`);
  }
  console.error(`  ${name} at ${address} (tx ${hash}, block ${receipt.blockNumber})`);
  deployments.push({
    contract: name, address, deployTx: hash, blockNumber: Number(receipt.blockNumber), runtimeCodeHash,
    sourceDigest: `0x${createHash("sha256").update(source).digest("hex")}`,
    compiler: { solc: solcVersion, evmVersion: "paris", optimizer: optimized.has(name) ? { enabled: true, runs: 200 } : { enabled: false } },
    ...(withAdministrator.has(name) ? { administrator } : {}),
  });
}

console.log(JSON.stringify({ schema: "attest.deployment-manifest/v1", chainId, deployments }, null, 2));
