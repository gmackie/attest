import fs from "node:fs/promises";
import path from "node:path";
import solc from "solc";

const sourcePath = new URL("../src/AssuranceAnchor.sol", import.meta.url);
const source = await fs.readFile(sourcePath, "utf8");
const input = {
  language: "Solidity",
  sources: { "AssuranceAnchor.sol": { content: source } },
  settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } }
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const fatal = (output.errors ?? []).filter((error) => error.severity === "error");
if (fatal.length > 0) {
  for (const error of fatal) console.error(error.formattedMessage);
  process.exit(1);
}
const contract = output.contracts["AssuranceAnchor.sol"].AssuranceAnchor;
const destination = path.resolve("artifacts/AssuranceAnchor.json");
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, `${JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }, null, 2)}\n`);
console.log(`compiled ${destination}`);
