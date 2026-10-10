import { parseAbi, type Address, type EIP1193Provider, type Hex } from "viem";
import { clients, assertContext } from "./connected";
import type { JourneyArtifact } from "./journey";
export const institutionAbi = parseAbi([
  "constructor(address[4] wallets,bytes32[3] keys) payable",
  "function institutions(uint256) view returns(address)",
  "function credentialKeys(uint256) view returns(bytes32)",
  "function records(address,bytes32,uint8) view returns(bytes32 content,bytes32 holderKey,uint64 validUntil,bool revoked)",
  "function receipts(address,bytes32) view returns(bool)",
  "function grant(address holder,bytes32 journey,uint8 institution,bytes32 content,bytes32 holderKey,uint64 validUntil)",
  "function revoke(address holder,bytes32 journey,uint8 institution)",
  "function recordDecision(address holder,bytes32 request,bytes32 proofCommitment)",
  "function fundInstitutions() payable",
]);
export async function deployInstitutions(
  provider: EIP1193Provider,
  account: Address,
  artifact: JourneyArtifact,
  wallets: readonly [Address, Address, Address, Address],
  keys: readonly [Hex, Hex, Hex],
  value: bigint,
) {
  await assertContext(provider, "testnet", account, true);
  return clients(provider, "testnet").wallet.deployContract({
    account,
    abi: institutionAbi,
    bytecode: artifact.bytecode,
    args: [wallets, keys],
    value,
  });
}
export async function validateInstitutions(
  provider: EIP1193Provider,
  account: Address,
  registry: Address,
  artifact: JourneyArtifact,
  wallets: readonly string[],
  keys: readonly string[],
) {
  await assertContext(provider, "testnet", account);
  const reader = clients(provider, "testnet").reader;
  if (
    (await reader.getCode({ address: registry })) !== artifact.deployedBytecode
  )
    throw new Error("Registry bytecode does not match the institutional demo");
  const actual = await Promise.all(
    wallets.map((_, i) =>
      reader.readContract({
        address: registry,
        abi: institutionAbi,
        functionName: "institutions",
        args: [BigInt(i)],
      }),
    ),
  );
  const signing = await Promise.all(
    keys.map((_, i) =>
      reader.readContract({
        address: registry,
        abi: institutionAbi,
        functionName: "credentialKeys",
        args: [BigInt(i)],
      }),
    ),
  );
  if (
    actual.some((a, i) => a.toLowerCase() !== wallets[i]?.toLowerCase()) ||
    signing.some((k, i) => k !== keys[i])
  )
    throw new Error(
      "Registry belongs to different institution wallets or signing keys",
    );
}
