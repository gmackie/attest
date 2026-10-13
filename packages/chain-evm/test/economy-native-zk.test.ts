import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import {
  createPublicClient, createWalletClient, http, parseEther, toHex,
  type Address, type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import {
  attestTokenAbi, privateClaimRootsAbi, zkAttestMinterAbi,
} from "../src/economy";

const root = path.resolve(import.meta.dirname, "../../..");
const generated = path.join(root,"zk/.generated");
const toolPath = process.env.ATTEST_ZK_TOOLS ?? "/tmp/attest-zk-toolchain";
const binary = process.env.ANVIL_BIN ?? path.join(homedir(),".foundry/bin/anvil");
const port=18875, url=`http://127.0.0.1:${port}`;
const reader=createPublicClient({chain:sepolia,transport:http(url)});
const wallet=createWalletClient({chain:sepolia,transport:http(url)});
const available=existsSync(path.join(generated,"Groth16Verifier.json")) &&
  existsSync(path.join(generated,"final.zkey")) && existsSync(binary);

let anvil: ChildProcess;
let accounts: Address[] = [];
let token: Address, roots: Address, minter: Address, verifier: Address;
const manifest: Record<string, {abi:any;bytecode: Hex}> = {};
function artifact(name:string) {
  const file=name==="Groth16Verifier"
    ? path.join(generated, name+".json")
    : path.join(root,"contracts/artifacts",name+".json");
  return JSON.parse(readFileSync(file,"utf8")) as {abi:any;bytecode:Hex};
}
function snark(args:string[]) {
  const executable=path.join(toolPath,"node_modules/.bin/snarkjs");
  const p=spawnSync(executable,args,{cwd:root,encoding:"utf8",timeout:180_000,maxBuffer:2*1024*1024});
  if(p.status!==0)throw new Error("snarkjs failed: "+p.stderr+" "+p.stdout);
  return p.stdout.trim();
}
async function transaction(address:Address,abi:any,account:Address,fn:string,args: readonly unknown[]=[]) {
  const sim=await reader.simulateContract({address,abi,account,functionName:fn,args:args as never});
  const hash=await wallet.writeContract(sim.request);
  const result=await reader.waitForTransactionReceipt({hash});
  if(result.status!=="success")throw new Error("On-chain transaction reverted");
  return result;
}
beforeAll(async()=>{
  if(!available)return;
  const require = createRequire(path.join(toolPath,"package.json"));
  const {buildPoseidon}=require("circomlibjs");
  poseidon=await buildPoseidon();
  anvil=spawn(binary,["--port",String(port),"--chain-id","11155111","--silent"],{stdio:"ignore"});
  for(let i=0;i<100;i++){
    try{accounts=await wallet.getAddresses();break}
    catch{await new Promise(r=>setTimeout(r,100))}
  }
  if(accounts.length<4)throw new Error("Anvil unavailable");
  for(const name of ["Groth16Verifier","AttestToken","PrivateClaimRoots","ZkAttestMinterV1"]){
    manifest[name]=artifact(name);
  }
  const deploy=async(name:string,args: readonly unknown[]=[])=>{
    const d=manifest[name]!;
    const hash=await wallet.deployContract({abi:d.abi,bytecode:d.bytecode,args:args as never,account:accounts[0]!});
    const receipt=await reader.waitForTransactionReceipt({hash});
    if(receipt.status!=="success"||!receipt.contractAddress)throw new Error("Deploy failed: "+name);
    return receipt.contractAddress;
  };
  verifier=await deploy("Groth16Verifier");
  token=await deploy("AttestToken",[accounts[0]!,parseEther("1000")]);
  roots=await deploy("PrivateClaimRoots");
  minter=await deploy("ZkAttestMinterV1",[token,roots,verifier]);
  await transaction(token,attestTokenAbi,accounts[0]!,"setZkMinter",[minter]);
  await transaction(token,attestTokenAbi,accounts[0]!,"configurePolicy",[toHex(1,{size:32}),parseEther("600"),true]);
  await transaction(roots,privateClaimRootsAbi,accounts[0]!,"configureIssuer",[accounts[1]!,true]);
},120_000);
afterAll(()=>{anvil?.kill()});

let poseidon: any;
const phash=(inputs:bigint[]):bigint=>BigInt(poseidon.F.toString(poseidon(inputs)));
type ProofData = {
  a: readonly [bigint,bigint];
  b: readonly [readonly [bigint,bigint],readonly [bigint,bigint]];
  c: readonly [bigint,bigint];
  signals: readonly bigint[];
  commitmentRoot:bigint;
};
async function makeProof(eventSecret:bigint,holderSecret:bigint,score:bigint):Promise<ProofData>{
  const issuer=BigInt(accounts[1]!);
  const recipient=BigInt(accounts[2]!);
  const timestamp=(await reader.getBlock()).timestamp;
  const expiry=timestamp+600n;
  const validUntil=timestamp+86400n;
  const siblings=[11n,22n,33n,44n],directions=[0n,1n,0n,1n];
  const leaf=phash([eventSecret,holderSecret,score,validUntil,issuer,recipient]);
  let level=leaf;
  for(let i=0;i<4;i++){
    level=directions[i]===0n?phash([level,siblings[i]!]):phash([siblings[i]!,level]);
  }
  const nullifier=phash([eventSecret,81501n]);
  const provenance=phash([eventSecret,81502n]);
  const input={
    issuer:String(issuer),root:String(level),nullifier:String(nullifier),
    recipient:String(recipient),token:String(BigInt(token)),
    chainId:"11155111",expiresAt:String(expiry),
    amount:String(parseEther("200")),palette:"1125912791875585000",
    policyId:"1",provenance:String(provenance),
    eventSecret:String(eventSecret),holderSecret:String(holderSecret),score:String(score),
    validUntil:String(validUntil),
    siblings:siblings.map(String),directions:directions.map(String),
  };
  const name="conversion-"+eventSecret.toString();
  const inputPath=path.join(generated,name+"-input.json");
  const proofPath=path.join(generated,name+"-proof.json");
  const publicPath=path.join(generated,name+"-public.json");
  writeFileSync(inputPath,JSON.stringify(input));
  snark(["groth16","fullprove",inputPath,
    path.join(generated,"private-conversion-v1_js/private-conversion-v1.wasm"),
    path.join(generated,"final.zkey"),proofPath,publicPath]);
  const response=snark(["groth16","verify",path.join(generated,"verification_key.json"),publicPath,proofPath]);
  if(!response.includes("OK"))throw Error("Off-chain verifier did not accept the proof");
  const proof=JSON.parse(readFileSync(proofPath,"utf8")) as {pi_a:string[],pi_b:string[][],pi_c:string[]};
  const signals=(JSON.parse(readFileSync(publicPath,"utf8")) as string[]).map(BigInt);
  expect(signals.length).toBe(11);
  expect(signals).toEqual([
    issuer,level,nullifier,recipient,BigInt(token),11155111n,expiry,
    parseEther("200"),1125912791875585000n,1n,provenance,
  ]);
  return {
    a:[BigInt(proof.pi_a[0]!),BigInt(proof.pi_a[1]!)],
    b:[[BigInt(proof.pi_b[0]![1]!),BigInt(proof.pi_b[0]![0]!)],
       [BigInt(proof.pi_b[1]![1]!),BigInt(proof.pi_b[1]![0]!)]],
    c:[BigInt(proof.pi_c[0]!),BigInt(proof.pi_c[1]!)],
    signals,commitmentRoot:level,
  };
}
async function attemptProof(data:ProofData,signals:readonly bigint[]=data.signals){
  return transaction(minter,zkAttestMinterAbi,accounts[3]!,"mintWithProof",
    [data.a,data.b,data.c,signals]);
}

describe.skipIf(!available)("native Groth16 private claim conversion",()=>{
 it("verifies on-chain, blocks alterations/replay, enforces active issuer roots and tracks live token balances",async()=>{
    const a=await makeProof(123456789123456789123456789n,935172348163284162341234n,880n);
    const issuer=accounts[1]!,recipient=accounts[2]!,outsider=accounts[3]!;
    // Unauthorized issuer root updates fail.
    await expect(transaction(roots,privateClaimRootsAbi,outsider,"replaceRoot",[a.commitmentRoot])).rejects.toThrow();
    await transaction(roots,privateClaimRootsAbi,issuer,"replaceRoot",[a.commitmentRoot]);
    const newSignal=(index:number,value:bigint)=>a.signals.map((x,i)=>i===index?value:x);
    for (const [index,value] of [
      [2,a.signals[2]!+1n],[3,BigInt(outsider)],[4,BigInt(outsider)],
      [5,1n],[6,a.signals[6]!+1n],[7,parseEther("201")],[8,a.signals[8]!+1n],
      [9,2n],[10,a.signals[10]!+1n],
    ] as const){
       await expect(attemptProof(a,newSignal(index,value))).rejects.toThrow();
    }
    // Replacing the live root revokes the authorization BEFORE mint.
    await transaction(roots,privateClaimRootsAbi,issuer,"replaceRoot",[999n]);
    await expect(attemptProof(a)).rejects.toThrow();
    await transaction(roots,privateClaimRootsAbi,issuer,"replaceRoot",[a.commitmentRoot]);
    const receipt=await attemptProof(a);
    expect(receipt.gasUsed).toBeGreaterThan(20_000n);
    expect(receipt.gasUsed).toBeLessThan(2_000_000n);
    expect(await reader.readContract({address:token,abi:attestTokenAbi,functionName:"balanceOf",args:[recipient]})).toBe(parseEther("200"));
    expect(await reader.readContract({address:token,abi:attestTokenAbi,functionName:"spentNullifiers",args:[toHex(a.signals[2]!,{size:32})]})).toBe(true);
    await expect(attemptProof(a)).rejects.toThrow();

    // A reissued claim referencing the SAME issuer-controlled event secret
    // but different holder/score must share the spent nullifier.
    const rewritten=await makeProof(123456789123456789123456789n,7777777777n,999n);
    expect(rewritten.signals[2]).toBe(a.signals[2]);
    await transaction(roots,privateClaimRootsAbi,issuer,"replaceRoot",[rewritten.commitmentRoot]);
    await expect(attemptProof(rewritten)).rejects.toThrow();

    await expect(makeProof(88881n,77772n,400n)).rejects.toThrow();
    await expect(makeProof(0n,77772n,900n)).rejects.toThrow();

    // Second unique event proves independently; emergency pause and issuer revocation gate it.
    const b=await makeProof(22446688113355779911n,4422118855771199n,950n);
    await transaction(roots,privateClaimRootsAbi,issuer,"replaceRoot",[b.commitmentRoot]);
    await transaction(token,attestTokenAbi,accounts[0]!,"setMintingPaused",[true]);
    await expect(attemptProof(b)).rejects.toThrow();
    await transaction(token,attestTokenAbi,accounts[0]!,"setMintingPaused",[false]);
    await transaction(roots,privateClaimRootsAbi,accounts[0]!,"configureIssuer",[issuer,false]);
    await expect(attemptProof(b)).rejects.toThrow();
    await transaction(roots,privateClaimRootsAbi,accounts[0]!,"configureIssuer",[issuer,true]);
    await transaction(roots,privateClaimRootsAbi,issuer,"replaceRoot",[b.commitmentRoot]);
    await attemptProof(b);
    expect(await reader.readContract({address:token,abi:attestTokenAbi,functionName:"totalSupply"})).toBe(parseEther("400"));
 },180_000);
});
