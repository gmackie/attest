import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import path from "node:path";
import solc from "solc";
const inputPath=path.resolve("zk/.generated/Groth16Verifier.sol");
const artifactPath=path.resolve("zk/.generated/Groth16Verifier.json");
const source=readFileSync(inputPath,"utf8");
const input={
  language:"Solidity",
  sources:{"Groth16Verifier.sol":{content:source}},
  settings:{evmVersion:"paris",outputSelection:{"*":{"*":["abi","evm.bytecode.object","evm.deployedBytecode.object"]}}}
};
const output=JSON.parse(solc.compile(JSON.stringify(input)));
const errors=(output.errors??[]).filter(x=>x.severity==="error");
if(errors.length)throw new Error(errors.map(x=>x.formattedMessage).join("\n"));
const all=output.contracts["Groth16Verifier.sol"];
const verifier=all.Groth16Verifier;
if(!verifier)throw new Error("Unexpected snarkjs verifier name");
mkdirSync(path.dirname(artifactPath),{recursive:true});
writeFileSync(artifactPath,JSON.stringify({
  abi:verifier.abi,
  bytecode:"0x"+verifier.evm.bytecode.object,
  deployedBytecode:"0x"+verifier.evm.deployedBytecode.object,
},null,2)+"\n");
console.log("Compiled synthetic-only Groth16Verifier to "+artifactPath);

// ATTE-25: presentation-receipt-v1 verifier from the ceremony directory. The
// transcript is checked first and the build fails closed on any artifact hash
// mismatch. `--production` refuses SYNTHETIC_TEST_ONLY material, including the
// private-conversion-v1 test fixture compiled above.
{
  const {existsSync,unlinkSync}=await import("node:fs");
  const {verifyArtifacts}=await import("../../zk/ceremony/lib.mjs");
  const production=process.argv.includes("--production");
  if(production){
    unlinkSync(artifactPath);
    throw new Error("--production: zk/.generated/Groth16Verifier.sol is a SYNTHETIC test fixture without a ceremony transcript; refusing");
  }
  const dir=path.resolve("zk/.generated/presentation-receipt-v1");
  if(existsSync(path.join(dir,"transcript.json"))){
    const transcript=verifyArtifacts(dir,{requireProduction:production});
    if(!transcript.final)throw new Error("presentation-receipt-v1 ceremony is not finalised");
    const receiptSource=readFileSync(path.join(dir,transcript.final.verifier),"utf8");
    const receiptOutput=JSON.parse(solc.compile(JSON.stringify({
      language:"Solidity",
      sources:{"Groth16Verifier.sol":{content:receiptSource}},
      settings:{evmVersion:"paris",outputSelection:{"*":{"*":["abi","evm.bytecode.object","evm.deployedBytecode.object"]}}}
    })));
    const receiptErrors=(receiptOutput.errors??[]).filter(x=>x.severity==="error");
    if(receiptErrors.length)throw new Error(receiptErrors.map(x=>x.formattedMessage).join("\n"));
    const compiled=receiptOutput.contracts["Groth16Verifier.sol"].Groth16Verifier;
    if(!compiled)throw new Error("Unexpected snarkjs verifier name");
    const receiptArtifact=path.join(dir,"final/Groth16Verifier.json");
    writeFileSync(receiptArtifact,JSON.stringify({
      abi:compiled.abi,
      bytecode:"0x"+compiled.evm.bytecode.object,
      deployedBytecode:"0x"+compiled.evm.deployedBytecode.object,
    },null,2)+"\n");
    console.log(`Compiled ${transcript.mode} presentation-receipt-v1 verifier to ${receiptArtifact}`);
  }
}
