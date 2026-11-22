import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { privateClaimRootsAbi } from "../src/economy";
import {
  presentationReceiptsAbi, receiptAttributeId, receiptSatisfies, receiptSubjectId, requestDigestBytes32,
  requestDigestFromLimbs, requestDigestLimbs, validateReceiptSignals, type StoredReceipt,
} from "../src/receipts";

const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");

describe("presentation receipt encodings", () => {
  it("splits request digests into injective 128-bit limbs and rejects malformed digests", () => {
    const d = digestOf("request-a");
    const { hi, lo } = requestDigestLimbs(d);
    expect(hi < 1n << 128n && lo < 1n << 128n).toBe(true);
    expect(requestDigestFromLimbs(hi, lo)).toBe(d);
    expect(requestDigestBytes32(d)).toBe(`0x${d}`);
    for (const bad of ["", d.toUpperCase(), `0x${d}`, d.slice(1), `${d}0`]) expect(() => requestDigestLimbs(bad)).toThrow();
    expect(() => requestDigestFromLimbs(1n << 128n, 0n)).toThrow();
  });
  it("domain-separates subject and attribute labels below the BN254 field", () => {
    const field = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
    expect(receiptSubjectId("supplier:acme")).not.toBe(receiptAttributeId("supplier:acme"));
    expect(receiptSubjectId("supplier:acme")).not.toBe(receiptSubjectId("supplier:acme2"));
    expect(receiptSubjectId("supplier:acme") < field).toBe(true);
    expect(() => receiptSubjectId("")).toThrow();
  });
  it("validates signals against the expected contract and chain before submission", () => {
    const contract = "0x00000000000000000000000000000000000000aa" as Address;
    const { hi, lo } = requestDigestLimbs(digestOf("r"));
    const good = [5n, 6n, hi, lo, BigInt(contract), 11155111n, 7n, 100n, 2000n, 9n, 10n];
    expect(() => validateReceiptSignals(good, { contract, chainId: 11155111n, nowSeconds: 1000n })).not.toThrow();
    const mutate = (i: number, v: bigint) => good.map((x, j) => (j === i ? v : x));
    for (const signals of [mutate(4, 1n), mutate(5, 1n), mutate(8, 999n), mutate(0, 0n), mutate(2, 1n << 128n),
      mutate(10, 0n), good.slice(0, 10)])
      expect(() => validateReceiptSignals(signals, { contract, chainId: 11155111n, nowSeconds: 1000n })).toThrow();
  });
  it("makes consumers compare issuer, attribute, threshold, subject binding and validity", () => {
    const issuer = "0x00000000000000000000000000000000000000bb" as Address;
    const receipt: StoredReceipt = {
      issuer, blockNumber: 10n, validThrough: 2000n, root: 1n, nullifier: 2n,
      attribute: receiptAttributeId("cgl.each-occurrence-usd"), threshold: 1_000_000n, subjectBinding: 42n,
    };
    const expected = { acceptedIssuers: [issuer], attribute: "cgl.each-occurrence-usd", minimum: 1_000_000n, subjectBinding: 42n, nowSeconds: 1500n };
    expect(receiptSatisfies(receipt, expected)).toBe(true);
    expect(receiptSatisfies({ ...receipt, blockNumber: 0n }, expected)).toBe(false);
    expect(receiptSatisfies(receipt, { ...expected, acceptedIssuers: ["0x00000000000000000000000000000000000000cc"] })).toBe(false);
    expect(receiptSatisfies(receipt, { ...expected, attribute: "employees" })).toBe(false);
    expect(receiptSatisfies(receipt, { ...expected, minimum: 2_000_000n })).toBe(false);
    expect(receiptSatisfies(receipt, { ...expected, subjectBinding: 43n })).toBe(false);
    expect(receiptSatisfies(receipt, { ...expected, nowSeconds: 2001n })).toBe(false);
  });
});

// ---- Toolchain-gated: real circuit, Groth16 proofs and Anvil ----------------
const root = path.resolve(import.meta.dirname, "../../..");
const fixture = path.join(root, "zk/.generated/presentation-receipt-v1");
const toolPath = process.env.ATTEST_ZK_TOOLS ?? "/tmp/attest-zk-toolchain";
const binary = process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const port = 18879, url = `http://127.0.0.1:${port}`;
const reader = createPublicClient({ chain: sepolia, transport: http(url) });
const wallet = createWalletClient({ chain: sepolia, transport: http(url) });
const available = existsSync(path.join(fixture, "transcript.json")) &&
  existsSync(path.join(fixture, "final/Groth16Verifier.json")) &&
  existsSync(path.join(toolPath, "node_modules/.bin/snarkjs")) && existsSync(binary) &&
  existsSync(path.join(root, "contracts/artifacts/PresentationReceipts.json"));

type Artifact = { abi: any; bytecode: Hex };
type Transcript = { mode: string; circuit: { wasm: string; constraints: number }; final: { zkey: string; verificationKey: string } };
type Lib = { verifyArtifacts: (dir: string, opts?: { requireProduction?: boolean }) => Transcript };
let anvil: ChildProcess | undefined, accounts: Address[] = [], roots: Address, receipts: Address, verifier: Address;
let transcript: Transcript, lib: Lib, poseidon: any;
const phash = (inputs: bigint[]): bigint => BigInt(poseidon.F.toString(poseidon(inputs)));

async function transaction(address: Address, abi: any, account: Address, fn: string, args: readonly unknown[] = []) {
  const sim = await reader.simulateContract({ address, abi, account, functionName: fn, args: args as never });
  const hash = await wallet.writeContract(sim.request);
  const result = await reader.waitForTransactionReceipt({ hash });
  if (result.status !== "success") throw new Error("On-chain transaction reverted");
  return { result, value: sim.result };
}
async function deploy(artifact: Artifact, args: readonly unknown[] = []) {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: args as never, account: accounts[0]! });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("deploy failed");
  return receipt.contractAddress;
}

const ATTRIBUTE = "cgl.each-occurrence-usd";
type Claim = { claimSecret: bigint; holderSecret: bigint; subject: string; attribute: string; value: bigint; validUntil: bigint };
type Tree = { root: bigint; paths: Map<Claim, { siblings: bigint[]; directions: bigint[] }> };
const leafOf = (c: Claim, issuer: bigint) => phash([c.claimSecret, c.holderSecret, receiptSubjectId(c.subject),
  receiptAttributeId(c.attribute), c.value, c.validUntil, issuer]);
/** Depth-8 tree with two claim leaves as level-0 siblings and fixed filler above. */
function buildTree(a: Claim, b: Claim, issuer: bigint): Tree {
  const la = leafOf(a, issuer), lb = leafOf(b, issuer);
  const filler = [101n, 202n, 303n, 404n, 505n, 606n, 707n];
  let level = phash([la, lb]);
  for (const s of filler) level = phash([level, s]);
  const rest = filler.map(() => 0n);
  return { root: level, paths: new Map([
    [a, { siblings: [lb, ...filler], directions: [0n, ...rest] }],
    [b, { siblings: [la, ...filler], directions: [1n, ...rest] }],
  ]) };
}
type Proof = { a: [bigint, bigint]; b: [[bigint, bigint], [bigint, bigint]]; c: [bigint, bigint]; signals: bigint[] };
let counter = 0;
async function prove(tree: Tree, claim: Claim, o: {
  request: string; threshold: bigint; contract?: Address; chainId?: bigint; attribute?: string; subject?: string; salt?: bigint; validThrough?: bigint;
}): Promise<Proof> {
  const issuer = BigInt(accounts[1]!);
  const { hi, lo } = requestDigestLimbs(o.request);
  const now = (await reader.getBlock()).timestamp;
  const subjectId = receiptSubjectId(o.subject ?? claim.subject);
  const salt = o.salt ?? 987654321n;
  const path_ = tree.paths.get(claim)!;
  const input = {
    issuer: String(issuer), root: String(tree.root), requestDigestHi: String(hi), requestDigestLo: String(lo),
    receiptContract: String(BigInt(o.contract ?? receipts)), chainId: String(o.chainId ?? 11155111n),
    attribute: String(receiptAttributeId(o.attribute ?? claim.attribute)), threshold: String(o.threshold),
    validThrough: String(o.validThrough ?? now + 600n),
    subjectBinding: String(phash([subjectId, salt, hi, lo])),
    nullifier: String(phash([claim.claimSecret, hi, lo, 81601n])),
    claimSecret: String(claim.claimSecret), holderSecret: String(claim.holderSecret),
    subjectId: String(subjectId), subjectSalt: String(salt), value: String(claim.value), validUntil: String(claim.validUntil),
    siblings: path_.siblings.map(String), directions: path_.directions.map(String),
  };
  const name = `receipt-${process.pid}-${counter++}`;
  const inputPath = path.join(fixture, `${name}-input.json`);
  const proofPath = path.join(fixture, `${name}-proof.json`), publicPath = path.join(fixture, `${name}-public.json`);
  writeFileSync(inputPath, JSON.stringify(input));
  const snark = (args: string[]) => {
    const p = spawnSync(path.join(toolPath, "node_modules/.bin/snarkjs"), args, { cwd: root, encoding: "utf8", timeout: 180_000 });
    if (p.status !== 0) throw new Error(`snarkjs failed: ${p.stderr} ${p.stdout}`);
    return p.stdout;
  };
  snark(["groth16", "fullprove", inputPath, path.join(fixture, transcript.circuit.wasm), path.join(fixture, transcript.final.zkey), proofPath, publicPath]);
  if (!snark(["groth16", "verify", path.join(fixture, transcript.final.verificationKey), publicPath, proofPath]).includes("OK"))
    throw new Error("off-chain verification failed");
  const proof = JSON.parse(readFileSync(proofPath, "utf8")) as { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  const signals = (JSON.parse(readFileSync(publicPath, "utf8")) as string[]).map(BigInt);
  expect(signals.length).toBe(11);
  return {
    a: [BigInt(proof.pi_a[0]!), BigInt(proof.pi_a[1]!)],
    b: [[BigInt(proof.pi_b[0]![1]!), BigInt(proof.pi_b[0]![0]!)], [BigInt(proof.pi_b[1]![1]!), BigInt(proof.pi_b[1]![0]!)]],
    c: [BigInt(proof.pi_c[0]!), BigInt(proof.pi_c[1]!)],
    signals,
  };
}
const submit = (p: Proof, signals: readonly bigint[] = p.signals) =>
  transaction(receipts, presentationReceiptsAbi, accounts[3]!, "submitReceipt", [p.a, p.b, p.c, signals]);

beforeAll(async () => {
  if (!available) return;
  // Fixture loader: fail closed on any artifact hash mismatch before using keys.
  lib = await import(pathToFileURL(path.join(root, "zk/ceremony/lib.mjs")).href) as Lib;
  transcript = lib.verifyArtifacts(fixture);
  poseidon = await createRequire(path.join(toolPath, "package.json"))("circomlibjs").buildPoseidon();
  anvil = spawn(binary, ["--port", String(port), "--chain-id", "11155111", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { accounts = await wallet.getAddresses(); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (accounts.length < 4) throw new Error("Anvil unavailable");
  const load = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Artifact;
  verifier = await deploy(load(path.join(fixture, "final/Groth16Verifier.json")));
  roots = await deploy(load(path.join(root, "contracts/artifacts/PrivateClaimRoots.json")));
  receipts = await deploy(load(path.join(root, "contracts/artifacts/PresentationReceipts.json")), [roots, verifier]);
  await transaction(roots, privateClaimRootsAbi, accounts[0]!, "configureIssuer", [accounts[1]!, true]);
}, 120_000);
afterAll(() => { anvil?.kill(); });

describe.skipIf(!available)("presentation receipts verified on-chain (synthetic test keys)", () => {
  it("refuses the synthetic fixture on a production path", () => {
    expect(transcript.mode).toBe("SYNTHETIC_TEST_ONLY");
    expect(() => lib.verifyArtifacts(fixture, { requireProduction: true })).toThrow(/refusing SYNTHETIC_TEST_ONLY/);
  });

  it("accepts a valid receipt once and rejects stale roots, wrong bindings, replays and revoked issuers", async () => {
    const issuer = accounts[1]!;
    const now = (await reader.getBlock()).timestamp;
    const acme: Claim = { claimSecret: 0x1234567890abcdef1234567890abcdefn, holderSecret: 0xfeedfacecafebeefn,
      subject: "supplier:acme", attribute: ATTRIBUTE, value: 2_000_000n, validUntil: now + 86_400n };
    const other: Claim = { claimSecret: 0x99887766554433221100n, holderSecret: 0xabcdefn,
      subject: "supplier:acme", attribute: ATTRIBUTE, value: 5_000_000n, validUntil: now + 86_400n };
    const tree = buildTree(acme, other, BigInt(issuer));
    await transaction(roots, privateClaimRootsAbi, issuer, "replaceRoot", [tree.root]);

    const request1 = digestOf("attest.proof-request/v1 #1");
    const p1 = await prove(tree, acme, { request: request1, threshold: 1_000_000n });
    validateReceiptSignals(p1.signals, { contract: receipts, chainId: 11155111n, nowSeconds: now });

    // Wrong request digest: altering either limb breaks the proof.
    const { hi, lo } = requestDigestLimbs(digestOf("another request"));
    await expect(submit(p1, p1.signals.map((x, i) => (i === 2 ? hi : x)))).rejects.toThrow(/InvalidProof/);
    await expect(submit(p1, p1.signals.map((x, i) => (i === 3 ? lo : x)))).rejects.toThrow(/InvalidProof/);
    // Tampered threshold / attribute / binding are not covered by the proof.
    await expect(submit(p1, p1.signals.map((x, i) => (i === 7 ? 3_000_000n : x)))).rejects.toThrow(/InvalidProof/);
    await expect(submit(p1, p1.signals.map((x, i) => (i === 6 ? receiptAttributeId("employees") : x)))).rejects.toThrow(/InvalidProof/);
    await expect(submit(p1, p1.signals.map((x, i) => (i === 9 ? x + 1n : x)))).rejects.toThrow(/InvalidProof/);
    // Wrong contract / chain: honest proofs for another domain are refused.
    const elsewhere = await prove(tree, acme, { request: request1, threshold: 1_000_000n, contract: roots });
    await expect(submit(elsewhere)).rejects.toThrow(/WrongDomain/);
    const otherChain = await prove(tree, acme, { request: request1, threshold: 1_000_000n, chainId: 1n });
    await expect(submit(otherChain)).rejects.toThrow(/WrongDomain/);
    // Stale root: the issuer replaced its root; the proof's root is no longer live.
    await transaction(roots, privateClaimRootsAbi, issuer, "replaceRoot", [12345n]);
    await expect(submit(p1)).rejects.toThrow(/UntrustedRoot/);
    await transaction(roots, privateClaimRootsAbi, issuer, "replaceRoot", [tree.root]);

    // Valid receipt.
    const { result, value } = await submit(p1);
    expect(value).toBe(`0x${request1}`);
    expect(result.gasUsed).toBeLessThan(600_000n);
    const stored = await reader.readContract({ address: receipts, abi: presentationReceiptsAbi, functionName: "receiptOf", args: [`0x${request1}`] });
    expect(stored.issuer).toBe(issuer);
    expect(stored.root).toBe(tree.root);
    expect(stored.nullifier).toBe(p1.signals[10]);
    expect(stored.threshold).toBe(1_000_000n);
    expect(stored.attribute).toBe(receiptAttributeId(ATTRIBUTE));
    expect(stored.blockNumber).toBe(result.blockNumber);
    expect(await reader.readContract({ address: receipts, abi: presentationReceiptsAbi, functionName: "nullifierUsed", args: [p1.signals[10]!] })).toBe(true);
    // The consumer's own comparison: right subject passes, another subject does not.
    const binding = (subject: string) => { const l = requestDigestLimbs(request1); return phash([receiptSubjectId(subject), 987654321n, l.hi, l.lo]); };
    const expected = { acceptedIssuers: [issuer], attribute: ATTRIBUTE, minimum: 1_000_000n, nowSeconds: now };
    expect(receiptSatisfies(stored, { ...expected, subjectBinding: binding("supplier:acme") })).toBe(true);
    expect(receiptSatisfies(stored, { ...expected, subjectBinding: binding("supplier:globex") })).toBe(false);

    // Replays: the same proof, and a second claim for the same request, both fail.
    await expect(submit(p1)).rejects.toThrow(/RequestAlreadyReceipted/);
    const second = await prove(tree, other, { request: request1, threshold: 1_000_000n });
    await expect(submit(second)).rejects.toThrow(/RequestAlreadyReceipted/);
    // The same claim answers a new request with an unlinkable nullifier.
    const request2 = digestOf("attest.proof-request/v1 #2");
    const p2 = await prove(tree, acme, { request: request2, threshold: 1_500_000n });
    expect(p2.signals[10]).not.toBe(p1.signals[10]);

    // Revoked issuer: the admin revokes, the root is cleared, the receipt fails.
    await transaction(roots, privateClaimRootsAbi, accounts[0]!, "configureIssuer", [issuer, false]);
    await expect(submit(p2)).rejects.toThrow(/UntrustedRoot/);
    await transaction(roots, privateClaimRootsAbi, accounts[0]!, "configureIssuer", [issuer, true]);
    await transaction(roots, privateClaimRootsAbi, issuer, "replaceRoot", [tree.root]);
    await submit(p2);
    expect(await reader.readContract({ address: receipts, abi: presentationReceiptsAbi, functionName: "hasReceipt", args: [`0x${request2}`] })).toBe(true);
  }, 400_000);

  it("cannot prove insufficient, mislabelled, expired or mis-subjected witnesses", async () => {
    const issuer = BigInt(accounts[1]!);
    const now = (await reader.getBlock()).timestamp;
    const small: Claim = { claimSecret: 77n, holderSecret: 88n, subject: "supplier:acme", attribute: ATTRIBUTE, value: 999_999n, validUntil: now + 86_400n };
    const expired: Claim = { claimSecret: 79n, holderSecret: 89n, subject: "supplier:acme", attribute: ATTRIBUTE, value: 5_000_000n, validUntil: now + 60n };
    const tree = buildTree(small, expired, issuer);
    const request = digestOf("attest.proof-request/v1 #3");
    // Hidden value below the public minimum.
    await expect(prove(tree, small, { request, threshold: 1_000_000n })).rejects.toThrow();
    // A value issued for another attribute cannot satisfy this attribute.
    await expect(prove(tree, small, { request, threshold: 1n, attribute: "employees" })).rejects.toThrow();
    // A claim about one subject cannot be presented as another subject's.
    await expect(prove(tree, small, { request, threshold: 1n, subject: "supplier:globex" })).rejects.toThrow();
    // Claim validity ends before the receipt's validThrough.
    await expect(prove(tree, expired, { request, threshold: 1n, validThrough: now + 600n })).rejects.toThrow();
    // Sanity: the same tree proves a satisfiable statement.
    await expect(prove(tree, small, { request, threshold: 999_999n })).resolves.toBeTruthy();
  }, 300_000);
});
