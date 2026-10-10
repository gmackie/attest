import {
  encodeDeployData,
  encodeFunctionData,
  type Address,
  type Hex,
  type EIP1193Provider,
} from "viem";
import { assertContext, clients } from "./connected";
import { institutionAbi, validateInstitutions } from "./institution";
import { industryAbi, validateIndustryRegistry } from "./industry";
import type { JourneyArtifact } from "./journey";
export type HostProfile = {
  id: string;
  wallets: Address[];
  keys: Hex[];
  artifact: JourneyArtifact;
  profile?: Hex;
};
export type HostOperation = {
  kind: "deploy" | "fund";
  data: Hex;
  to?: Address;
  value: bigint;
};
export const targetInstitutionBalance = 1000000000000000n; // 0.001 test ETH
export function fundingNeeded(
  balances: readonly bigint[],
  target = targetInstitutionBalance,
) {
  if (!balances.length || target < 0n || balances.some((b) => b < 0n))
    throw new Error("Invalid funding inputs");
  // Registry splits equally. Bring the lowest wallet to target; others may receive more.
  const min = balances.reduce((a, b) => (a < b ? a : b));
  return min < target ? (target - min) * BigInt(balances.length) : 0n;
}
export async function validateHostRegistry(
  provider: EIP1193Provider,
  account: Address,
  spec: HostProfile,
  registry: Address,
) {
  if (spec.profile)
    return validateIndustryRegistry(
      provider,
      account,
      registry,
      spec.artifact,
      spec.profile,
      spec.wallets,
      spec.keys,
    );
  return validateInstitutions(
    provider,
    account,
    registry,
    spec.artifact,
    spec.wallets,
    spec.keys,
  );
}
export function hostOperation(
  spec: HostProfile,
  value: bigint,
  registry?: Address,
): HostOperation {
  if (value < 0n || value > 100000000000000000n)
    throw new Error("Funding exceeds 0.1 Sepolia ETH per registry");
  if (registry)
    return {
      kind: "fund",
      to: registry,
      value,
      data: encodeFunctionData({
        abi: institutionAbi,
        functionName: "fundInstitutions",
      }),
    };
  const abi = spec.profile ? industryAbi : institutionAbi;
  const args = spec.profile
    ? [spec.profile, spec.wallets, spec.keys]
    : [spec.wallets, spec.keys];
  return {
    kind: "deploy",
    value,
    data: encodeDeployData({
      abi,
      bytecode: spec.artifact.bytecode,
      args: args as never,
    }),
  };
}
export async function sendHostOperation(
  provider: EIP1193Provider,
  account: Address,
  operation: HostOperation,
  beforeSend: () => void = () => {},
) {
  await assertContext(provider, "testnet", account, true);
  const { reader, wallet } = clients(provider, "testnet");
  const request = {
    account,
    data: operation.data,
    value: operation.value,
    ...(operation.to ? { to: operation.to } : {}),
  };
  const gas = await reader.estimateGas(request);
  const fees = await reader.estimateFeesPerGas();
  const balance = await reader.getBalance({ address: account });
  if (balance < operation.value + gas * (fees.maxFeePerGas ?? 0n))
    throw new Error("Host needs more Sepolia test ETH for funding plus gas");
  await assertContext(provider, "testnet", account, true);
  beforeSend();
  return wallet.sendTransaction(request);
}
export async function recoverHostOperation(
  provider: EIP1193Provider,
  account: Address,
  spec: HostProfile,
  operation: HostOperation,
  hash: Hex,
) {
  await assertContext(provider, "testnet", account);
  const reader = clients(provider, "testnet").reader;
  const tx = await reader.getTransaction({ hash });
  if (
    tx.from.toLowerCase() !== account.toLowerCase() ||
    tx.input !== operation.data ||
    tx.value !== operation.value ||
    (tx.to?.toLowerCase() ?? null) !== (operation.to?.toLowerCase() ?? null)
  )
    throw new Error(
      "Saved transaction does not match the expected host operation",
    );
  const receipt = await reader.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 120000,
  });
  if (receipt.transactionHash !== hash)
    throw new Error(
      "Transaction was replaced. Inspect the replacement before continuing.",
    );
  if (receipt.status !== "success")
    throw new Error(
      "Saved transaction reverted. Inspect it in the explorer before replacing it.",
    );
  const registry = operation.to ?? receipt.contractAddress;
  if (!registry) throw new Error("No registry in deployment receipt");
  await validateHostRegistry(provider, account, spec, registry);
  return registry;
}
