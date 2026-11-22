// Groth16 phase-2 ceremony tooling for Attest circuits (ATTE-25).
//
// The tooling coordinates snarkjs; it does not make a ceremony trustworthy on
// its own. A ceremony is only as good as its participants, their entropy
// handling, the phase-1 file and public verification of the transcript. See
// zk/ceremony/README.md. Neither the circuits nor this tooling are audited.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TOOLS = process.env.ATTEST_ZK_TOOLS ?? "/tmp/attest-zk-toolchain";
export const TRANSCRIPT_SCHEMA = "attest.zk-ceremony-transcript/v1";
export const TRANSCRIPT_FILE = "transcript.json";
/** Pinned phase-1 file and multi-party phase 2 (the only mode a production path may accept). */
export const MODE_CEREMONY = "CEREMONY";
/** Anything else: local phase 1, unpinned phase 1, or disclosed test entropy. Never for value. */
export const MODE_SYNTHETIC = "SYNTHETIC_TEST_ONLY";
export const ENTROPY_OS = "os-csprng-64-bytes";
export const ENTROPY_OS_USER = "os-csprng-64-bytes+contributor-string";
export const ENTROPY_TEST = "DETERMINISTIC_DISCLOSED_TEST_ENTROPY";
export const TOOL_VERSIONS = Object.freeze({
  compiler: "circom2@0.2.23", library: "circomlib@2.0.5", snarkjs: "snarkjs@0.7.5",
});
export const DEFAULT_MIN_CONTRIBUTIONS = 3;

export class CeremonyError extends Error {
  constructor(message) { super(message); this.name = "CeremonyError"; }
}
const fail = (message) => { throw new CeremonyError(message); };

const bin = (name) => path.join(TOOLS, "node_modules/.bin", name);
export const toolchainAvailable = () => existsSync(bin("circom2")) && existsSync(bin("snarkjs"));

export function hashFile(file) {
  const data = readFileSync(file);
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    blake2b512: createHash("blake2b512").update(data).digest("hex"),
  };
}

let snarkjsModule;
/** The pinned snarkjs library from the isolated toolchain (CommonJS build). */
export function snarkjs() {
  if (!toolchainAvailable()) fail(`ZK toolchain not found under ${TOOLS}; install it per zk/README.md`);
  snarkjsModule ??= createRequire(path.join(TOOLS, "package.json"))("snarkjs");
  return snarkjsModule;
}

/**
 * Runs one snarkjs library call while holding every FileHandle it opens, then closes the leftovers.
 * snarkjs 0.7.5 (and 0.7.6) never closes the phase-1 handle in zkey verify (sameRatioH) or newZKey.
 * Node 26 makes a FileHandle closed by garbage collection a fatal ERR_INVALID_STATE, so an
 * unreferenced leaked handle can crash the run; holding it until the call settles prevents that.
 */
export async function withFileHandles(call) {
  const open = fsp.open;
  const handles = [];
  fsp.open = async (...args) => {
    const handle = await open(...args);
    handles.push(handle);
    return handle;
  };
  try {
    return await call();
  } finally {
    fsp.open = open;
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }
}

export function execute(name, args, { quiet = false, cwd = REPO } = {}) {
  const result = spawnSync(bin(name), args, {
    cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 900_000,
  });
  if (result.status !== 0 || /\[ERROR\]|circuit too big/.test(result.stdout ?? ""))
    fail(`${name} ${args[0] ?? ""} exited ${result.status}: ${result.stderr}\n${(result.stdout ?? "").slice(-4000)}`);
  if (!quiet) {
    const message = (result.stdout || result.stderr || "").trim();
    if (message) console.log(message.slice(-2000));
  }
  return result.stdout ?? "";
}

/** Captures snarkjs logger output so the transcript can be cross-checked. */
export function captureLogger(echo = false) {
  const lines = [];
  const push = (level) => (msg) => { lines.push(String(msg)); if (echo) console[level === "error" ? "error" : "log"](msg); };
  return { lines, info: push("info"), warn: push("warn"), error: push("error"), debug: () => {} };
}

export function pinnedPtauSources() {
  return JSON.parse(readFileSync(path.join(REPO, "zk/ceremony/ptau-sources.json"), "utf8")).sources;
}

/** Same rule snarkjs 0.7.5 uses in `groth16 setup`. */
export const requiredPower = (r1cs) =>
  Math.floor(Math.log2(r1cs.nConstraints + r1cs.nPubInputs + r1cs.nOutputs)) + 1;

/** Compiles `zk/circuits/<name>.circom` with the pinned circom2 and circomlib. */
export async function compileCircuit(name, outDir) {
  const source = path.join(REPO, "zk/circuits", `${name}.circom`);
  if (!existsSync(source)) fail(`unknown circuit ${name}`);
  mkdirSync(outDir, { recursive: true });
  // circom2's WASM build cannot always resolve -l absolute paths; compile a
  // path-rewritten copy against a copied, pinned circomlib.
  cpSync(path.join(TOOLS, "node_modules/circomlib/circuits"), path.join(outDir, "circomlib"), { recursive: true });
  const compiled = path.join(outDir, `${name}.circom`);
  writeFileSync(compiled, readFileSync(source, "utf8")
    .replaceAll('include "poseidon.circom";', 'include "circomlib/poseidon.circom";')
    .replaceAll('include "comparators.circom";', 'include "circomlib/comparators.circom";')
    .replaceAll('include "bitify.circom";', 'include "circomlib/bitify.circom";'));
  // circom2 runs under WASI with the working directory preopened: compile
  // from inside outDir using relative paths so outDir may live anywhere.
  execute("circom2", [`${name}.circom`, "--r1cs", "--wasm", "--sym", "-o", "."], { quiet: true, cwd: outDir });
  const r1csPath = path.join(outDir, `${name}.r1cs`);
  const info = await withFileHandles(() => snarkjs().r1cs.info(r1csPath));
  return {
    source, r1cs: r1csPath, wasm: path.join(outDir, `${name}_js`, `${name}.wasm`),
    constraints: info.nConstraints, publicInputs: info.nPubInputs, outputs: info.nOutputs,
    power: requiredPower(info),
  };
}

/**
 * UNSAFE, SYNTHETIC TEST ONLY: a single local party generates (and could keep)
 * this phase-1 toxic waste. Callers must label everything derived from it.
 */
export function generateSyntheticPhase1(out, power) {
  const p0 = `${out}.0.tmp`, p1 = `${out}.1.tmp`;
  execute("snarkjs", ["powersoftau", "new", "bn128", String(power), p0], { quiet: true });
  execute("snarkjs", ["powersoftau", "contribute", p0, p1, "--name=synthetic-only",
    "-e=DO_NOT_USE_THIS_SYNTHETIC_PHASE1_FOR_ANYTHING_OF_VALUE"], { quiet: true });
  execute("snarkjs", ["powersoftau", "prepare", "phase2", p1, out], { quiet: true });
  rmSync(p0); rmSync(p1);
  return out;
}

/**
 * Resolves a phase-1 file for builds: an explicit file (ATTEST_ZK_PTAU or
 * `file`) must match a pinned digest; otherwise each pinned URL is tried and
 * digest-checked. Returns null when nothing verified is available, so the
 * caller fails closed unless it was explicitly asked for a synthetic build.
 */
export function resolvePinnedPhase1({ file = process.env.ATTEST_ZK_PTAU, downloadTo, minPower = 0 } = {}) {
  const sources = pinnedPtauSources().filter((s) => s.power >= minPower);
  if (file) {
    if (!existsSync(file)) fail(`phase-1 file not found: ${file}`);
    const digest = hashFile(file).blake2b512;
    const pinned = sources.find((s) => s.blake2b512 === digest);
    if (!pinned) fail(`phase-1 file ${file} does not match any pinned digest in zk/ceremony/ptau-sources.json`);
    return { file, pinned };
  }
  if (!downloadTo) return null;
  for (const pinned of sources) {
    const fetched = spawnSync("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "1",
      "--output", downloadTo, pinned.url], { encoding: "utf8", timeout: 300_000 });
    if (fetched.status !== 0) { console.warn(`phase-1 download failed for ${pinned.id}: ${(fetched.stderr ?? "").trim()}`); continue; }
    if (hashFile(downloadTo).blake2b512 !== pinned.blake2b512) fail(`phase-1 digest mismatch for ${pinned.id}`);
    return { file: downloadTo, pinned };
  }
  return null;
}

export const readTranscript = (dir) => {
  const file = path.join(dir, TRANSCRIPT_FILE);
  if (!existsSync(file)) fail(`no ceremony transcript at ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
};
const writeTranscript = (dir, transcript) =>
  writeFileSync(path.join(dir, TRANSCRIPT_FILE), JSON.stringify(transcript, null, 2) + "\n");
const rel = (dir, file) => path.relative(dir, file).split(path.sep).join("/");
const record = (dir, transcript, file) => { transcript.artifacts[rel(dir, file)] = hashFile(file); };
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const lastZkey = (t) => t.contributions.at(-1)?.zkey ?? t.initialZkey;

/**
 * Starts a ceremony: compiles the circuit, checks the phase-1 file and
 * writes the initial zkey. Outside `syntheticTestOnly`, the phase-1 file must
 * match a digest pinned in ptau-sources.json; there is no local fallback.
 */
export async function initCeremony({ circuit, dir, ptau, syntheticTestOnly = false, label }) {
  if (existsSync(path.join(dir, TRANSCRIPT_FILE))) fail(`ceremony already initialised in ${dir}`);
  if (!ptau && !syntheticTestOnly)
    fail("init requires --ptau <phase-1 file> whose Blake2b-512 digest is pinned in zk/ceremony/ptau-sources.json. " +
      "A locally generated phase 1 is only available with --synthetic-test-only.");
  mkdirSync(path.join(dir, "zkey"), { recursive: true });
  const compiled = await compileCircuit(circuit, path.join(dir, "circuit"));
  const phase1Path = path.join(dir, "phase1.ptau");
  let phase1;
  if (ptau) {
    if (!existsSync(ptau)) fail(`phase-1 file not found: ${ptau}`);
    const digest = hashFile(ptau);
    const pinned = pinnedPtauSources().find((s) => s.blake2b512 === digest.blake2b512);
    if (!pinned && !syntheticTestOnly)
      fail(`phase-1 file ${ptau} has unpinned Blake2b-512 ${digest.blake2b512}; refusing (add a reviewed entry to ptau-sources.json)`);
    if (pinned && pinned.power < compiled.power)
      fail(`phase-1 power 2^${pinned.power} is too small for ${compiled.constraints} constraints (needs 2^${compiled.power})`);
    copyFileSync(ptau, phase1Path);
    phase1 = pinned
      ? { source: "pinned", id: pinned.id, url: pinned.url, power: pinned.power, ...digest }
      : { source: "UNPINNED_SYNTHETIC_TEST_ONLY", id: null, url: null, power: null, ...digest };
  } else {
    const power = Math.max(compiled.power, 8);
    generateSyntheticPhase1(phase1Path, power);
    phase1 = { source: "DELIBERATELY_INSECURE_SELF_GENERATED_TEST_ONLY", id: null, url: null,
      power, ...hashFile(phase1Path) };
  }
  const initialZkey = path.join(dir, "zkey/0000.zkey");
  await withFileHandles(() => snarkjs().zKey.newZKey(compiled.r1cs, phase1Path, initialZkey));
  const mode = phase1.source === "pinned" && !syntheticTestOnly ? MODE_CEREMONY : MODE_SYNTHETIC;
  const transcript = {
    schema: TRANSCRIPT_SCHEMA,
    mode,
    label: label ?? (mode === MODE_CEREMONY ? null : "SYNTHETIC TEST ONLY - never secure anything of value"),
    circuit: {
      name: circuit,
      source: rel(REPO, compiled.source),
      sourceSha256: hashFile(compiled.source).sha256,
      constraints: compiled.constraints,
      publicInputs: compiled.publicInputs,
      requiredPower: compiled.power,
      ...TOOL_VERSIONS,
      r1cs: rel(dir, compiled.r1cs),
      wasm: rel(dir, compiled.wasm),
    },
    phase1: { file: "phase1.ptau", ...phase1 },
    initialZkey: rel(dir, initialZkey),
    contributions: [],
    beacon: null,
    final: null,
    artifacts: {},
    createdAt: new Date().toISOString(),
  };
  for (const file of [compiled.r1cs, compiled.wasm, phase1Path, initialZkey]) record(dir, transcript, file);
  writeTranscript(dir, transcript);
  return transcript;
}

/**
 * Adds one phase-2 contribution. Entropy is 64 bytes from the OS CSPRNG plus
 * an optional contributor string (snarkjs mixes in another 64 OS bytes). The
 * disclosed deterministic test string exists only for SYNTHETIC_TEST_ONLY.
 */
export async function contribute({ dir, name, entropyString, attestation, attestationFile, deterministicTestEntropy = false }) {
  const t = verifyArtifacts(dir);
  if (t.final) fail("ceremony is already finalised by the beacon; start a new ceremony");
  if (!name || !/^[\w .@:+-]{1,64}$/.test(name)) fail("contributor name must be 1-64 characters of [A-Za-z0-9_ .@:+-]");
  let entropy, entropySource;
  if (deterministicTestEntropy) {
    if (t.mode !== MODE_SYNTHETIC) fail("deterministic test entropy is refused outside SYNTHETIC_TEST_ONLY ceremonies");
    entropy = "DO_NOT_USE_THIS_DETERMINISTIC_PHASE2_ENTROPY_FOR_PRODUCTION";
    entropySource = ENTROPY_TEST;
  } else {
    entropy = randomBytes(64).toString("hex") + (entropyString ? `|${entropyString}` : "");
    entropySource = entropyString ? ENTROPY_OS_USER : ENTROPY_OS;
  }
  const index = t.contributions.length + 1;
  const previous = lastZkey(t);
  const out = path.join(dir, "zkey", `${String(index).padStart(4, "0")}.zkey`);
  const hash = await withFileHandles(() => snarkjs().zKey.contribute(path.join(dir, previous), out, name, entropy));
  entropy = undefined; // JS strings cannot be wiped; drop the reference and let the process exit.
  let attestationRef = null;
  if (attestationFile) {
    mkdirSync(path.join(dir, "attestations"), { recursive: true });
    const copy = path.join(dir, "attestations", `${String(index).padStart(4, "0")}${path.extname(attestationFile)}`);
    copyFileSync(attestationFile, copy);
    record(dir, t, copy);
    attestationRef = rel(dir, copy);
  }
  t.contributions.push({
    index, kind: "contribution", name,
    zkey: rel(dir, out),
    previousZkey: previous,
    contributionHash: hex(hash),
    entropySource,
    attestation: attestation ?? null,
    attestationFile: attestationRef,
    at: new Date().toISOString(),
  });
  record(dir, t, out);
  writeTranscript(dir, t);
  return t.contributions.at(-1);
}

/**
 * Finalises with a public random beacon (e.g. an Ethereum block hash at a
 * height announced before the last contribution), then exports the
 * verification key and Solidity verifier.
 */
export async function applyBeacon({ dir, beaconHash, iterationsExp = 10, source }) {
  const t = verifyArtifacts(dir);
  if (t.final) fail("ceremony is already finalised");
  if (t.contributions.length === 0) fail("a beacon needs at least one contribution");
  if (!/^(?:[0-9a-f]{2}){16,64}$/.test(beaconHash ?? "")) fail("beacon hash must be 32-128 lowercase hex bytes (no 0x)");
  if (!Number.isInteger(iterationsExp) || iterationsExp < 10 || iterationsExp > 63) fail("iterations exponent must be 10..63");
  if (!source || source.length < 8) fail("describe the public beacon source (chain, height, announcement)");
  mkdirSync(path.join(dir, "final"), { recursive: true });
  const finalZkey = path.join(dir, "final/final.zkey");
  const hash = await withFileHandles(() => snarkjs().zKey.beacon(path.join(dir, lastZkey(t)), finalZkey, "attest-beacon", beaconHash, iterationsExp));
  const vkeyPath = path.join(dir, "final/verification_key.json");
  const vkey = await withFileHandles(() => snarkjs().zKey.exportVerificationKey(finalZkey));
  writeFileSync(vkeyPath, JSON.stringify(vkey, null, 2) + "\n");
  const verifierPath = path.join(dir, "final/Groth16Verifier.sol");
  execute("snarkjs", ["zkey", "export", "solidityverifier", finalZkey, verifierPath], { quiet: true });
  t.beacon = { source, beaconHash, iterationsExp, name: "attest-beacon", previousZkey: lastZkey(t), contributionHash: hex(hash) };
  t.final = { zkey: rel(dir, finalZkey), verificationKey: rel(dir, vkeyPath), verifier: rel(dir, verifierPath) };
  for (const file of [finalZkey, vkeyPath, verifierPath]) record(dir, t, file);
  t.final.hashes = {
    zkey: t.artifacts[t.final.zkey], verificationKey: t.artifacts[t.final.verificationKey], verifier: t.artifacts[t.final.verifier],
  };
  t.finalizedAt = new Date().toISOString();
  writeTranscript(dir, t);
  return t;
}

/**
 * Fails closed unless every artifact named in the transcript is present and
 * matches its sha256 and Blake2b-512, the phase-1 digest matches, and the
 * circuit source (when present in this checkout) still matches. With
 * `requireProduction`, also refuses SYNTHETIC_TEST_ONLY material, missing
 * beacon/final keys, test entropy and too few contributions.
 */
export function verifyArtifacts(dir, { requireProduction = false, minContributions = DEFAULT_MIN_CONTRIBUTIONS } = {}) {
  const t = readTranscript(dir);
  if (t.schema !== TRANSCRIPT_SCHEMA) fail(`unsupported transcript schema ${t.schema}`);
  if (![MODE_CEREMONY, MODE_SYNTHETIC].includes(t.mode)) fail(`unknown ceremony mode ${t.mode}`);
  const entries = Object.entries(t.artifacts ?? {});
  if (entries.length === 0) fail("transcript lists no artifacts");
  for (const [name, expected] of entries) {
    const file = path.join(dir, name);
    if (!existsSync(file)) fail(`artifact missing: ${name}`);
    const actual = hashFile(file);
    if (actual.sha256 !== expected.sha256 || actual.blake2b512 !== expected.blake2b512)
      fail(`artifact hash mismatch: ${name}`);
  }
  const required = [t.circuit?.r1cs, t.circuit?.wasm, t.phase1?.file, t.initialZkey,
    ...t.contributions.map((c) => c.zkey), ...(t.final ? [t.final.zkey, t.final.verificationKey, t.final.verifier] : [])];
  for (const name of required) if (!name || !t.artifacts[name]) fail(`transcript does not hash required artifact ${name}`);
  if (t.artifacts[t.phase1.file].blake2b512 !== t.phase1.blake2b512) fail("phase-1 digest does not match the transcript");
  if (t.mode === MODE_CEREMONY) {
    const pinned = pinnedPtauSources().find((s) => s.blake2b512 === t.phase1.blake2b512);
    if (!pinned) fail("CEREMONY transcript uses a phase-1 file that is not pinned in ptau-sources.json");
    if (t.contributions.some((c) => c.entropySource === ENTROPY_TEST)) fail("CEREMONY transcript contains test entropy");
  }
  let previous = t.initialZkey;
  for (const [i, c] of t.contributions.entries()) {
    if (c.index !== i + 1 || c.previousZkey !== previous) fail(`contribution chain broken at #${i + 1}`);
    previous = c.zkey;
  }
  if (t.final && t.beacon?.previousZkey !== previous) fail("beacon does not follow the last contribution");
  const source = path.join(REPO, t.circuit.source);
  if (existsSync(source) && hashFile(source).sha256 !== t.circuit.sourceSha256)
    fail(`circuit source ${t.circuit.source} changed since this ceremony; its keys do not match the code`);
  if (requireProduction) {
    if (t.mode !== MODE_CEREMONY) fail(`refusing ${t.mode} artifacts on a production path`);
    if (!t.final || !t.beacon) fail("refusing a ceremony that has not been finalised with a public beacon");
    const people = t.contributions.filter((c) => c.entropySource === ENTROPY_OS || c.entropySource === ENTROPY_OS_USER);
    if (people.length < minContributions || new Set(people.map((c) => c.name)).size < minContributions)
      fail(`refusing a ceremony with fewer than ${minContributions} distinct contributors`);
  }
  return t;
}

const parseVerifiedContributions = (lines) => {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^contribution #(\d+) (.*):$/.exec(lines[i].split("\n")[0]);
    if (!m) continue;
    const body = lines[i].includes("\n") ? lines[i].split("\n").slice(1).join(" ") : "";
    found.push({ index: Number(m[1]), name: m[2], contributionHash: body.replace(/\s+/g, "") });
  }
  return found.sort((a, b) => a.index - b.index);
};

/**
 * Third-party verification: artifact hashes, `snarkjs zkey verify` of the
 * newest zkey against the r1cs and phase-1 file (this re-checks every
 * contribution in the chain), contribution hashes against the transcript,
 * and, when finalised, a byte-for-byte re-derivation of the beacon step and
 * the verification key. `recompile` also rebuilds the r1cs from source.
 */
export async function verifyCeremony({ dir, recompile = false, requireProduction = false }) {
  const t = verifyArtifacts(dir, { requireProduction });
  const target = t.final?.zkey ?? lastZkey(t);
  const logger = captureLogger();
  const ok = await withFileHandles(() => snarkjs().zKey.verifyFromR1cs(path.join(dir, t.circuit.r1cs), path.join(dir, t.phase1.file), path.join(dir, target), logger));
  if (!ok) fail(`snarkjs zkey verify rejected ${target}: ${logger.lines.filter((l) => /INVALID|not/.test(l)).join("; ")}`);
  const verified = parseVerifiedContributions(logger.lines);
  const expected = [
    ...t.contributions.map((c) => ({ name: c.name, contributionHash: c.contributionHash })),
    ...(t.final ? [{ name: t.beacon.name, contributionHash: t.beacon.contributionHash }] : []),
  ];
  if (verified.length !== expected.length) fail(`zkey holds ${verified.length} contributions; transcript lists ${expected.length}`);
  expected.forEach((e, i) => {
    if (verified[i].contributionHash !== e.contributionHash || verified[i].name !== e.name)
      fail(`contribution #${i + 1} in the zkey does not match the transcript`);
  });
  const scratch = mkdtempSync(path.join(tmpdir(), "attest-ceremony-verify-"));
  try {
    if (t.final) {
      const again = path.join(scratch, "final.zkey");
      await withFileHandles(() => snarkjs().zKey.beacon(path.join(dir, t.beacon.previousZkey), again, t.beacon.name, t.beacon.beaconHash, t.beacon.iterationsExp));
      if (hashFile(again).sha256 !== t.artifacts[t.final.zkey].sha256) fail("re-applying the beacon does not reproduce the final zkey");
      const vkey = JSON.stringify(await withFileHandles(() => snarkjs().zKey.exportVerificationKey(path.join(dir, t.final.zkey))), null, 2) + "\n";
      if (createHash("sha256").update(vkey).digest("hex") !== t.artifacts[t.final.verificationKey].sha256)
        fail("the verification key does not match the final zkey");
    }
    if (recompile) {
      const rebuilt = await compileCircuit(t.circuit.name, path.join(scratch, "circuit"));
      if (hashFile(rebuilt.r1cs).sha256 !== t.artifacts[t.circuit.r1cs].sha256)
        fail("recompiling the circuit from source does not reproduce the transcript r1cs");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    ok: true, mode: t.mode, circuit: t.circuit.name, constraints: t.circuit.constraints,
    contributions: verified, finalised: Boolean(t.final), finalHashes: t.final?.hashes ?? null,
  };
}

/** A publishable summary: every artifact hash plus contributor attestations. */
export function transcriptSummary(dir) {
  const t = verifyArtifacts(dir);
  return {
    schema: t.schema, mode: t.mode, label: t.label, circuit: t.circuit, phase1: t.phase1,
    contributions: t.contributions.map(({ index, name, contributionHash, entropySource, attestation, attestationFile, zkey, at }) =>
      ({ index, name, contributionHash, entropySource, attestation, attestationFile, zkey, zkeyHashes: t.artifacts[zkey], at })),
    beacon: t.beacon, final: t.final, artifacts: t.artifacts,
  };
}
