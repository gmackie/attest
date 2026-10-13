import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tools = process.env.ATTEST_ZK_TOOLS ?? "/tmp/attest-zk-toolchain";
const bins = path.join(tools, "node_modules/.bin");
const source = path.join(root,"zk/circuits/private-conversion-v1.circom");
const circuits = path.join(tools,"node_modules/circomlib/circuits");
const output = path.join(root,"zk/.generated");
if (!existsSync(path.join(bins,"circom2")) || !existsSync(path.join(bins,"snarkjs"))) {
  throw new Error("Install the pinned demonstration tools with the documented npm command");
}
mkdirSync(output,{recursive:true});

function execute(name,args) {
  console.log(`$ ${name} ${args.join(" ")}`);
  const result=spawnSync(path.join(bins,name),args,{
    cwd:root, encoding:"utf8",maxBuffer:15*1024*1024,timeout:600_000
  });
  if(result.status!==0 || /\[ERROR\]|circuit too big/.test(result.stdout ?? ""))throw new Error(`${name} exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  const message=(result.stdout||result.stderr).trim();
  if(message)console.log(message.slice(-2500));
}
const file = (x)=>path.join(output,x);
// circom2's WASM package can fail to resolve -l absolute paths. Copy the
// pinned library to the generated directory and compile a path-rewritten
// ephemeral source so imports are reproducible without altering the repo.
cpSync(circuits,file("circomlib"),{recursive:true});
const compiledSource=file("private-conversion-v1.circom");
writeFileSync(compiledSource,readFileSync(source,"utf8")
  .replaceAll('include "poseidon.circom";','include "circomlib/poseidon.circom";')
  .replaceAll('include "comparators.circom";','include "circomlib/comparators.circom";')
  .replaceAll('include "bitify.circom";','include "circomlib/bitify.circom";'));
execute("circom2",[compiledSource,"--r1cs","--wasm","--sym","-o",output]);
const r1cs=file("private-conversion-v1.r1cs");
const prefix=file("private-conversion-v1");
// Use the publicly audited phase-1 Powers of Tau from the snarkjs reference
// with its independently published Blake2b-512 digest. The PHASE-2
// contribution below is still deliberately deterministic and UNSAFE.
const ptau=file("pot-final.ptau");
const uri="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau";
const fetched=spawnSync("curl",["--fail","--location","--silent","--show-error",
  "--retry","3","--output",ptau,uri],{encoding:"utf8",timeout:180_000});
if(fetched.status!==0)throw new Error("Failed to retrieve pinned phase-1 ptau: "+fetched.stderr);
const expected="eeefbcf7c3803b523c94112023c7ff89558f9b8e0cf5d6cdcba3ade60f168af4a181c9c21774b94fbae6c90411995f7d854d02ebd93fb66043dbb06f17a831c1";
const actual=createHash("blake2b512").update(readFileSync(ptau)).digest("hex");
if(actual!==expected)throw new Error("HERMEZ phase-1 powers of tau digest mismatch");
console.log("Verified official Hermez 2^14 powers of tau (blake2b512)");
execute("snarkjs",["groth16","setup",r1cs,ptau,file("initial.zkey")]);
execute("snarkjs",["zkey","contribute",file("initial.zkey"),file("final.zkey"),
  "--name=test-unsafe", "-e=DO_NOT_USE_THIS_DETERMINISTIC_PHASE2_ENTROPY_FOR_PRODUCTION"]);
execute("snarkjs",["zkey","verify",r1cs,ptau,file("final.zkey")]);
execute("snarkjs",["zkey","export","verificationkey",file("final.zkey"),file("verification_key.json")]);
execute("snarkjs",["zkey","export","solidityverifier",file("final.zkey"),file("Groth16Verifier.sol")]);
const manifest={
  mode:"SYNTHETIC_UNSAFE_TRUSTED_SETUP_TEST_ONLY",
  compiler:"circom2@0.2.23",
  library:"circomlib@2.0.5",
  snarkjs:"snarkjs@0.7.5",
  ptauUrl:uri,
  ptauBlake2b512:expected,
  circuitSha256:createHash("sha256").update(readFileSync(source)).digest("hex"),
  verifierSha256:createHash("sha256").update(readFileSync(file("Groth16Verifier.sol"))).digest("hex"),
  provingArtifact:"zk/.generated/private-conversion-v1_js/private-conversion-v1.wasm",
  provingKey:"zk/.generated/final.zkey",
  expires:"Not for production or any valuable issuance",
};
writeFileSync(file("manifest.json"),JSON.stringify(manifest,null,2)+"\n");
console.log("ZK circuit and TEST-ONLY Groth16 verifier generated:",JSON.stringify(manifest,null,2));
