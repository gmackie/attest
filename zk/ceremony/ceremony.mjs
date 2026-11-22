#!/usr/bin/env node
// Attest Groth16 phase-2 ceremony CLI (ATTE-25). Runbook: zk/ceremony/README.md.
//
//   init      --circuit <name> --dir <dir> --ptau <pinned phase-1 file> [--synthetic-test-only] [--label <text>]
//   contribute --dir <dir> --name <contributor> [--entropy-string <text>] [--attestation <text>] [--attestation-file <path>]
//   beacon    --dir <dir> --beacon-hash <hex> --source <text> [--iterations-exp 10]
//   verify    --dir <dir> [--recompile] [--require-production]
//   transcript --dir <dir> [--out <file>]
//   verify-artifacts --dir <dir> [--require-production] [--min-contributions <n>]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  CeremonyError, DEFAULT_MIN_CONTRIBUTIONS, applyBeacon, contribute, initCeremony, transcriptSummary,
  verifyArtifacts, verifyCeremony,
} from "./lib.mjs";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    circuit: { type: "string" }, dir: { type: "string" }, ptau: { type: "string" },
    "synthetic-test-only": { type: "boolean", default: false }, label: { type: "string" },
    name: { type: "string" }, "entropy-string": { type: "string" },
    attestation: { type: "string" }, "attestation-file": { type: "string" },
    "beacon-hash": { type: "string" }, source: { type: "string" }, "iterations-exp": { type: "string" },
    recompile: { type: "boolean", default: false }, "require-production": { type: "boolean", default: false },
    "min-contributions": { type: "string" }, out: { type: "string" },
  },
  strict: true,
});
const need = (key) => {
  if (!values[key]) throw new CeremonyError(`--${key} is required for ${command}`);
  return values[key];
};

try {
  let result;
  switch (command) {
    case "init":
      result = await initCeremony({
        circuit: need("circuit"), dir: need("dir"), ptau: values.ptau,
        syntheticTestOnly: values["synthetic-test-only"], label: values.label,
      });
      result = { mode: result.mode, circuit: result.circuit, phase1: result.phase1, initialZkey: result.initialZkey };
      break;
    case "contribute":
      result = await contribute({
        dir: need("dir"), name: need("name"), entropyString: values["entropy-string"],
        attestation: values.attestation, attestationFile: values["attestation-file"],
      });
      break;
    case "beacon": {
      const t = await applyBeacon({
        dir: need("dir"), beaconHash: need("beacon-hash"), source: need("source"),
        iterationsExp: values["iterations-exp"] ? Number(values["iterations-exp"]) : 10,
      });
      result = { beacon: t.beacon, final: t.final };
      break;
    }
    case "verify":
      result = await verifyCeremony({
        dir: need("dir"), recompile: values.recompile, requireProduction: values["require-production"],
      });
      break;
    case "transcript":
      result = transcriptSummary(need("dir"));
      if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2) + "\n");
      break;
    case "verify-artifacts": {
      const t = verifyArtifacts(need("dir"), {
        requireProduction: values["require-production"],
        minContributions: values["min-contributions"] ? Number(values["min-contributions"]) : DEFAULT_MIN_CONTRIBUTIONS,
      });
      result = { ok: true, mode: t.mode, artifacts: Object.keys(t.artifacts).length, finalised: Boolean(t.final) };
      break;
    }
    default:
      throw new CeremonyError(`unknown command ${command ?? "(none)"}; see the header of zk/ceremony/ceremony.mjs`);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  console.error(error instanceof CeremonyError ? `ceremony: ${error.message}` : error);
  process.exit(1);
}
