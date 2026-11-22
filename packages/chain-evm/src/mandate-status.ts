/**
 * StatusRegistry client: on-chain, digest-bound status for agent mandates and transaction approvals
 * (the distributed counterpart of @attest/mandates' LocalStatusRegistry).
 *
 * - Writes (register, revoke, supersede) go to the issuer's own namespace in StatusRegistry. Mainnet is
 *   refused while production writes are gated (specs/production-readiness.md).
 * - Reads go through ChainStatusReader: a settled block (finalized or N confirmations), every endpoint
 *   agreeing, a reorg re-check and a stale-head bound. Any failure is "unavailable", never "active".
 * - Only commitments reach the chain: statusRefId(statusRef) is a domain-separated SHA-256 of the
 *   reference, and the document is represented by its SHA-256 digest. No mandate fields are written.
 *
 * Lease semantics match LocalStatusRegistry.read: a LiveStatus is valid for at most `leaseMs` (≤ 60 s)
 * from its observation, further capped by the document's on-chain validity end.
 */
import { Effect } from "effect";
import { parseAbi, type Address, type Hex } from "viem";
import { MandateError, documentDigest } from "@attest/mandates";
import type { AgentMandate, LiveStatus, TransactionApproval, VerificationPorts } from "@attest/mandates";
import { ChainStatusError, chainEvidence, type ChainSnapshot, type ChainStatusReader } from "./status";

export const statusRegistryAbi = parseAbi([
  "function register(bytes32 ref,bytes32 digest,uint64 validUntil)",
  "function revoke(bytes32 ref)",
  "function supersede(bytes32 ref,bytes32 successor)",
  "function getStatus(address issuer,bytes32 ref) view returns ((bytes32 digest,uint8 status,uint64 validUntil,uint64 registeredAt,uint64 changedAt,bytes32 successor))",
  "event StatusRegistered(address indexed issuer,bytes32 indexed ref,bytes32 digest,uint64 validUntil)",
  "event StatusRevoked(address indexed issuer,bytes32 indexed ref)",
  "event StatusSuperseded(address indexed issuer,bytes32 indexed ref,bytes32 indexed successor)",
]);

/** On-chain StatusRegistry.Status. */
export const ONCHAIN_STATUS = ["none", "active", "revoked", "superseded"] as const;
export type OnchainStatus = (typeof ONCHAIN_STATUS)[number];
export interface StatusRecord {
  digest: string;
  status: OnchainStatus;
  /** Document validity end, ms. */
  validUntil: number;
  registeredAt: number;
  changedAt: number;
  /** Successor reference id (0x bytes32) when superseded. */
  successor?: Hex;
}
interface RawRecord { digest: Hex; status: number; validUntil: bigint; registeredAt: bigint; changedAt: bigint; successor: Hex }

const MAX_LEASE_MS = 60_000;
const fail = (code: string, detail?: string): never => { throw new ChainStatusError(code, detail); };
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** On-chain key for a status reference. Domain-separated so the readable reference never reaches the chain. */
export async function statusRefId(statusRef: string): Promise<Hex> {
  if (typeof statusRef !== "string" || !statusRef || statusRef.length > 1024) fail("invalid_status_ref");
  return `0x${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`attest.mandate-status/v1\n${statusRef}`)))}`;
}
const digestBytes = (digest: string): Hex => {
  if (!/^[0-9a-f]{64}$/.test(digest)) fail("invalid_digest");
  return `0x${digest}`;
};
const decode = (raw: RawRecord): StatusRecord => {
  const status = ONCHAIN_STATUS[raw.status];
  if (!status) return fail("invalid_status_record");
  return {
    digest: raw.digest.slice(2).toLowerCase(), status, validUntil: Number(raw.validUntil) * 1000,
    registeredAt: Number(raw.registeredAt) * 1000, changedAt: Number(raw.changedAt) * 1000,
    ...(status === "superseded" ? { successor: raw.successor.toLowerCase() as Hex } : {}),
  };
};
const leaseOf = (leaseMs: number) => {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) fail("invalid_status_lease");
  return leaseMs;
};

/** Read one record at a settled block, consistently across every endpoint. */
export async function readStatusRecord(
  reader: ChainStatusReader,
  query: { registry: Address; issuer: Address; ref: Hex },
  snapshot?: ChainSnapshot,
): Promise<{ record: StatusRecord | null; snapshot: ChainSnapshot }> {
  const at = snapshot ?? (await reader.snapshot());
  const raw = (await reader.read(at, (client, blockNumber) =>
    client.readContract({ address: query.registry, abi: statusRegistryAbi, functionName: "getStatus",
      args: [query.issuer, query.ref], blockNumber }))) as RawRecord;
  const record = decode(raw);
  return { record: record.status === "none" ? null : record, snapshot: at };
}

export type MandateCredentialStatus = {
  status: "active" | "revoked" | "superseded" | "expired";
  /** End of the document's validity or the status lease, whichever is earlier, ms. */
  validUntil: number;
  evidence: ReturnType<typeof chainEvidence>;
  successor?: Hex;
};

/**
 * Status of a digest-bound record in @attest/verifier's `CredentialStatus` shape, for a verifier `status`
 * port. Returns null for an unknown reference; a record bound to another digest fails with status_digest_mismatch.
 * Mapping a verifier query (credentialIssuer, schema, contentId) to issuer/ref/digest is the caller's trusted
 * configuration, never data from the presentation.
 */
export async function mandateCredentialStatus(
  reader: ChainStatusReader,
  query: { registry: Address; issuer: Address; ref: Hex; digest: string },
  options: { leaseMs?: number } = {},
): Promise<MandateCredentialStatus | null> {
  const leaseMs = leaseOf(options.leaseMs ?? 5000);
  const expected = digestBytes(query.digest).slice(2);
  const { record, snapshot } = await readStatusRecord(reader, query);
  if (!record) return null;
  if (record.digest !== expected) fail("status_digest_mismatch");
  const evidence = chainEvidence(snapshot);
  const validUntil = Math.min(record.validUntil, snapshot.observedAt + leaseMs);
  if (record.status === "revoked") return { status: "revoked", validUntil, evidence };
  if (record.status === "superseded") return { status: "superseded", validUntil, evidence, successor: record.successor! };
  if (BigInt(record.validUntil / 1000) <= snapshot.timestamp) return { status: "expired", validUntil, evidence };
  return { status: "active", validUntil, evidence };
}

/** Minimal clients the issuer's writer needs (viem PublicClient / WalletClient satisfy these via viemStatusClients). */
export interface StatusWriterClients {
  chainId: number;
  /** The sending account; it must be the registry's issuer. */
  account: Address;
  /** Writer pre-checks at the latest block. Verifiers never use this path. */
  readRecord(args: { address: Address; issuer: Address; ref: Hex }): Promise<RawRecord>;
  simulateAndWrite(args: { address: Address; functionName: "register" | "revoke" | "supersede"; args: readonly unknown[] }): Promise<Hex>;
  waitForReceipt(hash: Hex, confirmations: number): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}

export interface MandateStatusRegistryOptions {
  registry: Address;
  /** The issuer account whose namespace is read (and written, when `writer` is set). */
  issuer: Address;
  /** Settled, multi-RPC reads for verification. */
  reader: ChainStatusReader;
  writer?: StatusWriterClients;
  /** Write confirmations before a write resolves (default 2). */
  confirmations?: number;
  /** Status lease handed to verifiers (default 5000, at most 60 000 ms), as LocalStatusRegistry.read. */
  leaseMs?: number;
  /**
   * Reuse an *active* observation until its lease ends instead of re-reading the chain (default false).
   * The cached LiveStatus keeps its original observedAt/validUntil, so the verifier's own lease and
   * maxStatusAgeMs checks still bound it exactly as if the verifier had kept the first read. Non-active
   * results and failures are never cached.
   */
  cacheActive?: boolean;
}

export type MandateStatusError = MandateError | ChainStatusError;
const asError = (cause: unknown): MandateStatusError =>
  cause instanceof MandateError || cause instanceof ChainStatusError ? cause : new MandateError("status_unavailable");

/**
 * On-chain status registry for an issuer, with the LocalStatusRegistry contract at an Effect boundary:
 * register is idempotent for the same digest and never resurrects a revoked record; revoke of a non-active
 * record is a no-op; reads return null for unknown or digest-mismatched references.
 */
export function mandateStatusRegistry(options: MandateStatusRegistryOptions) {
  const { registry, issuer, reader, writer } = options;
  const confirmations = options.confirmations ?? 2;
  const defaultLease = leaseOf(options.leaseMs ?? 5000);
  if (writer?.chainId === 1) fail("production_writes_disabled");
  if (writer && writer.chainId !== reader.options.chainId) fail("chain_mismatch");
  if (writer && writer.account.toLowerCase() !== issuer.toLowerCase()) fail("writer_not_issuer");
  const cache = new Map<string, LiveStatus>();

  const needWriter = () => writer ?? fail("writer_unavailable");
  const latest = async (ref: Hex) => decode(await needWriter().readRecord({ address: registry, issuer, ref }));
  const send = async (functionName: "register" | "revoke" | "supersede", args: readonly unknown[]) => {
    const w = needWriter();
    const hash = await w.simulateAndWrite({ address: registry, functionName, args });
    const receipt = await w.waitForReceipt(hash, confirmations);
    if (receipt.status !== "success") fail("status_write_reverted", hash);
    return hash;
  };

  const readLive = async (statusRef: string, digest: string, leaseMs: number): Promise<LiveStatus | null> => {
    leaseOf(leaseMs);
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    const key = `${statusRef}\n${digest}`;
    const cached = options.cacheActive ? cache.get(key) : undefined;
    if (cached && reader.options.now() < cached.validUntil) return cached;
    cache.delete(key);
    const { record, snapshot } = await readStatusRecord(reader, { registry, issuer, ref: await statusRefId(statusRef) });
    if (!record || record.digest !== digest) return null;
    // LiveStatus cannot say "expired"; an expired document has no usable status.
    if (BigInt(record.validUntil / 1000) <= snapshot.timestamp) return null;
    const status = record.status as LiveStatus["status"];
    const live: LiveStatus = { digest, status, observedAt: snapshot.observedAt,
      validUntil: Math.min(snapshot.observedAt + leaseMs, record.validUntil) };
    if (options.cacheActive && status === "active") cache.set(key, live);
    return live;
  };

  return {
    /** Bind the document's statusRef to its digest as active. Returns the digest. */
    register(document: AgentMandate | TransactionApproval) {
      return Effect.tryPromise({ try: async () => {
        const digest = await documentDigest(document), ref = await statusRefId(document.statusRef);
        const previous = await latest(ref);
        if (previous.status !== "none") {
          if (previous.digest !== digest) throw new MandateError("status_ref_already_bound");
          // Retrying issuance cannot reactivate a revoked or superseded record.
          return digest;
        }
        await send("register", [ref, digestBytes(digest), BigInt(Math.ceil(document.validUntil / 1000))]);
        return digest;
      }, catch: asError });
    },
    /** Active -> revoked. A record that is already revoked or superseded is left unchanged. */
    revoke(statusRef: string) {
      return Effect.tryPromise({ try: async () => {
        const ref = await statusRefId(statusRef), previous = await latest(ref);
        if (previous.status === "none") throw new MandateError("status_ref_unknown");
        if (previous.status === "active") await send("revoke", [ref]);
      }, catch: asError });
    },
    /** Active -> superseded by `successorRef`, which must already be registered and active. */
    supersede(statusRef: string, successorRef: string) {
      return Effect.tryPromise({ try: async () => {
        if (statusRef === successorRef) throw new MandateError("invalid_status_transition");
        const ref = await statusRefId(statusRef), successor = await statusRefId(successorRef);
        const previous = await latest(ref);
        if (previous.status === "none") throw new MandateError("status_ref_unknown");
        if ((await latest(successor)).status !== "active") throw new MandateError("invalid_status_transition");
        if (previous.status === "active") await send("supersede", [ref, successor]);
      }, catch: asError });
    },
    /** Settled read. Chain failures (disagreement, reorg, stale head) fail with their ChainStatusError code. */
    read(statusRef: string, digest: string, leaseMs = defaultLease) {
      return Effect.tryPromise({ try: () => readLive(statusRef, digest, leaseMs), catch: asError });
    },
    /**
     * VerificationPorts.status. Chain failures reject with MandateError("status_unavailable"), so mandate
     * verification fails closed instead of treating an unreadable chain as active.
     */
    status: (async (statusRef, digest) => {
      try { return await readLive(statusRef, digest, defaultLease); }
      catch { throw new MandateError("status_unavailable"); }
    }) satisfies VerificationPorts["status"],
  };
}

/** Adapt viem clients for the writer (keeps viem generics out of callers). */
export function viemStatusClients(publicClient: {
  readContract(args: never): Promise<unknown>;
  simulateContract(args: never): Promise<{ request: unknown }>;
  waitForTransactionReceipt(args: never): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}, walletClient: { writeContract(args: never): Promise<Hex> }, account: Address, chainId: number): StatusWriterClients {
  if (chainId === 1) fail("production_writes_disabled");
  return {
    chainId,
    account,
    readRecord: async (a) => (await publicClient.readContract({ address: a.address, abi: statusRegistryAbi,
      functionName: "getStatus", args: [a.issuer, a.ref] } as never)) as RawRecord,
    simulateAndWrite: async (a) => {
      const sim = await publicClient.simulateContract({ ...a, abi: statusRegistryAbi, account } as never);
      return walletClient.writeContract(sim.request as never);
    },
    waitForReceipt: (hash, confirmations) => publicClient.waitForTransactionReceipt({ hash, confirmations } as never),
  };
}
