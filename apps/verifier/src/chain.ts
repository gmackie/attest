/**
 * Chain-backed issuer authority and credential status.
 *
 * Every read goes through ChainStatusReader (@attest/chain-evm, ATTE-18): all endpoints
 * must agree on the chain ID, the settled block hash and every value read, the block hash
 * is re-checked after reading, and stale heads are refused. One snapshot is taken per
 * verification, so the issuer grant and the credential anchor are read at the same block.
 */
import {
  ChainStatusError, createChainStatusReader, registryAbi, workspaceAnchorStatus,
  type ChainEndpoint, type ChainReadClient, type ChainSnapshot, type ChainStatusReader,
} from "@attest/chain-evm";
import { commitValue } from "@attest/core";
import type { CredentialStatus } from "@attest/verifier";
import type { Finality } from "./config";
import type { IssuerPolicy } from "./catalog";

export const SEPOLIA_CHAIN_ID = 11155111;

export function maxBlockAgeMs(finality: Finality): number {
  // Sepolia finalizes in roughly 13 minutes; confirmations track the head (ATTE-27 used 5 minutes).
  return finality.kind === "finalized" ? 30 * 60_000 : 5 * 60_000;
}

export function statusReader(endpoints: readonly ChainEndpoint[], finality: Finality, now: () => number): ChainStatusReader {
  return createChainStatusReader({
    chainId: SEPOLIA_CHAIN_ID,
    endpoints,
    // Both configured providers must agree; a single RPC is never trusted in production.
    minEndpoints: 2,
    finality,
    maxBlockAgeMs: maxBlockAgeMs(finality),
    now,
  });
}

export type ChainPolicy = Extract<IssuerPolicy, { authority: "chain" }>;

/** Lazily takes one snapshot per verification and reuses it for every read. */
export function snapshotOnce(reader: ChainStatusReader): () => Promise<ChainSnapshot> {
  let pending: Promise<ChainSnapshot> | undefined;
  return () => (pending ??= reader.snapshot());
}

/** The issuer's WorkspaceRegistry grant: enabled for the schema scope with the pinned signing-key commitment. */
export async function issuerGrantActive(reader: ChainStatusReader, snapshot: ChainSnapshot, policy: ChainPolicy): Promise<boolean> {
  const [enabled, keyHash] = (await reader.read(snapshot, (client: ChainReadClient, blockNumber: bigint) =>
    client.readContract({
      address: policy.registry, abi: registryAbi, functionName: "issuers", args: [policy.account, policy.scope], blockNumber,
    }))) as [boolean, `0x${string}`];
  return enabled && keyHash.toLowerCase() === policy.signingKeyHash.toLowerCase();
}

/**
 * Verifier anchor profile v1 for WorkspaceRegistry: a credential is anchored under
 * `commitValue({profile, schema, contentId})` with commitment `commitValue(contentId)`
 * (the connected workspace's content commitment). The POD content ID is the only
 * credential identifier a presentation reveals to the verifier.
 */
export const ANCHOR_PROFILE = "attest.verifier-anchor/v1";
export async function anchorQuery(policy: ChainPolicy, schema: string, contentId: string) {
  return {
    registry: policy.registry,
    anchorId: (await commitValue({ profile: ANCHOR_PROFILE, schema, contentId })) as `0x${string}`,
    issuer: policy.account,
    scope: policy.scope,
    commitment: (await commitValue(contentId)) as `0x${string}`,
    signingKeyHash: policy.signingKeyHash,
  };
}

export async function anchorStatus(
  reader: ChainStatusReader, snapshot: ChainSnapshot, policy: ChainPolicy, schema: string, contentId: string,
): Promise<CredentialStatus | null> {
  const status = await workspaceAnchorStatus(reader, await anchorQuery(policy, schema, contentId), snapshot);
  return status && { status: status.status, validUntil: status.validUntil, evidence: status.evidence };
}

/**
 * Seam for ATTE-21 (StatusRegistry) and ATTE-24 (status lists): credential-level status
 * for issuers that are not anchored per credential. Returns null today, meaning "no
 * credential-level status source exists"; callers then fall back to issuer-level status
 * and say so in the evidence source.
 */
export interface CredentialStatusRegistry {
  lookup(query: { credentialIssuer: string; schema: string; contentId: string }): Promise<CredentialStatus | null>;
}
export const noCredentialStatusRegistry: CredentialStatusRegistry = { lookup: async () => null };

export { ChainStatusError };
