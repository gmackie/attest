import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { deriveSignerPublicKey } from "@pcd/pod";
import {
  createPublicClient, createWalletClient, http, parseEther,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  attestClaimsAbi, attestTokenAbi, attestPassportAbi,
  publicPodCommitment, readPublicClaimSnapshot, entitlementNullifier,
} from "../src/economy";
import {
  issueConversionClaim, preparePrivateConversion, authorizePrivateConversion,
  type ConversionIntent, type ConversionPolicy, type ConversionVerifierPorts,
  CONVERSION_CLAIM_SCHEMA,
} from "../../demo/src/conversion";

const binary = process.env.ANVIL_BIN ?? path.join(homedir(), ".foundry/bin/anvil");
const root = path.resolve(import.meta.dirname, "../../..");
const port = 18745;
const url = `http://127.0.0.1:${port}`;
const reader = createPublicClient({ chain: sepolia, transport: http(url) });
const wallet = createWalletClient({ chain: sepolia, transport: http(url) });
const hex = (v: string) => `0x${v.repeat(64)}` as Hex;
const proofArtifacts = path.join(root, "packages/proofs/node_modules/@pcd/proto-pod-gpc-artifacts");
const issuerPodKey = "2".repeat(64);
const holderPodKey = "3".repeat(64);
const authorizerKey = hex("a");
const authorizer = privateKeyToAccount(authorizerKey);
let anvil: ChildProcess;
let accounts: Address[] = [];
let token: Address, claimContract: Address, passport: Address;
let contractArtifacts: Record<string,{ abi: any; bytecode: Hex }> = {};

beforeAll(async () => {
  if (!existsSync(binary)) return;
  const compiled = spawnSync(process.execPath, ["scripts/compile.mjs"], {
    cwd: path.join(root, "contracts"), encoding: "utf8",
  });
  if (compiled.status !== 0) throw Error(compiled.stderr || compiled.stdout);
  for (const name of ["AttestToken", "AttestClaims", "AttestPassport"]) {
    contractArtifacts[name] = JSON.parse(readFileSync(path.join(root,"contracts/artifacts", `${name}.json`),"utf8"));
  }
  anvil = spawn(binary, ["--port", String(port), "--chain-id", "11155111", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 60; ++i) {
    try { accounts = await wallet.getAddresses(); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  if (accounts.length < 4) throw Error("Anvil failed to start");
  const deploy = async (name: string, args: readonly unknown[] = []) => {
    const artifact = contractArtifacts[name]!;
    const tx = await wallet.deployContract({
      account: accounts[0]!, abi: artifact.abi, bytecode: artifact.bytecode, args: args as never,
    });
    const receipt = await reader.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success" || !receipt.contractAddress) throw Error(name+" deployment failed");
    return receipt.contractAddress;
  };
  token = await deploy("AttestToken", [authorizer.address, parseEther("1000")]);
  claimContract = await deploy("AttestClaims");
  passport = await deploy("AttestPassport",[token]);
}, 60_000);
afterAll(() => { anvil?.kill(); });

it.skipIf(!existsSync(binary))("converts a privately-proven anchored claim into real Anvil $ATTEST once, and updates the passport", async () => {
  const administrator = accounts[0]!, issuerEvm = accounts[1]!, holderEvm = accounts[2]!, relayer = accounts[3]!;
  const expiry = BigInt(Math.floor(Date.now()/1000) + 3600);
  const policy: ConversionPolicy = {
    id: hex("1"), scope: hex("2"), schema: CONVERSION_CLAIM_SCHEMA,
    minimumScore: 700, mintAmount: parseEther("200"), palette: [4000,3000,2000,1000],
  };
  const write = async (account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[] = []) => {
    const simulated = await reader.simulateContract({
      account, address, abi, functionName, args: args as never,
    });
    const hash = await wallet.writeContract(simulated.request);
    const receipt = await reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw Error("Unexpected reverted receipt");
    return receipt;
  };
  await write(administrator, token, attestTokenAbi, "configurePolicy", [policy.id, parseEther("500"), true]);
  await write(administrator, claimContract, attestClaimsAbi, "configureIssuer", [issuerEvm,true]);
  const claim = issueConversionClaim({
    id: "engagement:synthetic-unique-8729",
    subject: "fictional:factory-operator",
    holderPublicKey: deriveSignerPublicKey(holderPodKey),
    eventCommitment: hex("e"),
    score: 880,
    validThrough: new Date((Number(expiry)+86400)*1000).toISOString().slice(0,10),
  },issuerPodKey);
  // On-chain public NFT is optional; in this integration test holder explicitly opts in.
  await write(issuerEvm, claimContract, attestClaimsAbi, "issue",[
    holderEvm, publicPodCommitment(claim.contentID),policy.scope, expiry + 86400n,
  ]);
  const onchain = await readPublicClaimSnapshot(reader, claimContract, 1n,{
    holder: holderEvm, issuer: issuerEvm, scope: policy.scope, contentID: claim.contentID,
  },"latest");
  expect(onchain.active).toBe(true);
  const intent: ConversionIntent = {
    kind: "AttestConversionIntent",version:1,chainId:11155111,
    token,recipient:holderEvm,policyId:policy.id,
    id:claim.id,contentID:claim.contentID,eventCommitment:claim.eventCommitment,
    subject:claim.subject,holderPublicKey:claim.holderPublicKey,
    issuerAccount:issuerEvm,issuerPublicKey:claim.issuerPublicKey,
    expiresAt:Number(expiry),
  };
  const ports: ConversionVerifierPorts = {
    nowMs: () => Date.now(),
    readCredential: async () => {
      const proof = await readPublicClaimSnapshot(reader,claimContract,1n,{
        holder:holderEvm,issuer:issuerEvm,scope:policy.scope,contentID:claim.contentID,
      },"latest");
      return {
        id:claim.id,contentID:claim.contentID,subject:claim.subject,
        holderPublicKey:claim.holderPublicKey,issuerAccount:proof.issuerAccount,
        issuerPublicKey:claim.issuerPublicKey,scope:policy.scope,
        active:true,observedAtMs:proof.observedAtMs,
        validUntilSeconds:proof.validUntilSeconds,
      };
    },
    acceptedIssuer: async (issuer,issuerPublicKey,scope) => {
      const enrolled = await reader.readContract({
        address:claimContract,abi:contractArtifacts.AttestClaims!.abi,
        functionName:"issuers",args:[issuer],
      }) as boolean;
      return enrolled && issuer.toLowerCase()===issuerEvm.toLowerCase() &&
        issuerPublicKey===claim.issuerPublicKey && scope===policy.scope;
    },
    isAlreadySpent: async nullifier => reader.readContract({
      address:token,abi:attestTokenAbi,functionName:"spentNullifiers",args:[nullifier],
    }),
  };
  const privateProof = await preparePrivateConversion(claim,intent,policy,holderPodKey,proofArtifacts);
  // Changing recipient cannot redirect the already proven holder's consent.
  await expect(authorizePrivateConversion(privateProof,{...intent,recipient:relayer},policy,ports,authorizerKey,proofArtifacts)).rejects.toThrow();
  const { voucher, signature } = await authorizePrivateConversion(privateProof,intent,policy,ports,authorizerKey,proofArtifacts);
  expect(voucher.amount).toBe(parseEther("200"));
  expect(voucher.nullifier).toBe(entitlementNullifier(claim.eventCommitment));
  await write(relayer,token,attestTokenAbi,"mintWithAuthorization",[voucher,signature]);
  expect(await reader.readContract({
    address:token,abi:attestTokenAbi,functionName:"balanceOf",args:[holderEvm],
  })).toBe(parseEther("200"));
  await expect(write(relayer,token,attestTokenAbi,"mintWithAuthorization",[voucher,signature])).rejects.toThrow();
  await expect(authorizePrivateConversion(privateProof,intent,policy,ports,authorizerKey,proofArtifacts)).rejects.toThrow(/already redeemed/);
  await write(holderEvm,passport,attestPassportAbi,"claim");
  const id = await reader.readContract({address:passport,abi:attestPassportAbi,functionName:"passportId",args:[holderEvm]}) as bigint;
  const firstUri = await reader.readContract({address:passport,abi:attestPassportAbi,functionName:"tokenURI",args:[id]}) as string;
  const firstMeta = JSON.parse(Buffer.from(firstUri.split(",")[1]!,"base64").toString("utf8"));
  expect(Buffer.from(firstMeta.image.split(",")[1]!,"base64").toString("utf8")).toContain("200 ATTEST");
  await write(holderEvm,token,attestTokenAbi,"transfer",[relayer,parseEther("60")]);
  const nextUri = await reader.readContract({address:passport,abi:attestPassportAbi,functionName:"tokenURI",args:[id]}) as string;
  const nextMeta = JSON.parse(Buffer.from(nextUri.split(",")[1]!,"base64").toString("utf8"));
  expect(Buffer.from(nextMeta.image.split(",")[1]!,"base64").toString("utf8")).toContain("140 ATTEST");
  // An issuer revocation blocks future proof conversion but cannot claw back issued tokens.
  await write(issuerEvm,claimContract,attestClaimsAbi,"revoke",[1n]);
  await expect(readPublicClaimSnapshot(reader,claimContract,1n,{
    holder:holderEvm,issuer:issuerEvm,scope:policy.scope,contentID:claim.contentID,
  },"latest")).rejects.toThrow(/revoked/);
},180_000);
