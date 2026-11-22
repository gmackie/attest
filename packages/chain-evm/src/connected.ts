import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { sepolia, mainnet } from "viem/chains";
// networks.ts -> status.ts -> connected.ts is an import cycle: only use its exports inside functions.
import { assertWritable, networkConfig, type NetworkId } from "./networks";
/** Legacy wallet-UI selector: "testnet" is Sepolia, "production" is Ethereum mainnet (write-gated). */
export type Network = "testnet" | "production";
/** A legacy selector or any configured network id (see networks.ts). */
export type NetworkSelector = Network | NetworkId;
/** Backwards-compatible viem chains for the legacy selectors (same objects as networkConfigs[...].chain). */
export const networks = { testnet: sepolia, production: mainnet };
export const registryAbi = parseAbi([
  "function administrator() view returns (address)",
  "function issuers(address,bytes32) view returns (bool enabled,bytes32 signingKeyHash)",
  "function verifiers(address) view returns (bool)",
  "function anchors(bytes32) view returns (address issuer,bytes32 scope,bytes32 commitment,uint64 validUntil,bool revoked)",
  "function usedRequests(address,bytes32) view returns (bool)",
  "function configureIssuer(address issuer,bytes32 scope,bytes32 signingKeyHash,bool enabled)",
  "function configureVerifier(address verifier,bool enabled)",
  "function anchor(bytes32 id,bytes32 scope,bytes32 commitment,uint64 validUntil)",
  "function revoke(bytes32 id)",
  "function recordDecision(bytes32 requestCommitment,bytes32 proofCommitment,bool satisfied)",
]);
export function checkedAddress(value: string): Address {
  if (!isAddress(value)) throw new Error("Enter a valid EVM address");
  return getAddress(value);
}
export function checkedHash(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error("Expected a 32-byte hexadecimal commitment");
  return value as Hex;
}
export function custodyNamespace(network: NetworkSelector, address: string) {
  return `attest:vault:v1:${networkConfig(network).chainId}:${checkedAddress(address).toLowerCase()}`;
}
export function clients(provider: EIP1193Provider, network: NetworkSelector) {
  // Typed as the Sepolia chain so callers keep viem's precise request types; the runtime
  // chain is the selected network's (chain ID checked by assertContext before any write).
  const chain = networkConfig(network).chain as typeof sepolia;
  return {
    wallet: createWalletClient({ chain, transport: custom(provider) }),
    reader: createPublicClient({ chain, transport: custom(provider) }),
  };
}
export async function assertContext(
  provider: EIP1193Provider,
  network: NetworkSelector,
  account: Address,
  writing = false,
) {
  // The single write gate runs before any provider access.
  if (writing) assertWritable(network);
  const config = networkConfig(network);
  const [chain, accounts] = await Promise.all([
    provider.request({ method: "eth_chainId" }),
    provider.request({ method: "eth_accounts" }),
  ]);
  if (Number(chain) !== config.chainId)
    throw new Error(`Switch your wallet to ${config.chain.name}`);
  if (!accounts.some((a) => a.toLowerCase() === account.toLowerCase()))
    throw new Error(
      "Account changed or disconnected. Reconnect before continuing.",
    );
}
export type RegistryAction = {
  functionName:
    | "configureIssuer"
    | "configureVerifier"
    | "anchor"
    | "revoke"
    | "recordDecision";
  args: readonly unknown[];
};
export async function submitRegistryAction(
  provider: EIP1193Provider,
  network: NetworkSelector,
  account: Address,
  registry: Address,
  action: RegistryAction,
) {
  await assertContext(provider, network, account, true);
  const { wallet, reader } = clients(provider, network);
  if (!(await reader.getCode({ address: registry })))
    throw new Error("No registry code at this address");
  // Simulation catches on-chain authorization, scope, expiry and replay failures before signing.
  const simulated = await reader.simulateContract({
    address: registry,
    abi: registryAbi,
    functionName: action.functionName,
    args: action.args as never,
    account,
  });
  await assertContext(provider, network, account, true);
  return wallet.writeContract(simulated.request);
}
export async function deployRegistry(
  provider: EIP1193Provider,
  network: NetworkSelector,
  account: Address,
  bytecode: string,
) {
  await assertContext(provider, network, account, true);
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode))
    throw new Error("Invalid registry build artifact");
  return clients(provider, network).wallet.deployContract({
    account,
    abi: registryAbi,
    bytecode: bytecode as Hex,
  });
}
export type { EIP1193Provider, Address, Hex };
