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
