import { parseAbi, type Address, type EIP1193Provider, type Hex } from "viem";
import { assertContext, clients } from "./connected";
export const journeyAbi = parseAbi([
  "function profile() pure returns (string)",
  "function records(address,bytes32,uint8) view returns (bytes32 content,bytes32 holderKey,uint64 validUntil,bool revoked)",
  "function receipts(address,bytes32) view returns (bool)",
  "function grant(bytes32 journey,uint8 institution,bytes32 content,bytes32 holderKey,uint64 validUntil)",
  "function revoke(bytes32 journey,uint8 institution)",
  "function recordReceipt(bytes32 request,bytes32 proofCommitment)",
]);
export type JourneyArtifact = { bytecode: Hex; deployedBytecode: Hex };
export async function validateJourneyRegistry(
  provider: EIP1193Provider,
  account: Address,
  registry: Address,
  artifact: JourneyArtifact,
) {
  await assertContext(provider, "testnet", account);
  const code = await clients(provider, "testnet").reader.getCode({
    address: registry,
  });
  if (
    !artifact.deployedBytecode?.startsWith("0x") ||
    code !== artifact.deployedBytecode
  )
    throw new Error(
      "This address does not contain the supported fictional demo registry. Check the invitation link.",
    );
}
export async function journeyWrite(
  provider: EIP1193Provider,
  account: Address,
  registry: Address,
  artifact: JourneyArtifact,
  functionName: "grant" | "revoke" | "recordReceipt",
  args: readonly unknown[],
) {
  await validateJourneyRegistry(provider, account, registry, artifact);
  const { reader, wallet } = clients(provider, "testnet");
  const simulated = await reader.simulateContract({
    account,
    address: registry,
    abi: journeyAbi,
    functionName,
    args: args as never,
  });
  await assertContext(provider, "testnet", account, true);
  return wallet.writeContract(simulated.request);
}
export async function journeyDeploy(
  provider: EIP1193Provider,
  account: Address,
  artifact: JourneyArtifact,
) {
  await assertContext(provider, "testnet", account, true);
  if (!/^0x[0-9a-fA-F]+$/.test(artifact.bytecode))
    throw new Error("Invalid demo build artifact");
  return clients(provider, "testnet").wallet.deployContract({
    account,
    abi: journeyAbi,
    bytecode: artifact.bytecode,
  });
}
export type JourneyChainRecord = {
  content: string;
  holderKey: string;
  validUntil: bigint;
  revoked: boolean;
};
export async function journeyRecords(
  provider: EIP1193Provider,
  account: Address,
  registry: Address,
  artifact: JourneyArtifact,
  journey: Hex,
) {
  await validateJourneyRegistry(provider, account, registry, artifact);
  const reader = clients(provider, "testnet").reader;
  const block = await reader.getBlock({ blockTag: "latest" });
  const records = await Promise.all(
    [0, 1, 2].map(async (institution) => {
      const r = await reader.readContract({
        address: registry,
        abi: journeyAbi,
        functionName: "records",
        args: [account, journey, institution],
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
  return {
    records,
    block: block.number.toString(),
    timestamp: block.timestamp,
  };
}
