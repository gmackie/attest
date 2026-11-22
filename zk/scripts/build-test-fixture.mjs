// Builds SYNTHETIC, TEST-ONLY Groth16 fixtures for the native ZK tests:
//   zk/.generated/                          private-conversion-v1 (manifest.json)
//   zk/.generated/presentation-receipt-v1/  presentation-receipt-v1 (ceremony transcript.json)
//
// Every key produced here is single-party and INSECURE. The phase-2 step uses
// a disclosed test entropy string (snarkjs 0.7.5 also mixes 64 OS random
// bytes, so runs are not byte-reproducible, but one local party still ran the
// whole setup). Production paths (`ceremony.mjs verify-artifacts
// --require-production`, `compile-zk.mjs --production`) refuse these.
//
// Phase 1: a pinned file (ATTEST_ZK_PTAU, or a download whose Blake2b-512
// matches zk/ceremony/ptau-sources.json). If none is available the build FAILS
// unless `--synthetic-test-only` is passed, which allows (a) a local,
// deliberately insecure phase 1 or (b) an unpinned file given via
// ATTEST_ZK_SYNTHETIC_PTAU, both labelled in the outputs.
//
//   node zk/scripts/build-test-fixture.mjs [--synthetic-test-only] [--circuit conversion|receipt|all]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  REPO, applyBeacon, compileCircuit, contribute, execute, generateSyntheticPhase1, hashFile, initCeremony,
  resolvePinnedPhase1, toolchainAvailable, verifyArtifacts,
} from "../ceremony/lib.mjs";

const { values } = parseArgs({
  options: {
    "synthetic-test-only": { type: "boolean", default: false },
    circuit: { type: "string", default: "all" },
  },
});
const synthetic = values["synthetic-test-only"];
const which = values.circuit;
if (!["conversion", "receipt", "all"].includes(which)) throw new Error("--circuit must be conversion, receipt or all");
if (!toolchainAvailable()) throw new Error("Install the pinned demonstration tools with the documented npm command");

const output = path.join(REPO, "zk/.generated");
mkdirSync(output, { recursive: true });
const file = (x) => path.join(output, x);

// ---- Phase 1 -------------------------------------------------------------
const pinned = resolvePinnedPhase1({ downloadTo: file("pot-pinned.ptau"), minPower: 14 });
let ptau, ptauSource, ptauUrl = null, ptauBlake2b512 = null;
if (pinned) {
  ptau = pinned.file;
  ptauSource = `pinned:${pinned.pinned.id}`;
  ptauUrl = pinned.pinned.url;
  ptauBlake2b512 = pinned.pinned.blake2b512;
  console.log(`Verified pinned phase-1 ${pinned.pinned.id}`);
} else if (!synthetic) {
  console.error("No pinned, digest-verified phase-1 file is available (set ATTEST_ZK_PTAU or allow the download). " +
    "Refusing to fall back to a local phase 1; pass --synthetic-test-only to build an UNSAFE test fixture.");
  process.exit(1);
} else if (process.env.ATTEST_ZK_SYNTHETIC_PTAU) {
  ptau = process.env.ATTEST_ZK_SYNTHETIC_PTAU;
  ptauSource = "UNPINNED_SYNTHETIC_TEST_ONLY";
  ptauBlake2b512 = hashFile(ptau).blake2b512;
  console.warn(`Using UNPINNED phase-1 ${ptau} for a SYNTHETIC TEST-ONLY fixture`);
} else {
  console.warn("No pinned phase 1 available; generating an UNSAFE LOCAL TEST-ONLY phase 1 (--synthetic-test-only)");
  ptau = generateSyntheticPhase1(file("pot-synthetic.ptau"), 14);
  ptauSource = "DELIBERATELY_INSECURE_SELF_GENERATED_TEST_ONLY";
}

// ---- private-conversion-v1 (unchanged layout) ----------------------------
if (which === "conversion" || which === "all") {
  const compiled = await compileCircuit("private-conversion-v1", output);
  execute("snarkjs", ["groth16", "setup", compiled.r1cs, ptau, file("initial.zkey")]);
  execute("snarkjs", ["zkey", "contribute", file("initial.zkey"), file("final.zkey"),
    "--name=test-unsafe", "-e=DO_NOT_USE_THIS_DETERMINISTIC_PHASE2_ENTROPY_FOR_PRODUCTION"]);
  execute("snarkjs", ["zkey", "verify", compiled.r1cs, ptau, file("final.zkey")]);
  execute("snarkjs", ["zkey", "export", "verificationkey", file("final.zkey"), file("verification_key.json")]);
  execute("snarkjs", ["zkey", "export", "solidityverifier", file("final.zkey"), file("Groth16Verifier.sol")]);
  const manifest = {
    mode: "SYNTHETIC_UNSAFE_TRUSTED_SETUP_TEST_ONLY",
    compiler: "circom2@0.2.23",
    library: "circomlib@2.0.5",
    snarkjs: "snarkjs@0.7.5",
    constraints: compiled.constraints,
    ptauSource,
    ptauUrl,
    ptauBlake2b512,
    phase2Entropy: "DETERMINISTIC_DISCLOSED_TEST_ENTROPY (single party)",
    circuitSha256: createHash("sha256").update(readFileSync(compiled.source)).digest("hex"),
    verifierSha256: createHash("sha256").update(readFileSync(file("Groth16Verifier.sol"))).digest("hex"),
    provingArtifact: "zk/.generated/private-conversion-v1_js/private-conversion-v1.wasm",
    provingKey: "zk/.generated/final.zkey",
    expires: "Not for production or any valuable issuance",
  };
  writeFileSync(file("manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("private-conversion-v1 TEST-ONLY fixture:", JSON.stringify(manifest, null, 2));
}

// ---- presentation-receipt-v1 (ceremony tooling, synthetic mode) ----------
if (which === "receipt" || which === "all") {
  const dir = file("presentation-receipt-v1");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  await initCeremony({
    circuit: "presentation-receipt-v1", dir, ptau, syntheticTestOnly: true,
    label: `SYNTHETIC TEST FIXTURE (phase 1: ${ptauSource}); single-party phase 2 with disclosed test entropy - never secure anything of value`,
  });
  await contribute({ dir, name: "test-unsafe", deterministicTestEntropy: true });
  await applyBeacon({
    dir, iterationsExp: 10,
    beaconHash: createHash("sha256").update("attest synthetic test beacon v1").digest("hex"),
    source: "DISCLOSED SYNTHETIC TEST BEACON: sha256('attest synthetic test beacon v1'); not a public randomness source",
  });
  const t = verifyArtifacts(dir);
  console.log(`presentation-receipt-v1 TEST-ONLY fixture: ${t.circuit.constraints} constraints, mode ${t.mode}, ` +
    `verifier sha256 ${t.final.hashes.verifier.sha256}`);
}
process.exit(0);
