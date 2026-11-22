#!/usr/bin/env -S pnpm exec tsx
/**
 * Deploy Attest's network-independent contracts (WorkspaceRegistry and DecisionLogAnchor) to a
 * configured testnet and print the contract manifest JSON on stdout (ATTE-26).
 *
 *   pnpm --filter @attest/contracts build
 *   ATTEST_DEPLOYER_PRIVATE_KEY=0x... pnpm exec tsx packages/chain-evm/scripts/deploy-network.mjs \
 *     --network base-sepolia [--rpc-url URL] [--administrator 0x...] [--confirmations 2] [--key-env NAME]
 *
 * The signer is injected: either an EIP-1193 provider (programmatic `deployNetwork({ provider })`)
 * or a private key read from an environment variable. The script never writes key material or
 * any other file. Mainnet (and every non-writable network) is refused by assertWritable before
 * any provider or RPC access. After each deployment it checks the receipt, that the runtime code
 * matches the compiled artifact (immutables masked, then checked by value) and the administrator.
 * The demo registries (Institution, Industry, DemoJourney) and the
 * economy contracts are Sepolia-only by constructor and are not deployed here.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, custom, getAddress, http, isAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertWritable, networkConfig } from "../src/networks.ts";

export const deployedContracts = ["WorkspaceRegistry", "DecisionLogAnchor"];
const artifactsDir = new URL("../../../contracts/artifacts/", import.meta.url);

async function artifact(name) {
  const file = new URL(`${name}.json`, artifactsDir);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`Missing ${name} artifact. Run pnpm --filter @attest/contracts build first.`);
  }
  if (!/^0x[0-9a-fA-F]+$/.test(parsed.bytecode ?? "") || !/^0x[0-9a-fA-F]+$/.test(parsed.deployedBytecode ?? ""))
    throw new Error(`Invalid ${name} artifact (rebuild with pnpm --filter @attest/contracts build)`);
  return parsed;
}

/**
 * keccak256 of runtime code with every immutable slot zeroed (solc immutableReferences), so
 * on-chain code can be compared with the compiled artifact. Immutable values are checked separately.
 */
export function maskedCodeHash(code, immutableReferences = {}) {
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const refs of Object.values(immutableReferences))
    for (const { start, length } of refs) {
      if (start + length > bytes.length) throw new Error("Immutable reference outside the code");
      bytes.fill(0, start, start + length);
    }
  return keccak256(`0x${bytes.toString("hex")}`);
}

/**
 * @param {{
 *   network: string,
 *   provider?: import("viem").EIP1193Provider,
 *   privateKey?: `0x${string}`,
 *   rpcUrl?: string,
 *   administrator?: string,
 *   confirmations?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export async function deployNetwork(options) {
  // Gate first: nothing below runs for mainnet or an unknown network.
  assertWritable(options.network);
  const config = networkConfig(options.network);
  const log = options.log ?? (() => {});
  const confirmations = options.confirmations ?? 2;
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 64)
    throw new Error("confirmations must be between 1 and 64");
  if (Boolean(options.provider) === Boolean(options.privateKey))
    throw new Error("Pass exactly one signer: an EIP-1193 provider or a private key");
  if (options.administrator !== undefined && !isAddress(options.administrator))
    throw new Error("administrator must be an EVM address");
  for (const name of deployedContracts)
    if (config.unsupportedContracts.includes(name)) throw new Error(`${name} is not deployable on ${config.name}`);

  let account, transport;
  if (options.provider) {
    transport = custom(options.provider);
    const accounts = await options.provider.request({ method: "eth_requestAccounts" });
    if (!accounts?.[0]) throw new Error("The provider exposed no account");
    account = getAddress(accounts[0]);
  } else {
    if (!/^0x[0-9a-fA-F]{64}$/.test(options.privateKey)) throw new Error("Malformed private key");
    account = privateKeyToAccount(options.privateKey);
    transport = http(options.rpcUrl ?? config.rpcUrls[0].url);
  }
  const reader = createPublicClient({ chain: config.chain, transport });
  const wallet = createWalletClient({ chain: config.chain, transport, account });
  const chainId = await reader.getChainId();
  if (chainId !== config.chainId)
    throw new Error(`chain_mismatch: signer is on chain ${chainId}, expected ${config.name} (${config.chainId})`);
  const deployer = typeof account === "string" ? account : account.address;
  const administrator = getAddress(options.administrator ?? deployer);

  const contracts = {}, transactions = {};
  for (const name of deployedContracts) {
    const { abi, bytecode, deployedBytecode, immutableReferences } = await artifact(name);
    const args = name === "DecisionLogAnchor" ? [administrator] : [];
    log(`deploying ${name} on ${config.name} from ${deployer}`);
    const hash = await wallet.deployContract({ abi, bytecode, args, account, chain: config.chain });
    const receipt = await reader.waitForTransactionReceipt({ hash, confirmations });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deployment reverted: ${hash}`);
    const address = getAddress(receipt.contractAddress);
    const code = await reader.getCode({ address });
    if (!code || code === "0x") throw new Error(`${name} has no code at ${address}`);
    // Runtime code must be exactly the compiled artifact (immutables masked).
    const codeHash = maskedCodeHash(code, immutableReferences);
    if (code.length !== deployedBytecode.length || codeHash !== maskedCodeHash(deployedBytecode, immutableReferences))
      throw new Error(`${name} runtime code at ${address} does not match the compiled artifact`);
    const admin = await reader.readContract({ address, abi, functionName: "administrator" });
    // WorkspaceRegistry's administrator is the deployer and immutable.
    const expected = name === "DecisionLogAnchor" ? administrator : deployer;
    if (getAddress(admin) !== getAddress(expected)) throw new Error(`${name} administrator is ${admin}, expected ${expected}`);
    contracts[name] = { default: address };
    transactions[name] = { hash, blockNumber: receipt.blockNumber.toString(), administrator: getAddress(admin), runtimeCodeHash: keccak256(code) };
    log(`${name} at ${address} (${config.explorer.url}/address/${address})`);
  }
  return { version: 1, network: config.id, chainId: config.chainId, deployer, contracts, transactions };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument ${flag}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    out[flag.slice(2)] = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.network) throw new Error("--network is required (sepolia or base-sepolia)");
  assertWritable(args.network);
  const keyEnv = args["key-env"] ?? "ATTEST_DEPLOYER_PRIVATE_KEY";
  const privateKey = process.env[keyEnv];
  if (!privateKey) throw new Error(`Set ${keyEnv} to the deployer's private key`);
  const manifest = await deployNetwork({
    network: args.network,
    privateKey,
    ...(args["rpc-url"] ? { rpcUrl: args["rpc-url"] } : {}),
    ...(args.administrator ? { administrator: args.administrator } : {}),
    ...(args.confirmations ? { confirmations: Number(args.confirmations) } : {}),
    log: (m) => console.error(m),
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // Short message only: never print the environment or key material, and viem's long
    // messages can echo a credentialed --rpc-url.
    console.error(e?.shortMessage ?? (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
