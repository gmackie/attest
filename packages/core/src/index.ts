import type { Attestation } from "@attest/domain";
import { Effect } from "effect";

export class CryptoError extends Error {
  readonly _tag = "CryptoError";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

const normalize = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)])
  );
};

/** Stable JSON used only for commitments in the POC. A standards-track format must pin its own canonicalization. */
export const canonicalJson = (value: unknown): string => JSON.stringify(normalize(value));

export const sha256Hex = async (value: string | Uint8Array): Promise<string> => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

export const sha256HexEffect = (value: string | Uint8Array) =>
  Effect.tryPromise({
    try: () => sha256Hex(value),
    catch: (cause) => new CryptoError("Unable to compute SHA-256 commitment", cause)
  });

export const commitValue = (value: unknown): Promise<string> => sha256Hex(canonicalJson(value));
export const commitAttestation = (attestation: Attestation): Promise<string> => commitValue(attestation);

const concatHex = (left: string, right: string): string =>
  `${left.replace(/^0x/, "")}${right.replace(/^0x/, "")}`;

/** Deterministic binary Merkle root. Leaves are sorted so evidence ordering does not change the root. */
export const merkleRoot = async (commitments: readonly string[]): Promise<string> => {
  if (commitments.length === 0) return sha256Hex("");
  let level = [...commitments].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(await sha256Hex(concatHex(left, right)));
    }
    level = next;
  }
  return level[0]!;
};
