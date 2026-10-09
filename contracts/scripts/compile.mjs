import fs from "node:fs/promises";
import path from "node:path";
import solc from "solc";

for (const name of [
  "AssuranceAnchor",
  "WorkspaceRegistry",
  "DemoJourneyRegistry",
]) {
  const sourcePath = new URL(`../src/${name}.sol`, import.meta.url);
  const source = await fs.readFile(sourcePath, "utf8");
  const input = {
    language: "Solidity",
    sources: { [`${name}.sol`]: { content: source } },
    settings: {
      evmVersion: "paris",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const fatal = (output.errors ?? []).filter(
    (error) => error.severity === "error",
  );
  if (fatal.length > 0) {
    for (const error of fatal) console.error(error.formattedMessage);
    process.exit(1);
  }
  const contract = output.contracts[`${name}.sol`][name];
  const destination = path.resolve(`artifacts/${name}.json`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(
    destination,
    `${JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }, null, 2)}\n`,
  );
  console.log(`compiled ${destination}`);

  if (name !== "AssuranceAnchor") {
    const publicDir = new URL(
      "../../apps/web/public/contracts/",
      import.meta.url,
    );
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(
      new URL(`${name}.json`, publicDir),
      JSON.stringify({
        abi: contract.abi,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        bytecode: `0x${contract.evm.bytecode.object}`,
      }),
    );
  }
}
