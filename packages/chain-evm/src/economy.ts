import {
  encodePacked, getAddress, isAddress, keccak256, parseAbi,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Public fields a trusted proof verifier signs after independently checking a GPC proof. */
export type ConversionVoucher = Readonly<{
  policyId: Hex;
  nullifier: Hex;
  proofCommitment: Hex;
  provenanceCommitment: Hex;
  recipient: Address;
  amount: bigint;
  expiresAt: bigint;
  palette: bigint;
}>;

export const conversionTypes = {
  Conversion: [
    { name: "policyId", type: "bytes32" },
    { name: "nullifier", type: "bytes32" },
    { name: "proofCommitment", type: "bytes32" },
    { name: "provenanceCommitment", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "palette", type: "uint64" },
  ],
} as const;

export const conversionDomain = (token: Address, chainId = 11155111) => ({
  name: "Attest Conversion",
  version: "1",
  chainId,
  verifyingContract: getAddress(token),
}) as const;

/** Four fractions of 10,000, stored as four big-endian uint16 values. */
export function packPalette(fractions: readonly [number, number, number, number]): bigint {
  if (fractions.some((v) => !Number.isInteger(v) || v < 0 || v > 10_000) ||
      fractions.reduce((sum, n) => sum + n, 0) !== 10_000)
    throw new Error("Palette components must be nonnegative integers summing to 10,000");
  return fractions.reduce((bits, n) => (bits << 16n) | BigInt(n), 0n);
}

export function unpackPalette(value: bigint): readonly [number, number, number, number] {
  if (value < 0n || value > (1n << 64n) - 1n) throw new Error("Invalid packed palette");
  return [
    Number((value >> 48n) & 0xffffn),
    Number((value >> 32n) & 0xffffn),
    Number((value >> 16n) & 0xffffn),
    Number(value & 0xffffn),
  ];
}

/** Stable across proof challenges, recipients, policy versions and token contracts.
 * Requires a unique, high-entropy, issuer-controlled event commitment. */
export function entitlementNullifier(eventCommitment: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(eventCommitment)) throw new Error("Invalid event commitment");
  return keccak256(encodePacked(["string", "bytes32"], ["attest:entitlement:v1", eventCommitment]));
}
export function provenanceCommitment(eventCommitment: Hex, policyId: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(eventCommitment) || !/^0x[0-9a-fA-F]{64}$/.test(policyId))
    throw new Error("Invalid commitment");
  return keccak256(encodePacked(["string", "bytes32", "bytes32"], ["attest:provenance:v1", eventCommitment, policyId]));
}

export async function signConversionVoucher(
  privateKey: Hex,
  token: Address,
  voucher: ConversionVoucher,
  chainId = 11155111,
): Promise<Hex> {
  if (!isAddress(token) || !isAddress(voucher.recipient)) throw new Error("Invalid EVM address");
  if (chainId !== 11155111) throw new Error("Prototype signatures are restricted to Sepolia");
  const signer = privateKeyToAccount(privateKey);
  return signer.signTypedData({
    domain: conversionDomain(token, chainId),
    types: conversionTypes,
    primaryType: "Conversion",
    message: voucher,
  });
}

export const attestTokenAbi = parseAbi([
  "function administrator() view returns (address)",
  "function authorizer() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function compositionOf(address) view returns (uint256[4])",
  "function spentNullifiers(bytes32) view returns (bool)",
  "function policies(bytes32) view returns (uint256 cap,uint256 minted,bool enabled)",
  "function configurePolicy(bytes32,uint256,bool)",
  "function setAuthorizer(address)",
  "function mintWithAuthorization((bytes32 policyId,bytes32 nullifier,bytes32 proofCommitment,bytes32 provenanceCommitment,address recipient,uint256 amount,uint64 expiresAt,uint64 palette),bytes)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);
export const attestClaimsAbi = parseAbi([
  "function configureIssuer(address,bool)",
  "function issue(address,bytes32,bytes32,uint64) returns (uint256)",
  "function revoke(uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function claims(uint256) view returns (address issuer,bytes32 commitment,bytes32 scope,uint64 expiresAt,bool revoked)",
  "function isActive(uint256) view returns (bool)",
  "function locked(uint256) view returns (bool)",
  "function tokenURI(uint256) view returns (string)",
  "function refresh(uint256)",
]);
export const attestPassportAbi = parseAbi([
  "function claim() returns (uint256)",
  "function passportId(address) pure returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "function refresh(address)",
  "function locked(uint256) view returns (bool)",
]);

/** Production restriction also exists in the Solidity constructors. */
export function assertPrototypeNetwork(chainId: number): void {
  if (chainId !== 11155111) throw new Error("ATTEST economy writes are Sepolia-only");
}
