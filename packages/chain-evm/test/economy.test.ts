import { expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import {
  createPublicClient, createWalletClient, http, parseEther, stringToHex,
  keccak256, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  entitlementNullifier, packPalette, unpackPalette,
  provenanceCommitment, signConversionVoucher,
  assertPrototypeNetwork, type ConversionVoucher,
} from "../src/economy";

const hash = (character: string) => `0x${character.repeat(64)}` as Hex;
const signerKey = `0x${"a".repeat(64)}` as Hex;
const authorizer = privateKeyToAccount(signerKey);
const policyId = hash("1");
const port = 18672;
const url = `http://127.0.0.1:${port}`;
const binary = process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const reader = createPublicClient({ chain: sepolia, transport: http(url) });
const wallet = createWalletClient({ chain: sepolia, transport: http(url) });
let anvil: ChildProcess;
let accounts: Address[] = [];
let token: Address;
let claims: Address;
let passport: Address;
let artifacts: Record<string, { abi: any; bytecode: Hex }> = {};

it("packs four provenance components and preserves a policy-independent entitlement nullifier", () => {
  const palette = [4000, 3000, 2000, 1000] as const;
  expect(unpackPalette(packPalette(palette))).toEqual(palette);
  expect(() => packPalette([10000, 1, 0, 0])).toThrow();
  expect(entitlementNullifier(hash("a"))).toBe(entitlementNullifier(hash("a")));
  expect(entitlementNullifier(hash("a"))).not.toBe(entitlementNullifier(hash("b")));
  expect(provenanceCommitment(hash("a"), hash("1"))).not.toBe(provenanceCommitment(hash("a"), hash("2")));
  expect(() => assertPrototypeNetwork(1)).toThrow(/Sepolia/);
  expect(() => assertPrototypeNetwork(11155111)).not.toThrow();
});

beforeAll(async () => {
  if (!existsSync(binary)) return;
  const root = path.resolve(import.meta.dirname, "../../..");
  const compiled = spawnSync(process.execPath, ["scripts/compile.mjs"], {
    cwd: path.join(root, "contracts"), encoding: "utf8",
  });
  if (compiled.status !== 0) throw new Error(compiled.stderr || compiled.stdout);
  for (const name of ["AttestToken", "AttestClaims", "AttestPassport"]) {
    artifacts[name] = JSON.parse(readFileSync(path.join(root, "contracts/artifacts", `${name}.json`), "utf8"));
  }
  anvil = spawn(binary, ["--port", String(port), "--chain-id", "11155111", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 60; ++i) {
    try { accounts = await wallet.getAddresses(); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (accounts.length < 4) throw new Error("Anvil did not start");
  async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
    const artifact = artifacts[name]!;
    const tx = await wallet.deployContract({
      account: accounts[0]!, abi: artifact.abi, bytecode: artifact.bytecode,
      args: args as never,
    });
    const receipt = await reader.waitForTransactionReceipt({ hash: tx });
    if (!receipt.contractAddress) throw new Error(`Missing ${name} address`);
    return receipt.contractAddress;
  }
  token = await deploy("AttestToken", [authorizer.address, parseEther("1000")]);
  claims = await deploy("AttestClaims");
  passport = await deploy("AttestPassport", [token]);
}, 60_000);
afterAll(() => { anvil?.kill(); });

it.skipIf(!existsSync(binary))("enforces signed proof-verifier vouchers, supply caps and exactly-once minting", async () => {
  const a = accounts[1]!, b = accounts[2]!, stranger = accounts[3]!;
  const artifact = artifacts.AttestToken!;
  const write = async (account: Address, functionName: string, args: readonly unknown[]) => {
    const simulated = await reader.simulateContract({
      address: token, abi: artifact.abi, functionName,
      args: args as never, account,
    });
    const tx = await wallet.writeContract(simulated.request);
    const receipt = await reader.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") throw new Error("Transaction reverted");
    return receipt;
  };
  const make = (nullifier: Hex, recipient = a): ConversionVoucher => ({
    policyId, nullifier, proofCommitment: hash("b"), provenanceCommitment: hash("c"),
    recipient, amount: parseEther("100"),
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 900),
    palette: packPalette([4000, 3000, 2000, 1000]),
  });
  const sign = (v: ConversionVoucher) => signConversionVoucher(signerKey, token, v);
  await expect(write(stranger, "configurePolicy", [policyId, parseEther("500"), true])).rejects.toThrow();
  await write(accounts[0]!, "configurePolicy", [policyId, parseEther("300"), true]);
  const voucher = make(hash("4"));
  const signature = await sign(voucher);
  await expect(write(stranger, "mintWithAuthorization", [{ ...voucher, recipient: b }, signature])).rejects.toThrow();
  await expect(write(stranger, "mintWithAuthorization", [{ ...voucher, amount: parseEther("999") }, signature])).rejects.toThrow();
  await expect(write(stranger, "mintWithAuthorization", [{ ...voucher, palette: 0n }, signature])).rejects.toThrow();
  await write(stranger, "mintWithAuthorization", [voucher, signature]);
  expect(await reader.readContract({ address: token, abi: artifact.abi, functionName: "balanceOf", args: [a] })).toBe(parseEther("100"));
  expect(await reader.readContract({ address: token, abi: artifact.abi, functionName: "spentNullifiers", args: [voucher.nullifier] })).toBe(true);
  await expect(write(stranger, "mintWithAuthorization", [voucher, signature])).rejects.toThrow();
  const badDomain = await signConversionVoucher(signerKey, b, make(hash("5")));
  await expect(write(stranger, "mintWithAuthorization", [make(hash("5")), badDomain])).rejects.toThrow();
  const badChainVoucher = make(hash("6"));
  const { conversionDomain, conversionTypes } = await import("../src/economy");
  const badChain = await authorizer.signTypedData({
    domain: conversionDomain(token, 1), types: conversionTypes,
    primaryType: "Conversion", message: badChainVoucher,
  });
  await expect(write(stranger, "mintWithAuthorization", [badChainVoucher, badChain])).rejects.toThrow();
  const expired = { ...make(hash("7")), expiresAt: BigInt(Math.floor(Date.now() / 1000) - 1) };
  await expect(write(stranger, "mintWithAuthorization", [expired, await sign(expired)])).rejects.toThrow();
  const unknownPolicy = { ...make(hash("8")), policyId: hash("9") };
  await expect(write(stranger, "mintWithAuthorization", [unknownPolicy, await sign(unknownPolicy)])).rejects.toThrow();

  // A second mint with a different palette, then mix portions through ERC-20 transfer.
  const second = { ...make(hash("a"), b), palette: packPalette([0, 10000, 0, 0]) };
  const secondSignature = await sign(second);
  await expect(write(stranger, "setMintingPaused", [true])).rejects.toThrow();
  await write(accounts[0]!, "setMintingPaused", [true]);
  expect(await reader.readContract({ address: token, abi: artifact.abi, functionName: "mintingPaused" })).toBe(true);
  await expect(write(stranger, "mintWithAuthorization", [second, secondSignature])).rejects.toThrow();
  expect(await reader.readContract({ address: token, abi: artifact.abi, functionName: "spentNullifiers", args: [second.nullifier] })).toBe(false);
  await write(accounts[0]!, "setMintingPaused", [false]);
  await write(stranger, "mintWithAuthorization", [second, secondSignature]);
  const before = await reader.readContract({ address: token, abi: artifact.abi, functionName: "compositionOf", args: [a] }) as bigint[];
  expect(before.reduce((x, y) => x + y, 0n)).toBe(parseEther("100"));
  await write(a, "transfer", [b, parseEther("40")]);
  const firstRemainder = await reader.readContract({ address: token, abi: artifact.abi, functionName: "compositionOf", args: [a] }) as bigint[];
  const secondTotal = await reader.readContract({ address: token, abi: artifact.abi, functionName: "compositionOf", args: [b] }) as bigint[];
  expect(firstRemainder.reduce((x, y) => x + y, 0n)).toBe(parseEther("60"));
  expect(secondTotal.reduce((x, y) => x + y, 0n)).toBe(parseEther("140"));
  expect(secondTotal[0]).toBe(parseEther("16"));
  expect(secondTotal[1]).toBe(parseEther("112"));
  await write(a, "approve", [stranger, parseEther("10")]);
  await write(stranger, "transferFrom", [a, b, parseEther("10")]);
  expect(await reader.readContract({ address: token, abi: artifact.abi, functionName: "balanceOf", args: [a] })).toBe(parseEther("50"));
  await expect(write(stranger, "transferFrom", [a, b, parseEther("1")])).rejects.toThrow();

  // Remaining policy cap is 100; exceeding it is impossible even with the right signer.
  const excessive = { ...make(hash("d")), amount: parseEther("101") };
  await expect(write(stranger, "mintWithAuthorization", [excessive, await sign(excessive)])).rejects.toThrow();
}, 90_000);

it.skipIf(!existsSync(binary))("provides non-transferable claim NFTs and live balance artwork", async () => {
  const a = accounts[1]!, b = accounts[2]!;
  const claimAbi = artifacts.AttestClaims!.abi;
  const passportAbi = artifacts.AttestPassport!.abi;
  const write = async (address: Address, abi: any, account: Address, functionName: string, args: readonly unknown[] = []) => {
    const sim = await reader.simulateContract({ address, abi, account, functionName, args: args as never });
    const tx = await wallet.writeContract(sim.request);
    const receipt = await reader.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") throw new Error("Transaction reverted");
    return receipt;
  };
  await expect(write(claims, claimAbi, a, "issue", [a, hash("2"), hash("3"), BigInt(Math.floor(Date.now()/1000)+86400)])).rejects.toThrow();
  await write(claims, claimAbi, accounts[0]!, "configureIssuer", [b, true]);
  await write(claims, claimAbi, b, "issue", [a, hash("2"), hash("3"), BigInt(Math.floor(Date.now()/1000)+86400)]);
  expect(await reader.readContract({ address: claims, abi: claimAbi, functionName: "ownerOf", args: [1n] })).toBe(a);
  expect(await reader.readContract({ address: claims, abi: claimAbi, functionName: "locked", args: [1n] })).toBe(true);
  const activeClaimUri = await reader.readContract({ address: claims, abi: claimAbi, functionName: "tokenURI", args: [1n] }) as string;
  const activeClaimJson = JSON.parse(Buffer.from(activeClaimUri.split(",")[1]!, "base64").toString("utf8"));
  expect(activeClaimJson.name).toContain("Public Claim");
  expect(Buffer.from(activeClaimJson.image.split(",")[1]!, "base64").toString("utf8")).toContain("ACTIVE / PUBLIC COMMITMENT");
  await expect(write(claims, claimAbi, a, "transferFrom", [a, b, 1n])).rejects.toThrow();
  await expect(write(claims, claimAbi, b, "issue", [a, hash("2"), hash("3"), BigInt(Math.floor(Date.now()/1000)+86400)])).rejects.toThrow();
  await expect(write(claims, claimAbi, a, "revoke", [1n])).rejects.toThrow();
  await write(claims, claimAbi, b, "revoke", [1n]);
  expect(await reader.readContract({ address: claims, abi: claimAbi, functionName: "isActive", args: [1n] })).toBe(false);
  const revokedUri = await reader.readContract({ address: claims, abi: claimAbi, functionName: "tokenURI", args: [1n] }) as string;
  const revokedJson = JSON.parse(Buffer.from(revokedUri.split(",")[1]!, "base64").toString("utf8"));
  expect(Buffer.from(revokedJson.image.split(",")[1]!, "base64").toString("utf8")).toContain("INACTIVE / PUBLIC COMMITMENT");
  await expect(write(claims, claimAbi, b, "revoke", [1n])).rejects.toThrow();

  await write(passport, passportAbi, a, "claim");
  const id = await reader.readContract({ address: passport, abi: passportAbi, functionName: "passportId", args: [a] }) as bigint;
  const uri = await reader.readContract({ address: passport, abi: passportAbi, functionName: "tokenURI", args: [id] }) as string;
  const meta = JSON.parse(Buffer.from(uri.split(",")[1]!, "base64").toString("utf8"));
  expect(meta.name).toContain("Economic Passport");
  const svg = Buffer.from(meta.image.split(",")[1]!, "base64").toString("utf8");
  const currentBalance = await reader.readContract({ address: token, abi: artifacts.AttestToken!.abi, functionName: "balanceOf", args: [a] }) as bigint;
  expect(svg).toContain(`${currentBalance / 10n ** 18n} ATTEST`);
  expect(svg).toContain("#40a9db");
  await expect(write(passport, passportAbi, a, "transferFrom", [a, b, id])).rejects.toThrow();
  await expect(write(passport, passportAbi, a, "claim")).rejects.toThrow();
  await write(passport, passportAbi, b, "refresh", [a]);
}, 90_000);
