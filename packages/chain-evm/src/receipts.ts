/**
 * PresentationReceipts client helpers (ATTE-25, experimental, unaudited).
 *
 * A receipt is recorded only after the contract verifies a Groth16 proof for
 * zk/circuits/presentation-receipt-v1.circom against the issuer's live
 * PrivateClaimRoots root. The proof does NOT open the sha256 request digest:
 * a consumer must still compare the stored issuer, attribute, threshold and
 * subject binding with its own attest.proof-request/v1 request
 * (`receiptSatisfies`). See specs/presentation-receipts.md.
 */
import { isAddress, parseAbi, sha256, stringToBytes, type Address, type Hex } from "viem";

export const presentationReceiptsAbi = parseAbi([
  "constructor(address roots_,address verifier_)",
  "function roots() view returns (address)",
  "function verifier() view returns (address)",
  "function nullifierUsed(uint256) view returns (bool)",
  "function hasReceipt(bytes32 requestDigest) view returns (bool)",
  "function receiptOf(bytes32 requestDigest) view returns ((address issuer,uint64 blockNumber,uint64 validThrough,uint256 root,uint256 nullifier,uint256 attribute,uint256 threshold,uint256 subjectBinding))",
  "function submitReceipt(uint256[2] a,uint256[2][2] b,uint256[2] c,uint256[11] signals) returns (bytes32)",
  "error MainnetGated()",
  "error InvalidInput()",
  "error WrongDomain()",
  "error StaleClaim()",
  "error UntrustedRoot()",
  "error RequestAlreadyReceipted()",
  "error NullifierUsed()",
  "error InvalidProof()",
  "event ReceiptRecorded(bytes32 indexed requestDigest,address indexed issuer,uint256 indexed nullifier,uint256 root,uint256 attribute,uint256 threshold,uint256 subjectBinding,uint64 validThrough,uint64 blockNumber)",
]);

/** Public signal order of presentation-receipt-v1. */
export const RECEIPT_SIGNALS = [
  "issuer", "root", "requestDigestHi", "requestDigestLo", "receiptContract", "chainId",
  "attribute", "threshold", "validThrough", "subjectBinding", "nullifier",
] as const;

const BN254 = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const MASK128 = (1n << 128n) - 1n;
const UINT64 = (1n << 64n) - 1n;

/** Splits a 64-hex request digest into two 128-bit limbs (injective, both < field). */
export function requestDigestLimbs(digest: string): { hi: bigint; lo: bigint } {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("request digest must be 64 lowercase hex characters");
  const value = BigInt(`0x${digest}`);
  return { hi: value >> 128n, lo: value & MASK128 };
}

export function requestDigestFromLimbs(hi: bigint, lo: bigint): string {
  if (hi < 0n || lo < 0n || hi > MASK128 || lo > MASK128) throw new Error("limb out of range");
  return ((hi << 128n) | lo).toString(16).padStart(64, "0");
}

export const requestDigestBytes32 = (digest: string): Hex => {
  requestDigestLimbs(digest);
  return `0x${digest}`;
};

/** Domain-separated sha256 truncated to 248 bits, so it is a BN254 field element. */
export function labelFieldElement(domain: string, text: string): bigint {
  if (!text) throw new Error("label must be non-empty");
  const digest = sha256(stringToBytes(`${domain}\n${text}`));
  return BigInt(digest) >> 8n;
}
export const receiptSubjectId = (credentialSubject: string): bigint =>
  labelFieldElement("attest.receipt-subject/v1", credentialSubject);
export const receiptAttributeId = (attribute: string): bigint =>
  labelFieldElement("attest.receipt-attribute/v1", attribute);

/** Defensive checks mirroring the contract before spending gas. */
export function validateReceiptSignals(
  signals: readonly bigint[],
  expected: { contract: Address; chainId: bigint; nowSeconds: bigint },
): void {
  if (signals.length !== 11 || signals.some(x => typeof x !== "bigint" || x < 0n || x >= BN254))
    throw new Error("invalid BN254 public signals");
  const [issuer, , hi, lo, contract, chainId, , , validThrough, binding, nullifier] = signals as unknown as bigint[];
  if (!isAddress(expected.contract)) throw new Error("invalid receipt contract");
  if (issuer === 0n || issuer! >= 1n << 160n || hi! > MASK128 || lo! > MASK128 ||
      (hi === 0n && lo === 0n) || binding === 0n || nullifier === 0n || validThrough! > UINT64)
    throw new Error("receipt signals out of range");
  if (contract !== BigInt(expected.contract) || chainId !== expected.chainId)
    throw new Error("receipt proof is bound to another contract or chain");
  if (validThrough! < expected.nowSeconds) throw new Error("receipt claim validity has passed");
}

export type StoredReceipt = Readonly<{
  issuer: Address; blockNumber: bigint; validThrough: bigint; root: bigint; nullifier: bigint;
  attribute: bigint; threshold: bigint; subjectBinding: bigint;
}>;

/**
 * Compares an on-chain receipt with what the consumer's own request asked
 * for. `subjectBinding` is Poseidon(subjectId, subjectSalt, hi, lo) computed by
 * the consumer from the salt the holder discloses to it.
 */
export function receiptSatisfies(
  receipt: StoredReceipt,
  expected: { acceptedIssuers: readonly Address[]; attribute: string; minimum: bigint; subjectBinding: bigint; nowSeconds: bigint },
): boolean {
  return receipt.blockNumber !== 0n &&
    expected.acceptedIssuers.some(a => a.toLowerCase() === receipt.issuer.toLowerCase()) &&
    receipt.attribute === receiptAttributeId(expected.attribute) &&
    receipt.threshold >= expected.minimum &&
    receipt.subjectBinding === expected.subjectBinding &&
    receipt.validThrough >= expected.nowSeconds;
}
