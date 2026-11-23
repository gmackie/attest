/**
 * ATTE-27 production verification: the attest.gmac.io #/testnet/contractor journey, headless.
 *
 * Reproduces apps/web/src/TestnetJourney.tsx step by step against the LIVE hosted issuer, with a
 * local Sepolia key standing in for the injected wallet (EIP-1193 shim: accounts and
 * personal_sign are local, every other method goes to a public Sepolia RPC). The decision is
 * POSTed as soon as the presentation is ready, so the 3-confirmation gate is exercised; 409
 * awaiting_confirmations is retried like the page's `api` helper, honouring retryAfterSeconds.
 * Generating the three GPC proofs locally takes about 35-60 s (3-5 Sepolia blocks), so the last
 * grant is usually already 3 blocks deep when the first decision arrives. The final revocation
 * race therefore exercises the gate on purpose (409 awaiting_confirmations, then 422).
 *
 * Runs as a vitest file because @pcd/pod's blakejs ESM import breaks under tsx:
 *   ATTEST_LIVE_JOURNEY=1 pnpm vitest run --config scripts/live-journey.config.ts
 * Env: ATTEST_LIVE_URL (default https://attest.gmac.io), ATTEST_SIGNER_FILE (default
 * ~/.config/attest/sepolia/deployer.json, field privateKey), ATTEST_EVIDENCE_FILE (JSON output).
 * ATTEST_REVOCATION_RACE=0 skips the final revocation race (see below).
 * Sepolia only. The visitor wallet sends no transactions here: the institutions pay gas.
 */
import { it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPublicClient, http, type Address, type EIP1193Provider, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { commitValue } from "@attest/core";
import {
  checkedAddress,
  checkedHash,
  clients,
  assertContext,
  validateInstitutions,
  journeyRecords,
  institutionAbi,
  type JourneyArtifact,
} from "@attest/chain-evm";
import {
  fictionalInstitutions,
  createJourneyVault,
  institutionDirectory,
  institutionSigningKeys,
  institutionCommandSchema,
  commandMessage,
  journeyVaultSchema,
  journeyHolderKey,
  requestJourney,
  prepareJourney,
  verifyJourney,
  type JourneyVault,
} from "@attest/demo";

const CHAIN_ID = 11155111;
const BASE = process.env.ATTEST_LIVE_URL ?? "https://attest.gmac.io";
const RPCS = {
  publicnode: "https://ethereum-sepolia-rpc.publicnode.com",
  tenderly: "https://sepolia.gateway.tenderly.co",
} as const;
const SIGNER_FILE =
  process.env.ATTEST_SIGNER_FILE ?? path.join(os.homedir(), ".config/attest/sepolia/deployer.json");
const EVIDENCE_FILE =
  process.env.ATTEST_EVIDENCE_FILE ?? path.join(os.tmpdir(), `attest-live-journey-${Date.now()}.json`);

// The page loads GPC circuits from GPC_ARTIFACTS_URL (jsDelivr, proto-pod-gpc-artifacts@0.13.0); Node's
// snarkjs path reads the filesystem, so use the identical installed package (version checked below).
const GPC_ARTIFACTS = path.resolve(import.meta.dirname, "../packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts");
const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const now = () => new Date().toISOString();
const evidence: {
  startedAt: string;
  base: string;
  account?: string;
  registry?: string;
  journey?: string;
  http: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  decision?: Record<string, unknown>;
  localChecks?: unknown;
  timings: Record<string, unknown>;
  revocationRace?: Record<string, unknown>;
  finishedAt?: string;
} = { startedAt: now(), base: BASE, http: [], transactions: [], timings: {} };
const log = (...args: unknown[]) => console.log(`[${now()}]`, ...args);

const readers = Object.fromEntries(
  Object.entries(RPCS).map(([name, url]) => [
    name,
    createPublicClient({ chain: sepolia, transport: http(url, { timeout: 20000, retryCount: 2 }) }),
  ]),
) as Record<keyof typeof RPCS, ReturnType<typeof createPublicClient>>;

/** Minimal injected-wallet stand-in: local account + personal_sign, everything else to the RPC. */
function walletProvider(privateKey: Hex, rpcUrl: string): EIP1193Provider {
  const account = privateKeyToAccount(privateKey);
  let id = 0;
  const forward = async (method: string, params: unknown) => {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
    });
    const body = (await r.json()) as { result?: unknown; error?: { code: number; message: string } };
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body.result;
  };
  return {
    request: (async ({ method, params }: { method: string; params?: unknown }) => {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [account.address];
        case "wallet_switchEthereumChain":
          throw new Error("Refusing to switch chains");
        case "personal_sign": {
          const [data, address] = params as [Hex, string];
          if (address.toLowerCase() !== account.address.toLowerCase()) throw new Error("Unknown account");
          return account.signMessage({ message: { raw: data } });
        }
        case "eth_sendTransaction":
        case "eth_sign":
        case "eth_signTypedData_v4":
          throw new Error(`${method} is not used by the contractor journey`);
        default:
          return forward(method, params);
      }
    }) as EIP1193Provider["request"],
    on: () => {},
    removeListener: () => {},
  } as unknown as EIP1193Provider;
}

/** The page's `api` helper, plus status/timing evidence. */
async function api(route: string, body: unknown, label: string, accept: number[] = []) {
  for (let attempt = 0; ; attempt++) {
    const sentAt = now();
    const r = await fetch(new URL(route, BASE), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json(body),
    });
    const data = (await r.json()) as Record<string, unknown>;
    const entry = {
      label,
      route,
      attempt,
      sentAt,
      receivedAt: now(),
      status: r.status,
      code: data.code,
      retryAfterSeconds: data.retryAfterSeconds,
      confirmations: data.confirmations,
      error: data.error,
      transactionHash: data.transactionHash,
      checkedBlock: data.checkedBlock,
      checkedBlockHash: data.checkedBlockHash,
    };
    evidence.http.push(entry);
    log(`${label}: HTTP ${r.status}`, data.code ?? "", data.retryAfterSeconds ?? "", data.error ?? "");
    if (r.status === 409 && data.code === "awaiting_confirmations" && attempt < 12) {
      const seconds = Math.min(60, Math.max(5, Number(data.retryAfterSeconds) || 15));
      const confirmations = typeof data.confirmations === "number" ? data.confirmations : 3;
      log(`waiting ${seconds}s for ${confirmations} confirmations`);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      continue;
    }
    if (accept.includes(r.status)) return { ...data, status: r.status };
    if (!r.ok) throw new Error(`${label}: HTTP ${r.status} ${json(data)}`);
    return data;
  }
}

it.skipIf(!process.env.ATTEST_LIVE_JOURNEY)(
  "live contractor journey against the hosted issuer",
  { timeout: 30 * 60000 },
  async () => {
    // Chain guard: both RPCs must be Sepolia.
    for (const [name, reader] of Object.entries(readers))
      if ((await reader.getChainId()) !== CHAIN_ID) throw new Error(`${name} is not Sepolia`);
    const signer = JSON.parse(await readFile(SIGNER_FILE, "utf8")) as { privateKey: Hex };
    const provider = walletProvider(signer.privateKey, RPCS.publicnode);
    if (Number(await provider.request({ method: "eth_chainId" })) !== CHAIN_ID)
      throw new Error("Refusing a chain other than Sepolia");

    // Page boot: demo-deployment.json and the compiled registry artifact, from the live site.
    const config = (await (await fetch(new URL("/demo-deployment.json", BASE))).json()) as {
      chainId: number;
      registry: string;
    };
    if (config.chainId !== CHAIN_ID) throw new Error("Live demo deployment is not Sepolia");
    const artifactResponse = await fetch(new URL("/contracts/InstitutionRegistry.json", BASE));
    if (!artifactResponse.ok) throw new Error("Demo deployment artifact unavailable");
    const artifact = (await artifactResponse.json()) as JourneyArtifact;

    // connect
    const [first] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const account = checkedAddress(first!);
    await assertContext(provider, "testnet", account);
    const registry = checkedAddress(config.registry);
    evidence.account = account;
    evidence.registry = registry;
    const balance = await readers.publicnode.getBalance({ address: account });
    log("connected", account, "balance (wei)", balance, "registry", registry);

    const validate = async () =>
      validateInstitutions(
        provider,
        account,
        registry,
        artifact,
        institutionDirectory.institutions.map((i) => i.address),
        await Promise.all(institutionSigningKeys.map(commitValue)),
      );
    const refresh = async (v: JourneyVault) => {
      await validate();
      return journeyRecords(provider, account, registry, artifact, checkedHash(await commitValue(v.id)));
    };
    const wait = async (hash: Hex, label: string) => {
      const receipt = await clients(provider, "testnet").reader.waitForTransactionReceipt({
        hash,
        timeout: 120000,
      });
      if (receipt.status !== "success") throw new Error(`${label}: transaction reverted`);
      evidence.transactions.push({
        label,
        hash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        from: receipt.from,
        includedObservedAt: now(),
      });
      log(`${label}: ${receipt.transactionHash} in block ${receipt.blockNumber}`);
      return receipt;
    };

    // join
    await validate();
    // create (memory-only passport: the page's localStorage copy is a browser convenience)
    let vault = createJourneyVault(account, registry);
    evidence.journey = vault.id;
    await refresh(vault);
    log("journey", vault.id);

    const authorize = async (
      v: JourneyVault,
      id: 0 | 1 | 2,
      action: "issue" | "revoke",
      value: number,
      validThrough: string,
    ) => {
      await validate();
      const command = institutionCommandSchema.parse({
        version: 2,
        chainId: CHAIN_ID,
        profile: v.profile,
        domain: "attest.gmac.io",
        action,
        account,
        registry,
        journey: v.id,
        holderPublicKey: journeyHolderKey(v),
        institution: id,
        value,
        validThrough,
        expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
        nonce: crypto.randomUUID(),
        demoConsent: true,
      });
      const signature = await clients(provider, "testnet").wallet.signMessage({
        account,
        message: commandMessage(command),
      });
      await assertContext(provider, "testnet", account);
      return api("/api/v2/credentials", { command, signature }, `${action} ${id} (${fictionalInstitutions[id].name})`);
    };
    // issue 0, 1, 2 with the page's default values and 180-day validity
    for (const institution of fictionalInstitutions) {
      const id = institution.id;
      const plan = {
        institution: id,
        value: institution.value as number,
        validThrough: new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10),
      };
      const pending = journeyVaultSchema.parse({
        ...vault,
        plans: [...vault.plans.filter((p) => p.institution !== id), plan],
      });
      vault = pending;
      const data = await authorize(pending, id, "issue", plan.value, plan.validThrough);
      vault = journeyVaultSchema.parse({
        ...pending,
        credentials: [...pending.credentials.filter((c) => c.institution !== id), data.credential],
      });
      await wait(data.transactionHash as Hex, `credential ${id} grant`);
      // The page re-reads records here and before the request; skipped after the last grant to keep
      // the decision POST inside the 3-confirmation window (the issuer re-reads them anyway).
      if (id < 2) await refresh(vault);
    }

    // Northstar: request, proofs, then POST the decision immediately (no local pre-check delay).
    await assertContext(provider, "testnet", account);
    const request = requestJourney(vault);
    const proofStart = Date.now();
    const artifactsVersion = JSON.parse(await readFile(path.join(GPC_ARTIFACTS, "package.json"), "utf8")).version;
    if (artifactsVersion !== "0.13.0") throw new Error(`GPC artifacts ${artifactsVersion} differ from the page's 0.13.0`);
    const presentation = await prepareJourney(vault, request, GPC_ARTIFACTS, (n) => log(`proof ${n}/3`));
    evidence.timings.presentationMs = Date.now() - proofStart;
    log(`proofs ready in ${evidence.timings.presentationMs} ms`);
    const lastGrant = evidence.transactions.at(-1)!;
    const heads = await Promise.all(Object.values(readers).map((r) => r.getBlockNumber()));
    evidence.timings.headsBeforeDecisionPost = heads;
    evidence.timings.msFromLastGrantObservedToDecisionPost = Date.now() - Date.parse(String(lastGrant.includedObservedAt));
    log("head before decision POST", heads, "last grant block", lastGrant.blockNumber);
    const data = await api("/api/v2/decisions", { request, presentation }, "decision (Northstar)");
    const respondedHeads = Object.fromEntries(
      await Promise.all(Object.entries(readers).map(async ([n, r]) => [n, await r.getBlockNumber()] as const)),
    );
    const decisionReceipt = await wait(data.transactionHash as Hex, "decision recordDecision");

    // checkedBlockHash: same block on both RPCs, and its depth when the decision was answered.
    const checkedBlockHash = checkedHash(String(data.checkedBlockHash));
    const checkedBlocks = Object.fromEntries(
      await Promise.all(
        Object.entries(readers).map(async ([n, r]) => {
          const b = await r.getBlock({ blockHash: checkedBlockHash });
          return [n, { number: b.number, hash: b.hash, timestamp: b.timestamp }] as const;
        }),
      ),
    );
    const byNumber = Object.fromEntries(
      await Promise.all(
        Object.entries(readers).map(async ([n, r]) => [
          n,
          (await r.getBlock({ blockNumber: BigInt(String(data.checkedBlock)) })).hash,
        ] as const),
      ),
    );
    const checkedNumber = BigInt(String(data.checkedBlock));
    const digest = checkedHash(await commitValue(request));
    const receipts = Object.fromEntries(
      await Promise.all(
        Object.entries(readers).map(async ([n, r]) => [
          n,
          await r.readContract({
            address: registry,
            abi: institutionAbi,
            functionName: "receipts",
            args: [account as Address, digest],
          }),
        ] as const),
      ),
    );
    evidence.decision = {
      checks: data.checks,
      transactionHash: data.transactionHash,
      decisionBlock: decisionReceipt.blockNumber,
      checkedBlock: data.checkedBlock,
      checkedBlockHash,
      reportedConfirmations: data.confirmations,
      checkedBlockByHash: checkedBlocks,
      checkedBlockHashByNumber: byNumber,
      headsWhenAnswered: respondedHeads,
      // N confirmations = head - block + 1 (the checked block counts as the first).
      confirmationsWhenAnswered: Object.fromEntries(
        Object.entries(respondedHeads).map(([n, h]) => [n, h - checkedNumber + 1n]),
      ),
      lastGrantBlock: lastGrant.blockNumber,
      checkedBlockIncludesLastGrant: checkedNumber >= BigInt(String(lastGrant.blockNumber)),
      requestDigest: digest,
      onChainReceipt: receipts,
    };
    evidence.localChecks = await verifyJourney(
      presentation,
      request,
      (await refresh(vault)).records,
      (await readers.publicnode.getBlock()).timestamp,
      GPC_ARTIFACTS,
    );

    // Revocation race (the page's "Try revoking this credential", then a fresh decision request):
    // the presentation is prepared BEFORE the revocation, then POSTed immediately. Confirmed state
    // still shows the credential current while latest shows it revoked, so the issuer must answer
    // 409 awaiting_confirmations, and once the revocation is 3 blocks deep, 422 rejected.
    if (process.env.ATTEST_REVOCATION_RACE !== "0") {
      const raceRequest = requestJourney(vault);
      const racePresentation = await prepareJourney(vault, raceRequest, GPC_ARTIFACTS);
      const revoked = await authorize(
        vault,
        0,
        "revoke",
        0,
        new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      );
      const revokeReceipt = await wait(revoked.transactionHash as Hex, "credential 0 revoke");
      const race = await api(
        "/api/v2/decisions",
        { request: raceRequest, presentation: racePresentation },
        "decision after revocation (Northstar)",
        [422],
      );
      const raceEntries = evidence.http.filter((e) => e.label === "decision after revocation (Northstar)");
      evidence.revocationRace = {
        revokeBlock: revokeReceipt.blockNumber,
        attempts: raceEntries.length,
        sawAwaitingConfirmations: raceEntries.some((e) => e.code === "awaiting_confirmations"),
        finalStatus: race.status ?? 200,
        finalChecks: race.checks,
        transactionHash: race.transactionHash,
      };
    }
    evidence.finishedAt = now();
    await writeFile(EVIDENCE_FILE, json(evidence));
    console.log(json(evidence));
    log("evidence written to", EVIDENCE_FILE);

    expect(Object.values(checkedBlocks).every((b) => b.hash === checkedBlockHash && b.number === checkedNumber)).toBe(true);
    expect(Object.values(byNumber).every((h) => h === checkedBlockHash)).toBe(true);
    expect(Object.values(receipts).every(Boolean)).toBe(true);
    expect((data.checks as { pass: boolean }[]).every((c) => c.pass)).toBe(true);
    if (evidence.revocationRace) {
      expect(evidence.revocationRace.finalStatus).toBe(422);
      expect(evidence.revocationRace.transactionHash).toBeUndefined();
    }
  },
);
