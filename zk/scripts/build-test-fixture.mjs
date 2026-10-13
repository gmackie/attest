import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
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
    cwd:root, encoding:"utf8",maxBuffer:15*1024*1024,timeout:180_000
  });
  if(result.status!==0)throw new Error(`${name} exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  const message=(result.stdout||result.stderr).trim();
  if(message)console.log(message.slice(-2500));
}
const file = (x)=>path.join(output,x);
execute("circom2",[source,"--r1cs","--wasm","--sym","-l",circuits,"-o",output]);
const r1cs=file("private-conversion-v1.r1cs");
const prefix=file("private-conversion-v1");
execute("snarkjs",["powersoftau","new","bn128","12",file("pot0.ptau")]);
execute("snarkjs",["powersoftau","contribute",file("pot0.ptau"),file("pot1.ptau"),
  "--name=synthetic-only", "-e=DO_NOT_USE_THIS_DETERMINISTIC_ENTROPY_FOR_PRODUCTION"]);
execute("snarkjs",["powersoftau","prepare","phase2",file("pot1.ptau"),file("pot-final.ptau")]);
execute("snarkjs",["groth16","setup",r1cs,file("pot-final.ptau"),file("initial.zkey")]);
execute("snarkjs",["zkey","contribute",file("initial.zkey"),file("final.zkey"),
  "--name=test-unsafe", "-e=DO_NOT_USE_THIS_DETERMINISTIC_PHASE2_ENTROPY_FOR_PRODUCTION"]);
execute("snarkjs",["zkey","verify",r1cs,file("pot-final.ptau"),file("final.zkey")]);
execute("snarkjs",["zkey","export","verificationkey",file("final.zkey"),file("verification_key.json")]);
execute("snarkjs",["zkey","export","solidityverifier",file("final.zkey"),file("Groth16Verifier.sol")]);
const manifest={
  mode:"SYNTHETIC_UNSAFE_TRUSTED_SETUP_TEST_ONLY",
  compiler:"circom2@0.2.23",
  library:"circomlib@2.0.5",
  snarkjs:"snarkjs@0.7.5",
  circuitSha256:createHash("sha256").update(readFileSync(source)).digest("hex"),
  verifierSha256:createHash("sha256").update(readFileSync(file("Groth16Verifier.sol"))).digest("hex"),
  provingArtifact:"zk/.generated/private-conversion-v1_js/private-conversion-v1.wasm",
  provingKey:"zk/.generated/final.zkey",
  expires:"Not for production or any valuable issuance",
};
writeFileSync(file("manifest.json"),JSON.stringify(manifest,null,2)+"\n");
console.log("ZK circuit and TEST-ONLY Groth16 verifier generated:",JSON.stringify(manifest,null,2));
