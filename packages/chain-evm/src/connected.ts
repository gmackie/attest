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
export type Network = "testnet" | "production";
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
export function custodyNamespace(network: Network, address: string) {
  return `attest:vault:v1:${networks[network].id}:${checkedAddress(address).toLowerCase()}`;
}
export function clients(provider: EIP1193Provider, network: Network) {
  return {
    wallet: createWalletClient({
      chain: networks[network],
      transport: custom(provider),
    }),
    reader: createPublicClient({
      chain: networks[network],
      transport: custom(provider),
    }),
  };
}
export async function assertContext(
  provider: EIP1193Provider,
  network: Network,
  account: Address,
  writing = false,
) {
  if (writing && network === "production")
    throw new Error(
      "Production writes are disabled pending reviewed contracts, custody, authority and proof configuration",
    );
  const [chain, accounts] = await Promise.all([
    provider.request({ method: "eth_chainId" }),
    provider.request({ method: "eth_accounts" }),
  ]);
  if (Number(chain) !== networks[network].id)
    throw new Error(`Switch your wallet to ${networks[network].name}`);
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
  network: Network,
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
  network: Network,
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
