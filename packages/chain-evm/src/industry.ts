import { parseAbi, type EIP1193Provider, type Address, type Hex } from "viem";
import { clients, assertContext } from "./connected";
import { institutionAbi } from "./institution";
import type { JourneyArtifact } from "./journey";
export const industryAbi = [
  ...institutionAbi.filter((x) => x.type !== "constructor"),
  ...parseAbi([
    "constructor(bytes32 profile_,address[6] wallets,bytes32[5] keys) payable",
    "function profile() view returns(bytes32)",
  ]),
] as const;
export async function validateIndustryRegistry(
  provider: EIP1193Provider,
  account: Address,
  registry: Address,
  artifact: JourneyArtifact,
  profile: Hex,
  wallets: readonly string[],
  keys: readonly string[],
) {
  await assertContext(provider, "testnet", account);
  const reader = clients(provider, "testnet").reader;
  if (
    (await reader.getCode({ address: registry })) !== artifact.deployedBytecode
  )
    throw new Error("Not an Attest industry registry");
  const [actualProfile, actualWallets, actualKeys] = await Promise.all([
    reader.readContract({
      address: registry,
      abi: industryAbi,
      functionName: "profile",
    }),
    Promise.all(
      wallets.map((_, i) =>
        reader.readContract({
          address: registry,
          abi: industryAbi,
          functionName: "institutions",
          args: [BigInt(i)],
        }),
      ),
    ),
    Promise.all(
      keys.map((_, i) =>
        reader.readContract({
          address: registry,
          abi: industryAbi,
          functionName: "credentialKeys",
          args: [BigInt(i)],
        }),
      ),
    ),
  ]);
  if (
    actualProfile !== profile ||
    actualWallets.some(
      (v, i) => v.toLowerCase() !== wallets[i]?.toLowerCase(),
    ) ||
    actualKeys.some((v, i) => v !== keys[i])
  )
    throw new Error(
      "Registry belongs to another industry or institution directory",
    );
}
export async function deployIndustryRegistry(
  provider: EIP1193Provider,
  account: Address,
  artifact: JourneyArtifact,
  profile: Hex,
  wallets: readonly [Address, Address, Address, Address, Address, Address],
  keys: readonly [Hex, Hex, Hex, Hex, Hex],
  value: bigint,
) {
  await assertContext(provider, "testnet", account, true);
  return clients(provider, "testnet").wallet.deployContract({
    account,
    abi: industryAbi,
    bytecode: artifact.bytecode,
    args: [profile, wallets, keys],
    value,
  });
}
export async function readIndustryRecords(
  provider: EIP1193Provider,
  account: Address,
  registry: Address,
  journey: Hex,
) {
  await assertContext(provider, "testnet", account);
  const reader = clients(provider, "testnet").reader,
    block = await reader.getBlock({ blockTag: "latest" });
  const records = await Promise.all(
    [0, 1, 2, 3, 4].map(async (i) => {
      const r = await reader.readContract({
        address: registry,
        abi: industryAbi,
        functionName: "records",
        args: [account, journey, i],
        blockNumber: block.number,
      });
      return {
        content: r[0],
        holderKey: r[1],
        validUntil: r[2],
        revoked: r[3],
      };
    }),
  );
  return { records, block: block.number, timestamp: block.timestamp };
}
