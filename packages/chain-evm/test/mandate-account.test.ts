/**
 * MandateAccount against anvil. The ERC-4337 EntryPoint is NOT deployed: the test impersonates the canonical
 * v0.7 EntryPoint address (anvil_impersonateAccount) and plays its role. For each op it computes the v0.7
 * userOpHash (cross-checked against viem's reference implementation), calls validateUserOp, interprets the
 * returned validationData exactly as the EntryPoint would (sigFailed, validAfter/validUntil against the block
 * timestamp, revert = rejected), and only then calls executeUserOp with the full packed op.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, decodeAbiParameters, encodeDeployData, encodeFunctionData, http, keccak256, pad, toBytes, toHex, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getUserOperationHash } from "viem/account-abstraction";
import { sepolia } from "viem/chains";
import {
  ENTRY_POINT_V07, GATEKEEPER_DECISION_TYPE, MandateAccountError, assertRpcChain, assertTestnetChain, buildMandateUserOp, cosignMandateUserOp,
  decodeValidationData, encodeMandateSignature, gatekeeperDecisionDigest, gatekeeperDecisionFromUserOp, mandateAccountAbi, mandateRegistration,
  packUints, registerMandateArgs, signGatekeeperDecision, signMandateUserOp, signSessionUserOp, testStablecoinAbi, userOpGas, userOperationHash,
  type GatekeeperDecision, type MandateSpend, type PackedUserOp,
} from "../src/mandates";

const binary = process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const available = existsSync(binary);
const root = path.resolve(import.meta.dirname, "../../..");
const port = 18922, url = `http://127.0.0.1:${port}`, chainId = 11155111;
const reader = createPublicClient({ chain: sepolia, transport: http(url) });
const wallet = createWalletClient({ chain: sepolia, transport: http(url) });
const EP = ENTRY_POINT_V07;
const ZERO32 = pad("0x", { size: 32 });

let anvil: ChildProcess | undefined;
let owner: Address, guardian: Address, stranger: Address;
let usd: Address, other: Address, account: Address, account2: Address;
const gatekeeper = privateKeyToAccount(generatePrivateKey());
const payees = [1, 2, 3, 4].map(() => privateKeyToAccount(generatePrivateKey()).address) as [Address, Address, Address, Address];

const artifact = (name: string) => JSON.parse(readFileSync(path.join(root, `contracts/artifacts/${name}.json`), "utf8")) as { abi: Abi; bytecode: Hex };
async function deploy(name: string, args: readonly unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ account: owner, abi, bytecode, args });
  return (await reader.waitForTransactionReceipt({ hash })).contractAddress!;
}
const reason = (e: unknown) => {
  const m = String((e as Error).message).match(/reverted with the following reason:\s*\n?(.*)/);
  return m?.[1]?.trim() ?? String((e as Error).message).split("\n")[0]!;
};
async function send(from: Address, address: Address, functionName: string, args: readonly unknown[], abi: Abi = mandateAccountAbi) {
  try {
    const sim: { request: unknown } = await reader.simulateContract({ address, abi, account: from, functionName, args } as never);
    await reader.waitForTransactionReceipt({ hash: await wallet.writeContract(sim.request as never) });
    return "ok";
  } catch (e) { return reason(e); }
}
const rpc = (method: string, params: unknown[]) => reader.request({ method: method as never, params: params as never });
const now = async () => Number((await reader.getBlock()).timestamp);
const spentOf = async (a: Address, d: Hex) =>
  (await reader.readContract({ address: a, abi: mandateAccountAbi, functionName: "getMandate", args: [d] })).spent;
const balance = (token: Address, who: Address) => reader.readContract({ address: token, abi: testStablecoinAbi, functionName: "balanceOf", args: [who] });

type Outcome = { ok: true } | { ok: false; stage: "validation" | "signature" | "time" | "execution"; reason: string };

/** Plays the EntryPoint for one op: validate, apply validationData, then execute. */
async function submit(op: PackedUserOp, userOpHash: Hex, target: Address = op.sender): Promise<Outcome> {
  let data: bigint;
  try {
    data = (await reader.simulateContract({ address: target, abi: mandateAccountAbi, account: EP, functionName: "validateUserOp", args: [op, userOpHash, 0n] })).result;
  } catch (e) { return { ok: false, stage: "validation", reason: reason(e) }; }
  const v = decodeValidationData(data);
  if (v.sigFailed) return { ok: false, stage: "signature", reason: "SIG_VALIDATION_FAILED" };
  const t = await now() + 1;
  if (t < v.validAfter || t > v.validUntil) return { ok: false, stage: "time", reason: t > v.validUntil ? "expired" : "not yet valid" };
  const r = await send(EP, target, "executeUserOp", [op, userOpHash]);
  return r === "ok" ? { ok: true } : { ok: false, stage: "execution", reason: r };
}

let nonce = 0n;
async function signed(spend: MandateSpend, session: PrivateKeyAccount, opts: { sender?: Address; ttl?: number; gk?: PrivateKeyAccount; gas?: Partial<Parameters<typeof buildMandateUserOp>[0]> } = {}) {
  const sender = opts.sender ?? account;
  const op = buildMandateUserOp({ ...spend, account: sender, nonce: nonce++, ...opts.gas });
  return signMandateUserOp({ op, chainId, client: reader, decisionValidUntil: (await now()) + (opts.ttl ?? 600), session, gatekeeper: opts.gk ?? gatekeeper });
}
/** Gatekeeper decision derived from the op (the supported path), with optional field overrides for attack tests. */
const decisionFor = (op: PackedUserOp, validUntil: number, override: Partial<GatekeeperDecision> = {}): GatekeeperDecision =>
  ({ ...gatekeeperDecisionFromUserOp(op, { chainId, validUntil }), ...override });
const validate = async (op: PackedUserOp, userOpHash: Hex) =>
  (await reader.simulateContract({ address: op.sender, abi: mandateAccountAbi, account: EP, functionName: "validateUserOp", args: [op, userOpHash, 0n] })).result;
/** Mine a tx without simulation (so it lands at an exact block timestamp) and return its status. */
async function mine(from: Address, address: Address, functionName: string, args: readonly unknown[], timestamp?: number) {
  if (timestamp !== undefined) await rpc("evm_setNextBlockTimestamp", [timestamp]);
  const hash = await wallet.writeContract({ account: from, address, abi: mandateAccountAbi, functionName, args, gas: 1_000_000n } as never);
  return (await reader.waitForTransactionReceipt({ hash })).status;
}

// Seeded PRNG so failures are reproducible (MANDATE_FUZZ_SEED overrides).
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const digest = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
interface ModelMandate { digest: Hex; parent: Hex; perAction: bigint; total: bigint; payees: Address[]; validUntil: number; spent: bigint; revoked: boolean }
const model = new Map<Hex, ModelMandate>();
const chainOf = (d: Hex) => { const out: ModelMandate[] = []; for (let c = d; c !== ZERO32; c = model.get(c)!.parent) out.push(model.get(c)!); return out; };

async function register(m: Omit<ModelMandate, "spent" | "revoked">, target = account) {
  const r = await send(owner, target, "registerMandate", [m.digest, m.parent, usd, m.perAction, m.total, GAS_CAP, 0, m.validUntil, m.payees]);
  if (r === "ok" && target === account) model.set(m.digest, { ...m, spent: 0n, revoked: false });
  return r;
}
const sessionKeys = new Map<string, { key: PrivateKeyAccount; mandate: Hex; revoked: boolean }>();
async function addKey(name: string, mandate: Hex, target = account) {
  const key = privateKeyToAccount(generatePrivateKey());
  expect(await send(owner, target, "registerSessionKey", [key.address, mandate, 0, 2 ** 40])).toBe("ok");
  if (target === account) sessionKeys.set(name, { key, mandate, revoked: false });
  return key;
}

const FAR = 2 ** 40;
/** Per-op gas-cost cap (wei) for the main tree; default ops cost 560_000 gas * 2 gwei = 1.12e15. */
const GAS_CAP = 10n ** 16n;
const R = digest(0x100), A = digest(0x200), B = digest(0x300), A1 = digest(0x210), C = digest(0x400), E = digest(0x500);

beforeAll(async () => {
  if (!available) {
    if (process.env.CI) throw new Error(`anvil not found at ${binary}; MandateAccount tests must not be skipped in CI`);
    return;
  }
  const compiled = spawnSync(process.execPath, ["scripts/compile.mjs"], { cwd: path.join(root, "contracts"), encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
  anvil = spawn(binary, ["--port", String(port), "--chain-id", String(chainId), "--silent"], { stdio: "ignore" });
  let accounts: Address[] = [];
  for (let i = 0; i < 100 && accounts.length === 0; i++) {
    try { accounts = await wallet.getAddresses(); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  [owner, guardian, stranger] = accounts as [Address, Address, Address];
  await rpc("anvil_impersonateAccount", [EP]);
  await rpc("anvil_setBalance", [EP, "0x56BC75E2D63100000"]);
  usd = await deploy("TestStablecoin", ["Test USD", "tUSD", 6]);
  other = await deploy("TestStablecoin", ["Other Test", "tOTH", 6]);
  account = await deploy("MandateAccount", [EP, owner, gatekeeper.address, guardian]);
  account2 = await deploy("MandateAccount", [EP, owner, gatekeeper.address, guardian]);
  for (const a of [account, account2]) {
    expect(await send(owner, usd, "mint", [a, 1_000_000n], testStablecoinAbi)).toBe("ok");
    expect(await send(owner, other, "mint", [a, 1_000_000n], testStablecoinAbi)).toBe("ok");
  }
}, 60_000);
afterAll(() => anvil?.kill());

describe("MandateAccount client (pure)", () => {
  it("accepts only allowlisted test networks everywhere it hashes or signs", async () => {
    for (const id of [1, 10, 137, 8453, 42161, 11155112, 0, -1, 1.5]) expect(() => assertTestnetChain(id)).toThrow(MandateAccountError);
    for (const id of [31337, 1337, 11155111, 84532]) expect(() => assertTestnetChain(id)).not.toThrow();
    const op = buildMandateUserOp({ account: payees[0], nonce: 0n, mandateDigest: R, token: payees[1], payee: payees[2], amount: 1n });
    expect(() => userOperationHash(op, EP, 1)).toThrow(/chain_not_allowed/);
    expect(() => userOperationHash(op, EP, 8453)).toThrow(/chain_not_allowed/);
    expect(() => gatekeeperDecisionDigest({ ...gatekeeperDecisionFromUserOp(op, { chainId, validUntil: 1 }), chainId: 1 })).toThrow(/chain_not_allowed/);
    // The RPC's chain id must match the one being signed for.
    await expect(assertRpcChain({ getChainId: async () => 1 }, chainId)).rejects.toThrow(/chain_id_mismatch/);
    await expect(assertRpcChain({ getChainId: async () => 84532 }, chainId)).rejects.toThrow(/chain_id_mismatch/);
    await expect(assertRpcChain({ getChainId: async () => 1 }, 1)).rejects.toThrow(/chain_not_allowed/);
    const session = privateKeyToAccount(generatePrivateKey());
    await expect(signMandateUserOp({ op, chainId, client: { getChainId: async () => 10 }, decisionValidUntil: 10, session, gatekeeper }))
      .rejects.toThrow(/chain_id_mismatch/);
  });

  it("rejects values that do not fit the packed uint128 gas fields", () => {
    expect(packUints(2n ** 128n - 1n, 0n)).toBe(`0x${"f".repeat(32)}${"0".repeat(32)}`);
    expect(() => packUints(2n ** 128n, 0n)).toThrow(/uint128_overflow/);
    expect(() => packUints(0n, 2n ** 128n)).toThrow(/uint128_overflow/);
    expect(() => packUints(-1n, 0n)).toThrow(/uint128_overflow/);
    const base = { account: payees[0], nonce: 0n, mandateDigest: R, token: payees[1], payee: payees[2], amount: 1n };
    expect(() => buildMandateUserOp({ ...base, maxFeePerGas: 2n ** 128n })).toThrow(/uint128_overflow/);
    expect(() => buildMandateUserOp({ ...base, verificationGasLimit: 2n ** 200n })).toThrow(/uint128_overflow/);
    expect(() => buildMandateUserOp({ ...base, preVerificationGas: 2n ** 128n })).toThrow(/uint128_overflow/);
  });

  it("derives the co-signed decision from the full op, never from a bare hash", async () => {
    const op = buildMandateUserOp({ account: payees[0], nonce: 3n, mandateDigest: R, token: payees[1], payee: payees[2], amount: 9n,
      verificationGasLimit: 100n, callGasLimit: 200n, preVerificationGas: 300n, maxFeePerGas: 7n });
    const d = gatekeeperDecisionFromUserOp(op, { chainId, validUntil: 99 });
    expect(d).toMatchObject({ mandateDigest: R, token: payees[1], payee: payees[2], amount: 9n, nonce: 3n, account: payees[0], entryPoint: EP,
      totalGasLimit: 600n, maxFeePerGas: 7n, userOpHash: userOperationHash(op, EP, chainId), validUntil: 99 });
    expect(userOpGas(op).maxGasCost).toBe(4200n);
    expect(() => gatekeeperDecisionFromUserOp({ ...op, callData: "0xa9059cbb" }, { chainId, validUntil: 99 })).toThrow(/invalid_call_data/);
    expect(() => gatekeeperDecisionFromUserOp({ ...op, paymasterAndData: "0x01" }, { chainId, validUntil: 99 })).toThrow(/paymaster_not_supported/);
    expect(() => gatekeeperDecisionFromUserOp({ ...op, initCode: "0x01" }, { chainId, validUntil: 99 })).toThrow(/init_code_not_supported/);
    // The policy hook sees the maximum gas cost and can refuse to sign.
    const client = { getChainId: async () => chainId };
    await expect(cosignMandateUserOp({ op, chainId, client, validUntil: 99, gatekeeper, approve: (x) => x.maxGasCost <= 4199n }))
      .rejects.toThrow(/decision_denied/);
    const { signature, decision } = await cosignMandateUserOp({ op, chainId, client, validUntil: 99, gatekeeper, approve: (x) => x.maxGasCost <= 4200n });
    expect(decision).toEqual(d);
    expect(signature).toBe(await signGatekeeperDecision(gatekeeper, d));
    expect(GATEKEEPER_DECISION_TYPE).toBe(
      "GatekeeperDecision(address entryPoint,bytes32 userOpHash,uint256 nonce,bytes32 mandateDigest,address token,address payee,uint256 amount,uint256 totalGasLimit,uint256 maxFeePerGas,uint48 validUntil)");
  });

  it("computes the ERC-4337 v0.7 userOpHash exactly like viem's reference", () => {
    const op = buildMandateUserOp({ account: payees[0], nonce: 7n, mandateDigest: R, token: payees[1], payee: payees[2], amount: 5n,
      verificationGasLimit: 123_456n, callGasLimit: 654_321n, preVerificationGas: 42_000n, maxPriorityFeePerGas: 3n, maxFeePerGas: 9n });
    expect(userOperationHash(op, EP, chainId)).toBe(getUserOperationHash({ chainId, entryPointAddress: EP, entryPointVersion: "0.7",
      userOperation: { sender: op.sender, nonce: op.nonce, callData: op.callData, callGasLimit: 654_321n, verificationGasLimit: 123_456n,
        preVerificationGas: 42_000n, maxFeePerGas: 9n, maxPriorityFeePerGas: 3n, signature: "0x" } }));
  });

  it("maps an Attest mandate to registration args without widening its window", () => {
    const reg = mandateRegistration({ validFrom: 1_700_000_000_500, validUntil: 1_700_000_100_900, parentDigest: "a".repeat(64),
      constraints: { money: { currency: "USD", maxPerActionMinor: 2500, maxTotalMinor: 10000 } } }, "b".repeat(64),
    { tokens: { USD: payees[0] }, payees: [payees[1]], unitsPerMinor: 10_000n, maxGasCostWei: 5n * 10n ** 15n });
    expect(reg).toEqual({ digest: `0x${"b".repeat(64)}`, parent: `0x${"a".repeat(64)}`, token: payees[0], maxPerAction: 25_000_000n,
      maxTotal: 100_000_000n, maxGasCost: 5n * 10n ** 15n, validAfter: 1_700_000_001, validUntil: 1_700_000_100, payees: [payees[1]] });
    expect(registerMandateArgs(reg)).toHaveLength(9);
    expect(() => mandateRegistration({ validFrom: 0, validUntil: 10_000, constraints: { money: { currency: "EUR", maxPerActionMinor: 1, maxTotalMinor: 1 } } },
      "b".repeat(64), { tokens: { USD: payees[0] }, payees: [payees[1]], unitsPerMinor: 1n, maxGasCostWei: 1n })).toThrow(/unsupported_currency/);
    expect(() => mandateRegistration({ validFrom: 0, validUntil: 10_000, constraints: {} }, "b".repeat(64),
      { tokens: { USD: payees[0] }, payees: [payees[1]], unitsPerMinor: 1n, maxGasCostWei: 1n })).toThrow(/mandate_has_no_money_limit/);
  });
});

describe.skipIf(!available)("MandateAccount on anvil (impersonated v0.7 EntryPoint)", () => {
  it("lets only the owner register narrowed mandates and session keys", async () => {
    expect(await register({ digest: R, parent: ZERO32, perAction: 50n, total: 300n, payees: [payees[0], payees[1], payees[2]], validUntil: FAR })).toBe("ok");
    expect(await register({ digest: A, parent: R, perAction: 40n, total: 180n, payees: [payees[0], payees[1]], validUntil: FAR })).toBe("ok");
    // Siblings A and B together allow 360 but share R's 300.
    expect(await register({ digest: B, parent: R, perAction: 30n, total: 180n, payees: [payees[1], payees[2]], validUntil: FAR })).toBe("ok");
    expect(await register({ digest: A1, parent: A, perAction: 20n, total: 120n, payees: [payees[0]], validUntil: FAR })).toBe("ok");
    const t = await now();
    expect(await register({ digest: E, parent: R, perAction: 10n, total: 100n, payees: [payees[0]], validUntil: t + 3600 })).toBe("ok");
    // Children cannot widen their parent.
    expect(await register({ digest: digest(0x901), parent: A, perAction: 41n, total: 100n, payees: [payees[0]], validUntil: FAR })).toBe("not narrowed");
    expect(await register({ digest: digest(0x902), parent: A, perAction: 10n, total: 181n, payees: [payees[0]], validUntil: FAR })).toBe("not narrowed");
    expect(await register({ digest: digest(0x903), parent: A, perAction: 10n, total: 100n, payees: [payees[2]], validUntil: FAR })).toBe("not narrowed");
    expect(await register({ digest: digest(0x904), parent: E, perAction: 1n, total: 1n, payees: [payees[0]], validUntil: t + 7200 })).toBe("not narrowed");
    expect(await send(owner, account, "registerMandate", [digest(0x905), A, other, 1n, 1n, GAS_CAP, 0, FAR, [payees[0]]])).toBe("not narrowed");
    expect(await send(owner, account, "registerMandate", [digest(0x907), A, usd, 1n, 1n, GAS_CAP + 1n, 0, FAR, [payees[0]]])).toBe("not narrowed");
    expect(await register({ digest: R, parent: ZERO32, perAction: 1n, total: 1n, payees: [payees[0]], validUntil: FAR })).toBe("mandate exists");
    expect(await send(stranger, account, "registerMandate", [digest(0x906), ZERO32, usd, 1n, 1n, GAS_CAP, 0, FAR, [payees[0]]])).toBe("not owner");
    for (const [name, d] of [["R", R], ["A", A], ["B", B], ["A1", A1], ["E", E], ["X", A]] as const) await addKey(name, d);
    const k = privateKeyToAccount(generatePrivateKey());
    expect(await send(stranger, account, "registerSessionKey", [k.address, A, 0, FAR])).toBe("not owner");
    expect(await send(guardian, account, "revokeSessionKey", [sessionKeys.get("A")!.key.address])).toBe("not owner");
    expect(await send(owner, account2, "registerSessionKey", [sessionKeys.get("A")!.key.address, A, 0, FAR])).toBe("unknown mandate"); // mandate not registered there yet
    // Same digests on a second account, so cross-account replays target a live policy.
    for (const [d, p, cap] of [[R, ZERO32, 50n], [A, R, 40n]] as const)
      expect(await send(owner, account2, "registerMandate", [d, p, usd, cap, 1000n, GAS_CAP, 0, FAR, [payees[0], payees[1]]])).toBe("ok");
    // The same agent key is enrolled on account2, so only the Gatekeeper co-signature's account binding differs.
    expect(await send(owner, account2, "registerSessionKey", [sessionKeys.get("A")!.key.address, A, 0, FAR])).toBe("ok");
  });

  it("follows ERC-4337 return conventions: entry-point only, packed validity, SIG_VALIDATION_FAILED, prefund", async () => {
    const spend = { mandateDigest: A1, token: usd, payee: payees[0], amount: 1n };
    const { op, userOpHash } = await signed(spend, sessionKeys.get("A1")!.key, { ttl: 900 });
    await expect(reader.simulateContract({ address: account, abi: mandateAccountAbi, account: stranger, functionName: "validateUserOp", args: [op, userOpHash, 0n] }))
      .rejects.toThrow(/not entry point/);
    expect(await send(stranger, account, "executeUserOp", [op, userOpHash])).toBe("not entry point");
    const { result } = await reader.simulateContract({ address: account, abi: mandateAccountAbi, account: EP, functionName: "validateUserOp", args: [op, userOpHash, 0n] });
    const decoded = decodeValidationData(result);
    expect(decoded.sigFailed).toBe(false);
    expect(decoded.aggregator).toBe(0n);
    expect(decoded.validAfter).toBe(0);
    // validUntil = min(decision expiry, mandate chain, session key) — here the decision expiry.
    expect(Math.abs(decoded.validUntil - (await now()) - 900)).toBeLessThanOrEqual(2);
    // E's mandate expiry is earlier than the decision's, so it wins.
    const e = await signed({ mandateDigest: E, token: usd, payee: payees[0], amount: 1n }, sessionKeys.get("E")!.key, { ttl: 99_999 });
    const eData = decodeValidationData((await reader.simulateContract({ address: account, abi: mandateAccountAbi, account: EP, functionName: "validateUserOp", args: [e.op, e.userOpHash, 0n] })).result);
    expect(eData.validUntil).toBe(Number((await reader.readContract({ address: account, abi: mandateAccountAbi, functionName: "getMandate", args: [E] })).validUntil));
    // Bad signatures return 1 rather than reverting; high-s malleated session signature is rejected.
    const sig = await signSessionUserOp(sessionKeys.get("A1")!.key, userOpHash);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${sig.slice(66, 130)}`), v = parseInt(sig.slice(130), 16);
    const malleated = `${sig.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    const until = (await now()) + 900;
    const gk = await signGatekeeperDecision(gatekeeper, decisionFor(op, until));
    const bad = { ...op, signature: encodeMandateSignature(until, malleated, gk) };
    expect((await reader.simulateContract({ address: account, abi: mandateAccountAbi, account: EP, functionName: "validateUserOp", args: [bad, userOpHash, 0n] })).result).toBe(1n);
    // Prefund: validateUserOp pays missingAccountFunds to the EntryPoint.
    await rpc("anvil_setBalance", [account, "0xDE0B6B3A7640000"]);
    const before = await reader.getBalance({ address: EP });
    const prefund = 12_345_678_900n;
    const hash = await wallet.writeContract({ account: EP, address: account, abi: mandateAccountAbi, functionName: "validateUserOp", args: [op, userOpHash, prefund] });
    const receipt = await reader.waitForTransactionReceipt({ hash });
    expect(await reader.getBalance({ address: EP }) - before + receipt.gasUsed * receipt.effectiveGasPrice).toBe(prefund);
    expect(await submit(op, userOpHash)).toEqual({ ok: true });
    model.get(A1)!.spent += 1n; model.get(A)!.spent += 1n; model.get(R)!.spent += 1n;
    // Malformed callData (an arbitrary call instead of the one mandate transfer) is refused.
    const arbitrary = { ...op, nonce: nonce++, callData: "0xa9059cbb" as Hex };
    const h = userOperationHash(arbitrary, EP, chainId);
    expect(await submit(arbitrary, h)).toMatchObject({ ok: false, stage: "validation", reason: "callData" });
  });

  it("gates owner powers: guardian pauses but cannot unpause or move funds; owner can withdraw", async () => {
    expect(await send(stranger, account, "pause", [])).toBe("not guardian");
    expect(await send(guardian, account, "pause", [])).toBe("ok");
    expect(await send(guardian, account, "unpause", [])).toBe("not owner");
    expect(await send(guardian, account, "execute", [usd, 0n, "0x"])).toBe("not owner");
    const { op, userOpHash } = await signed({ mandateDigest: A1, token: usd, payee: payees[0], amount: 1n }, sessionKeys.get("A1")!.key);
    expect(await submit(op, userOpHash)).toMatchObject({ ok: false, reason: "paused" });
    expect(await send(EP, account, "executeUserOp", [op, userOpHash])).toBe("paused");
    expect(await send(owner, account, "unpause", [])).toBe("ok");
    const before = await balance(usd, owner);
    const transfer = { abi: testStablecoinAbi, functionName: "transfer", args: [owner, 10n] } as const;
    expect(await send(owner, account, "execute", [usd, 0n, encodeFunctionData(transfer)])).toBe("ok");
    expect(await balance(usd, owner) - before).toBe(10n);
  });

  it("holds every invariant over a seeded random sequence of ≥ 200 ops", async () => {
    const seed = Number(process.env.MANDATE_FUZZ_SEED ?? 0x22a77e57);
    const rand = mulberry32(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const counts: Record<string, { ok: number; rejected: number }> = {};
    const tally = (kind: string, ok: boolean) => { const c = (counts[kind] ??= { ok: 0, rejected: 0 }); if (ok) c.ok++; else c.rejected++; };
    const paid = new Map<Address, bigint>();
    for (const p of payees) paid.set(p, await balance(usd, p));
    const account2Before = await balance(usd, account2);
    let last: { op: PackedUserOp; userOpHash: Hex } | undefined;
    let paused = false, expired = false, aggregateRejections = 0;
    const reasons = new Set<string>();
    const OPS = 260;

    /** Would the policy (not the signatures) allow this spend right now? */
    const policyAllows = (sp: MandateSpend) => {
      if (paused) return false;
      const chain = chainOf(sp.mandateDigest);
      // (Mandate expiry is reported through validUntil, not a revert, so it does not change this.)
      return sp.token === usd && !chain.some((m) => m.revoked || !m.payees.includes(sp.payee) || sp.amount > m.perAction || m.spent + sp.amount > m.total);
    };
    /** A signature attack must be refused; when policy alone would pass, it must be refused by the signature check. */
    const expectSigRejected = (o: Outcome, sp: MandateSpend) => {
      expect(o.ok).toBe(false);
      if (policyAllows(sp)) expect(o, `${o.ok ? "" : o.reason} for ${sp.mandateDigest.slice(-3)}/${sp.amount}`).toMatchObject({ stage: expect.stringMatching(/signature|time/) });
    };
    const expectSpend = (keyName: string, payee: Address, amount: bigint) => {
      const k = sessionKeys.get(keyName)!;
      if (k.revoked || paused || amount <= 0n) return false;
      if (k.mandate === E && expired) return false;
      const chain = chainOf(k.mandate);
      if (chain.some((m) => m.revoked || !m.payees.includes(payee) || amount > m.perAction)) return false;
      if (chain.some((m) => m.spent + amount > m.total)) { aggregateRejections++; return false; }
      return true;
    };
    const apply = (keyName: string, payee: Address, amount: bigint) => {
      for (const m of chainOf(sessionKeys.get(keyName)!.mandate)) m.spent += amount;
      paid.set(payee, paid.get(payee)! + amount);
    };

    for (let i = 0; i < OPS; i++) {
      // Scheduled state changes inside the sequence.
      if (i === 60) { expect(await send(owner, account, "revokeSessionKey", [sessionKeys.get("X")!.key.address])).toBe("ok"); sessionKeys.get("X")!.revoked = true; }
      if (i === 120) {
        // A fresh sibling registered late cannot reset R's remaining ceiling.
        expect(await register({ digest: C, parent: R, perAction: 50n, total: 300n, payees: [payees[0], payees[1], payees[2]], validUntil: FAR })).toBe("ok");
        await addKey("C", C);
      }
      if (i === 150) { await rpc("evm_increaseTime", [7200]); await rpc("evm_mine", []); expired = true; }
      if (i === 200) { expect(await send(owner, account, "revokeMandate", [B])).toBe("ok"); model.get(B)!.revoked = true; }
      if (rand() < (paused ? 0.3 : 0.03)) {
        if (paused) expect(await send(owner, account, "unpause", [])).toBe("ok");
        else expect(await send(guardian, account, "pause", [])).toBe("ok");
        paused = !paused;
      }

      const keyNames = [...sessionKeys.keys()];
      const kind = pick(["spend", "spend", "spend", "spend", "spend", "spend", "spend", "replay", "otherAccount", "otherChain", "tamperAmount",
        "tamperPayee", "wrongToken", "expiredDecision", "wrongCosigner", "unknownKey", "directExecute"] as const);
      const keyName = pick(keyNames);
      const key = sessionKeys.get(keyName)!;
      // Mostly the leaf's own allowlist, sometimes any payee (including one never allowlisted).
      const payee = rand() < 0.6 ? pick(model.get(key.mandate)!.payees) : pick(payees);
      const amount = BigInt(1 + Math.floor(rand() * (rand() < 0.75 ? 20 : 60)));
      const spend: MandateSpend = { mandateDigest: key.mandate, token: usd, payee, amount };
      let outcome: Outcome;

      switch (kind) {
        case "spend": {
          const expected = expectSpend(keyName, payee, amount);
          const s = await signed(spend, key.key);
          outcome = await submit(s.op, s.userOpHash);
          expect(outcome.ok, `op ${i} ${keyName} ${amount} -> ${JSON.stringify(outcome)}`).toBe(expected);
          if (outcome.ok) { apply(keyName, payee, amount); last = s; } else reasons.add(outcome.reason);
          break;
        }
        case "replay": {
          if (!last) continue;
          outcome = await submit(last.op, last.userOpHash);
          expect(outcome).toMatchObject({ ok: false, stage: "validation", reason: "replayed" });
          expect(await send(EP, account, "executeUserOp", [last.op, last.userOpHash])).toBe("replayed");
          break;
        }
        case "otherAccount": {
          // Session key re-signs for account2, but the Gatekeeper co-signature was for account.
          // A spend account2's policy would allow, so only the co-signature's account binding can stop it.
          const s = await signed({ ...spend, mandateDigest: A, payee: payees[0], amount: 1n }, sessionKeys.get("A")!.key);
          const op2 = { ...s.op, sender: account2 };
          const h2 = userOperationHash(op2, EP, chainId);
          const [until, , gkSig] = decodeAbiParameters([{ type: "uint48" }, { type: "bytes" }, { type: "bytes" }], s.op.signature);
          const sess = await signSessionUserOp(sessionKeys.get("A")!.key, h2);
          outcome = await submit({ ...op2, signature: encodeMandateSignature(until, sess, gkSig) }, h2);
          expect(outcome).toMatchObject({ ok: false, stage: "signature" });
          // The untouched op aimed at account2 is refused outright (sender binding).
          expect(await submit(s.op, s.userOpHash, account2)).toMatchObject({ ok: false, reason: "sender" });
          break;
        }
        case "otherChain": {
          const op = buildMandateUserOp({ ...spend, account, nonce: nonce++ });
          const h = userOperationHash(op, EP, chainId);
          const until = (await now()) + 600;
          // Same op, co-signed under Base Sepolia's domain instead of this chain's.
          const gk = await signGatekeeperDecision(gatekeeper, decisionFor(op, until, { chainId: 84532 }));
          outcome = await submit({ ...op, signature: encodeMandateSignature(until, await signSessionUserOp(key.key, h), gk) }, h);
          expectSigRejected(outcome, spend);
          break;
        }
        case "tamperAmount":
        case "tamperPayee": {
          // Gatekeeper approved one transfer; the op carries another (session key signs the tampered op).
          const op = buildMandateUserOp({ ...spend, account, nonce: nonce++ });
          const h = userOperationHash(op, EP, chainId);
          const until = (await now()) + 600;
          const approved = kind === "tamperAmount" ? { ...spend, amount: amount + 1n } : { ...spend, payee: payee === payees[0] ? payees[1] : payees[0] };
          const gk = await signGatekeeperDecision(gatekeeper, decisionFor(op, until, approved));
          outcome = await submit({ ...op, signature: encodeMandateSignature(until, await signSessionUserOp(key.key, h), gk) }, h);
          expectSigRejected(outcome, spend);
          break;
        }
        case "wrongToken": {
          const s = await signed({ ...spend, token: other }, key.key);
          outcome = await submit(s.op, s.userOpHash);
          expect(outcome.ok).toBe(false);
          if (!paused && !key.revoked) expect(outcome).toMatchObject({ reason: expect.stringMatching(/wrong token|mandate revoked/) });
          break;
        }
        case "expiredDecision": {
          const s = await signed(spend, key.key, { ttl: -5 });
          outcome = await submit(s.op, s.userOpHash);
          expect(outcome.ok).toBe(false);
          // Even if a faulty EntryPoint skipped the validUntil check, execution re-checks it.
          if (!paused) expect(await send(EP, account, "executeUserOp", [s.op, s.userOpHash])).not.toBe("ok");
          break;
        }
        case "wrongCosigner": {
          const s = await signed(spend, key.key, { gk: key.key });
          outcome = await submit(s.op, s.userOpHash);
          expectSigRejected(outcome, spend);
          expect(await send(EP, account, "executeUserOp", [s.op, s.userOpHash])).not.toBe("ok");
          break;
        }
        case "unknownKey": {
          const s = await signed(spend, privateKeyToAccount(generatePrivateKey()));
          outcome = await submit(s.op, s.userOpHash);
          expectSigRejected(outcome, spend);
          break;
        }
        case "directExecute": {
          // Execution re-checks policy even if validation were bypassed.
          const expected = expectSpend(keyName, payee, amount);
          const s = await signed(spend, key.key);
          const r = await send(EP, account, "executeUserOp", [s.op, s.userOpHash]);
          outcome = r === "ok" ? { ok: true } : { ok: false, stage: "execution", reason: r };
          expect(outcome.ok, `op ${i} direct ${keyName} ${amount} -> ${r}`).toBe(expected);
          if (outcome.ok) apply(keyName, payee, amount);
          break;
        }
      }
      tally(kind, outcome.ok);

      // Invariants after every op.
      for (const m of model.values()) {
        const spent = await spentOf(account, m.digest);
        expect(spent).toBe(m.spent);
        expect(spent).toBeLessThanOrEqual(m.total);
      }
      const r = model.get(R)!;
      const children = [A, B, C, E].map((d) => model.get(d)?.spent ?? 0n).reduce((x, y) => x + y, 0n);
      expect(r.spent).toBeGreaterThanOrEqual(children); // siblings share the parent's budget
      expect(model.get(A)!.spent).toBeGreaterThanOrEqual(model.get(A1)!.spent);
      expect(await balance(usd, payees[3])).toBe(0n); // never allowlisted
    }

    if (paused) expect(await send(owner, account, "unpause", [])).toBe("ok");
    for (const p of payees) expect(await balance(usd, p)).toBe(paid.get(p));
    // Every token that left via a session key is accounted for in the root mandate's spend.
    expect([...paid.values()].reduce((x, y) => x + y, 0n)).toBe(model.get(R)!.spent);
    expect(await balance(usd, account2)).toBe(account2Before);
    const attempted = Object.values(counts).reduce((n, c) => n + c.ok + c.rejected, 0);
    expect(attempted).toBeGreaterThanOrEqual(200);
    expect(counts.spend!.ok).toBeGreaterThanOrEqual(10);
    expect(aggregateRejections).toBeGreaterThan(0);
    // Honest-looking spends were refused for each of these reasons at least once.
    for (const r of ["paused", "payee not allowed", "per-action cap", "aggregate cap"]) expect([...reasons]).toContain(r);
    for (const kind of ["replay", "otherAccount", "otherChain", "tamperAmount", "tamperPayee", "wrongToken", "expiredDecision", "wrongCosigner", "unknownKey"])
      expect(counts[kind]?.ok ?? 0, kind).toBe(0);
    console.info(`mandate fuzz seed=${seed} ops=${attempted} R.spent=${model.get(R)!.spent}/300`, counts);
  }, 300_000);

  it("never lets siblings reset a parent's ceiling once the root is exhausted", async () => {
    const left = await reader.readContract({ address: account, abi: mandateAccountAbi, functionName: "remaining", args: [C] });
    const r = model.get(R)!;
    expect(left).toBeLessThanOrEqual(r.total - r.spent);
    // Drain R through C (C alone would allow up to 300), then a brand-new sibling still gets nothing.
    let drained = r.total - r.spent;
    while (drained > 0n) {
      const amt = drained > 50n ? 50n : drained;
      const s = await signed({ mandateDigest: C, token: usd, payee: payees[0], amount: amt }, sessionKeys.get("C")!.key);
      expect(await submit(s.op, s.userOpHash)).toEqual({ ok: true });
      drained -= amt;
    }
    expect(await spentOf(account, R)).toBe(r.total);
    expect(await register({ digest: digest(0x600), parent: R, perAction: 50n, total: 300n, payees: [payees[0]], validUntil: FAR })).toBe("ok");
    const k = await addKey("D", digest(0x600));
    const s = await signed({ mandateDigest: digest(0x600), token: usd, payee: payees[0], amount: 1n }, k);
    expect(await submit(s.op, s.userOpHash)).toMatchObject({ ok: false, stage: "validation", reason: "aggregate cap" });
  });

  it("rejects expired mandates, revoked keys and revoked ancestors by name", async () => {
    const F = digest(0x700), F1 = digest(0x710), t = await now();
    expect(await register({ digest: F, parent: ZERO32, perAction: 10n, total: 100n, payees: [payees[0]], validUntil: t + 300 })).toBe("ok");
    expect(await register({ digest: F1, parent: F, perAction: 10n, total: 100n, payees: [payees[0]], validUntil: t + 300 })).toBe("ok");
    const k = await addKey("F1", F1);
    const spend = { mandateDigest: F1, token: usd, payee: payees[0], amount: 5n };
    let s = await signed(spend, k);
    expect(await submit(s.op, s.userOpHash)).toEqual({ ok: true });
    // Wrong token, non-allowlisted payee and over per-action cap, each correctly co-signed.
    for (const [bad, why] of [[{ ...spend, token: other }, "wrong token"], [{ ...spend, payee: payees[1] }, "payee not allowed"], [{ ...spend, amount: 11n }, "per-action cap"]] as const) {
      s = await signed(bad, k);
      expect(await submit(s.op, s.userOpHash)).toMatchObject({ ok: false, stage: "validation", reason: why });
    }
    // Revoking the parent disables the child.
    expect(await send(owner, account, "revokeMandate", [F])).toBe("ok");
    s = await signed(spend, k);
    expect(await submit(s.op, s.userOpHash)).toMatchObject({ ok: false, reason: "mandate revoked" });
    // Expiry: a fresh root, used once, then time passes.
    const G = digest(0x800);
    expect(await register({ digest: G, parent: ZERO32, perAction: 10n, total: 100n, payees: [payees[0]], validUntil: (await now()) + 300 })).toBe("ok");
    const g = await addKey("G", G);
    s = await signed({ ...spend, mandateDigest: G }, g, { ttl: 3600 });
    const late = await signed({ ...spend, mandateDigest: G }, g, { ttl: 3600 });
    expect(await submit(s.op, s.userOpHash)).toEqual({ ok: true });
    await rpc("evm_increaseTime", [600]); await rpc("evm_mine", []);
    expect(await submit(late.op, late.userOpHash)).toMatchObject({ ok: false, stage: "time", reason: "expired" });
    expect(await send(EP, account, "executeUserOp", [late.op, late.userOpHash])).toBe("mandate expired");
    // Revoked session key on a live mandate.
    const H = digest(0x900);
    expect(await register({ digest: H, parent: ZERO32, perAction: 10n, total: 100n, payees: [payees[0]], validUntil: FAR })).toBe("ok");
    const h = await addKey("H", H);
    const pre = await signed({ ...spend, mandateDigest: H }, h);
    expect(await send(owner, account, "revokeSessionKey", [h.address])).toBe("ok");
    expect(await submit(pre.op, pre.userOpHash)).toMatchObject({ ok: false, stage: "signature" });
    expect(await send(EP, account, "executeUserOp", [pre.op, pre.userOpHash])).toBe("session key");
    expect(await send(owner, account, "registerSessionKey", [h.address, H, 0, FAR])).toBe("session key");
  });

  it("caps the gas an op can make the account prepay, exactly at the boundary (H-1)", async () => {
    const GD = digest(0xa00), GD1 = digest(0xa10);
    const cap = 560_000n * 2_000_000_000n; // default op: (300k + 200k + 60k) gas at 2 gwei
    expect(await send(owner, account, "registerMandate", [GD, ZERO32, usd, 10n, 1000n, cap, 0, FAR, [payees[0]]])).toBe("ok");
    // A child may lower the cap but never raise it.
    expect(await send(owner, account, "registerMandate", [digest(0xa20), GD, usd, 10n, 100n, cap + 1n, 0, FAR, [payees[0]]])).toBe("not narrowed");
    expect(await send(owner, account, "registerMandate", [GD1, GD, usd, 10n, 100n, cap / 2n, 0, FAR, [payees[0]]])).toBe("ok");
    const k = await addKey("GD", GD), k1 = await addKey("GD1", GD1);
    const spend = { mandateDigest: GD, token: usd, payee: payees[0], amount: 1n };
    // Exactly at the cap: accepted and executed.
    let s = await signed(spend, k);
    expect(userOpGas(s.op).maxGasCost).toBe(cap);
    expect(await submit(s.op, s.userOpHash)).toEqual({ ok: true });
    // One more gas unit, or one more wei per gas, is refused, even though both signatures are valid.
    s = await signed(spend, k, { gas: { preVerificationGas: 60_001n } });
    expect(await submit(s.op, s.userOpHash)).toMatchObject({ ok: false, stage: "validation", reason: "gas cost cap" });
    s = await signed(spend, k, { gas: { maxFeePerGas: 2_000_000_001n } });
    expect(await submit(s.op, s.userOpHash)).toMatchObject({ ok: false, stage: "validation", reason: "gas cost cap" });
    // The reported attack: inflated preVerificationGas and fees so handleOps pays the attacker as beneficiary.
    s = await signed(spend, k, { gas: { preVerificationGas: 10_000_000n, maxFeePerGas: 500_000_000_000n } });
    expect(await submit(s.op, s.userOpHash)).toMatchObject({ ok: false, stage: "validation", reason: "gas cost cap" });
    await expect(reader.simulateContract({ address: account, abi: mandateAccountAbi, account: EP, functionName: "validateUserOp",
      args: [s.op, s.userOpHash, userOpGas(s.op).maxGasCost] })).rejects.toThrow(/gas cost cap/);
    // The child's tighter cap applies along the chain.
    s = await signed({ ...spend, mandateDigest: GD1 }, k1);
    expect(await submit(s.op, s.userOpHash)).toMatchObject({ ok: false, reason: "gas cost cap" });
    s = await signed({ ...spend, mandateDigest: GD1 }, k1, { gas: { maxFeePerGas: 1_000_000_000n } });
    expect(await submit(s.op, s.userOpHash)).toEqual({ ok: true });
    // Raising gas after co-signing changes the userOpHash, so the signatures no longer match.
    s = await signed(spend, k, { gas: { preVerificationGas: 50_000n } });
    const inflated = { ...s.op, preVerificationGas: 60_000n };
    expect(await submit(inflated, userOperationHash(inflated, EP, chainId))).toMatchObject({ ok: false, stage: "signature" });
    // The co-signed totalGasLimit and maxFeePerGas must equal the op's own values.
    const op = buildMandateUserOp({ ...spend, account, nonce: nonce++ });
    const h = userOperationHash(op, EP, chainId), until = (await now()) + 600, sess = await signSessionUserOp(k, h);
    for (const override of [{ totalGasLimit: 1n }, { maxFeePerGas: 1n }]) {
      const gk = await signGatekeeperDecision(gatekeeper, decisionFor(op, until, override));
      expect(await submit({ ...op, signature: encodeMandateSignature(until, sess, gk) }, h)).toMatchObject({ ok: false, stage: "signature" });
    }
    // Paymasters are not accepted (their gas limits would sit outside the cap).
    const pm = { ...op, paymasterAndData: `0x${"11".repeat(52)}` as Hex };
    expect(await submit(pm, userOperationHash(pm, EP, chainId))).toMatchObject({ ok: false, stage: "validation", reason: "paymaster" });
    // The contract's digest and type hash equal the client's.
    const d = decisionFor(op, until);
    expect(await reader.readContract({ address: account, abi: mandateAccountAbi, functionName: "gatekeeperDigest",
      args: [{ entryPoint: d.entryPoint, userOpHash: d.userOpHash, nonce: d.nonce, mandateDigest: d.mandateDigest, token: d.token, payee: d.payee,
        amount: d.amount, totalGasLimit: d.totalGasLimit, maxFeePerGas: d.maxFeePerGas, validUntil: d.validUntil }] })).toBe(gatekeeperDecisionDigest(d));
    expect(await reader.readContract({ address: account, abi: mandateAccountAbi, functionName: "GATEKEEPER_DECISION_TYPEHASH" }))
      .toBe(keccak256(toBytes(GATEKEEPER_DECISION_TYPE)));
  });

  it("refuses to deploy on a non-allowlisted chain, and the client refuses a mismatched RPC (M-1)", async () => {
    const port2 = 18923;
    const other = spawn(binary, ["--port", String(port2), "--chain-id", "10", "--silent"], { stdio: "ignore" });
    try {
      const reader2 = createPublicClient({ transport: http(`http://127.0.0.1:${port2}`) });
      const wallet2 = createWalletClient({ transport: http(`http://127.0.0.1:${port2}`) });
      let accounts: Address[] = [];
      for (let i = 0; i < 100 && accounts.length === 0; i++) {
        try { accounts = await wallet2.getAddresses(); } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      expect(await reader2.getChainId()).toBe(10);
      for (const [name, args] of [["MandateAccount", [EP, accounts[0], gatekeeper.address, accounts[1]]], ["TestStablecoin", ["T", "T", 6]]] as const) {
        const { abi, bytecode } = artifact(name);
        await expect(reader2.call({ account: accounts[0]!, data: encodeDeployData({ abi, bytecode, args }) })).rejects.toThrow(/testnet only/);
        const hash = await wallet2.deployContract({ account: accounts[0]!, chain: null, abi, bytecode, args, gas: 5_000_000n });
        const receipt = await reader2.waitForTransactionReceipt({ hash });
        expect(receipt.status).toBe("reverted");
      }
      await expect(assertRpcChain(reader2, chainId)).rejects.toThrow(/chain_id_mismatch/);
      await expect(assertRpcChain(reader2, 10)).rejects.toThrow(/chain_not_allowed/);
      const op = buildMandateUserOp({ mandateDigest: A1, token: usd, payee: payees[0], amount: 1n, account, nonce: nonce++ });
      await expect(signMandateUserOp({ op, chainId, client: reader2, decisionValidUntil: (await now()) + 60, session: sessionKeys.get("A1")!.key, gatekeeper }))
        .rejects.toThrow(/chain_id_mismatch/);
      await expect(assertRpcChain(reader, chainId)).resolves.toBeUndefined();
    } finally { other.kill(); }
  });

  it("returns SIG_VALIDATION_FAILED for malformed or mis-bound signatures, after the policy checks (L-1, L-4)", async () => {
    const L = digest(0xb00);
    expect(await register({ digest: L, parent: ZERO32, perAction: 10n, total: 100n, payees: [payees[0]], validUntil: FAR })).toBe("ok");
    const k = await addKey("L", L);
    const spend = { mandateDigest: L, token: usd, payee: payees[0], amount: 1n };
    const s = await signed(spend, k);
    const [until, sess, gk] = decodeAbiParameters([{ type: "uint48" }, { type: "bytes" }, { type: "bytes" }], s.op.signature);
    const setWord = (sig: Hex, i: number, v: bigint) =>
      `0x${sig.slice(2, 2 + i * 64)}${pad(toHex(v), { size: 32 }).slice(2)}${sig.slice(2 + (i + 1) * 64)}` as Hex;
    const highS = (sig: Hex) => {
      const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const sv = BigInt(`0x${sig.slice(66, 130)}`), v = parseInt(sig.slice(130), 16);
      return `${sig.slice(0, 66)}${(n - sv).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    };
    const otherEp = await signGatekeeperDecision(gatekeeper, decisionFor(s.op, until, { entryPoint: stranger }));
    const cases: Record<string, Hex> = {
      empty: "0x",
      short: "0x1234",
      truncatedHeader: s.op.signature.slice(0, 2 + 95 * 2) as Hex,
      truncatedTail: s.op.signature.slice(0, -64) as Hex, // cuts into the Gatekeeper signature bytes
      offsetHuge: setWord(s.op.signature, 1, 2n ** 255n),
      offsetIntoHeader: setWord(s.op.signature, 1, 0n),
      lengthHuge: setWord(s.op.signature, 3, 2n ** 64n),
      dirtyUint48: setWord(s.op.signature, 0, 2n ** 48n + BigInt(until)),
      zeroExpiry: encodeMandateSignature(0, sess, gk),
      gatekeeperHighS: encodeMandateSignature(until, sess, highS(gk)),
      gatekeeperShort: encodeMandateSignature(until, sess, gk.slice(0, -2) as Hex),
      gatekeeperLong: encodeMandateSignature(until, sess, `${gk}00`),
      gatekeeperOtherEntryPoint: encodeMandateSignature(until, sess, otherEp),
      sessionShort: encodeMandateSignature(until, sess.slice(0, 130) as Hex, gk),
      swapped: encodeMandateSignature(until, gk, sess),
    };
    for (const [name, signature] of Object.entries(cases)) {
      expect(await validate({ ...s.op, signature }, s.userOpHash), name).toBe(1n);
      expect(await send(EP, account, "executeUserOp", [{ ...s.op, signature }, s.userOpHash]), name).not.toBe("ok");
    }
    // Policy is checked whether or not the signatures are valid, so a garbage signature does not short-circuit it.
    const bad = await signed({ ...spend, payee: payees[1] }, k);
    expect(await submit({ ...bad.op, signature: "0x" }, bad.userOpHash)).toMatchObject({ ok: false, stage: "validation", reason: "payee not allowed" });
    // An account bound to another entry point refuses ours.
    const elsewhere = await deploy("MandateAccount", [stranger, owner, gatekeeper.address, guardian]);
    expect(await submit({ ...s.op, sender: elsewhere }, s.userOpHash)).toMatchObject({ ok: false, reason: "not entry point" });
    // The untouched op still works.
    expect(await submit(s.op, s.userOpHash)).toEqual({ ok: true });
  });

  it("keeps roles disjoint and transfers ownership in two steps (L-2)", async () => {
    const keyA = sessionKeys.get("A")!.key.address, revoked = sessionKeys.get("X")!.key.address;
    for (const who of [keyA, guardian, owner]) expect(await send(owner, account2, "setGatekeeper", [who])).toBe("role overlap");
    expect(await send(owner, account, "setGatekeeper", [revoked])).toBe("role overlap"); // revoked keys stay excluded
    for (const who of [keyA, gatekeeper.address]) expect(await send(owner, account2, "setGuardian", [who])).toBe("role overlap");
    const fresh = privateKeyToAccount(generatePrivateKey()).address;
    expect(await send(guardian, account2, "setGatekeeper", [fresh])).toBe("not owner");
    expect(await send(owner, account2, "setGatekeeper", [fresh])).toBe("ok");
    expect(await send(owner, account2, "setGatekeeper", [gatekeeper.address])).toBe("ok");
    const read = (fn: "owner" | "pendingOwner") => reader.readContract({ address: account2, abi: mandateAccountAbi, functionName: fn });
    expect(await send(stranger, account2, "proposeOwner", [stranger])).toBe("not owner");
    expect(await send(owner, account2, "proposeOwner", [stranger])).toBe("ok");
    expect(await read("owner")).toBe(owner);
    expect(await send(owner, account2, "registerSessionKey", [stranger, A, 0, FAR])).toBe("session key");
    expect(await send(guardian, account2, "acceptOwner", [])).toBe("not pending owner");
    expect(await send(stranger, account2, "acceptOwner", [])).toBe("ok");
    expect([await read("owner"), await read("pendingOwner")]).toEqual([stranger, "0x0000000000000000000000000000000000000000"]);
    expect(await send(owner, account2, "unpause", [])).toBe("not owner");
    expect(await send(stranger, account2, "proposeOwner", [guardian])).toBe("ok");
    expect(await send(guardian, account2, "acceptOwner", [])).toBe("role overlap");
    expect(await send(stranger, account2, "proposeOwner", [owner])).toBe("ok");
    expect(await send(owner, account2, "acceptOwner", [])).toBe("ok");
    expect(await read("owner")).toBe(owner);
  });

  it("enforces session-key and mandate validity windows at exact boundaries (L-4)", async () => {
    const spendOn = (d: Hex) => ({ mandateDigest: d, token: usd, payee: payees[0], amount: 1n });
    // Session-key window inside a wider mandate window.
    const base = (await now()) + 1000, W = digest(0xc00);
    expect(await send(owner, account, "registerMandate", [W, ZERO32, usd, 10n, 1000n, GAS_CAP, base, FAR, [payees[0]]])).toBe("ok");
    const key = privateKeyToAccount(generatePrivateKey());
    expect(await send(owner, account, "registerSessionKey", [key.address, W, base + 100, base + 200])).toBe("ok");
    let s = await signed(spendOn(W), key, { ttl: 100_000 });
    expect(decodeValidationData(await validate(s.op, s.userOpHash))).toMatchObject({ sigFailed: false, validAfter: base + 100, validUntil: base + 200 });
    for (const [t, status] of [[base + 99, "reverted"], [base + 100, "success"], [base + 200, "success"], [base + 201, "reverted"]] as const) {
      s = await signed(spendOn(W), key, { ttl: 100_000 });
      expect(await mine(EP, account, "executeUserOp", [s.op, s.userOpHash], t), `key window at ${t - base}`).toBe(status);
    }
    // Mandate window (validAfter and validUntil) with a wide session key.
    const base2 = (await now()) + 1000, M = digest(0xc10);
    expect(await send(owner, account, "registerMandate", [M, ZERO32, usd, 10n, 1000n, GAS_CAP, base2, base2 + 50, [payees[0]]])).toBe("ok");
    const key2 = privateKeyToAccount(generatePrivateKey());
    expect(await send(owner, account, "registerSessionKey", [key2.address, M, 0, FAR])).toBe("ok");
    s = await signed(spendOn(M), key2, { ttl: 100_000 });
    expect(decodeValidationData(await validate(s.op, s.userOpHash))).toMatchObject({ sigFailed: false, validAfter: base2, validUntil: base2 + 50 });
    for (const [t, status] of [[base2 - 1, "reverted"], [base2, "success"], [base2 + 50, "success"], [base2 + 51, "reverted"]] as const) {
      s = await signed(spendOn(M), key2, { ttl: 100_000 });
      expect(await mine(EP, account, "executeUserOp", [s.op, s.userOpHash], t), `mandate window at ${t - base2}`).toBe(status);
    }
    expect(await spentOf(account, W)).toBe(2n);
    expect(await spentOf(account, M)).toBe(2n);
  });

  it("does not let two ops validated in one bundle both spend the last of a budget (L-4)", async () => {
    const DB = digest(0xd00);
    expect(await register({ digest: DB, parent: ZERO32, perAction: 10n, total: 10n, payees: [payees[0]], validUntil: FAR })).toBe("ok");
    const k = await addKey("DB", DB);
    const one = await signed({ mandateDigest: DB, token: usd, payee: payees[0], amount: 6n }, k);
    const two = await signed({ mandateDigest: DB, token: usd, payee: payees[0], amount: 6n }, k);
    // EntryPoint v0.7 runs every validateUserOp of a bundle before any execution: both pass validation.
    for (const x of [one, two]) {
      expect(decodeValidationData(await validate(x.op, x.userOpHash)).sigFailed).toBe(false);
      expect(await mine(EP, account, "validateUserOp", [x.op, x.userOpHash, 0n])).toBe("success");
    }
    expect(await send(EP, account, "executeUserOp", [one.op, one.userOpHash])).toBe("ok");
    expect(await send(EP, account, "executeUserOp", [two.op, two.userOpHash])).toBe("aggregate cap");
    expect(await spentOf(account, DB)).toBe(6n);
  });

  it.runIf(!!process.env.CI)("has anvil available in CI", () => expect(available).toBe(true));
});
