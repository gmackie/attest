import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Dry-run of the phase-2 ceremony tooling with three simulated contributors.
// Gated on the isolated ZK toolchain (zk/README.md), like the native ZK tests.
const root = path.resolve(import.meta.dirname, "../../..");
const toolPath = process.env.ATTEST_ZK_TOOLS ?? "/tmp/attest-zk-toolchain";
const cli = path.join(root, "zk/ceremony/ceremony.mjs");
const available = existsSync(path.join(toolPath, "node_modules/.bin/circom2")) &&
  existsSync(path.join(toolPath, "node_modules/.bin/snarkjs"));

// Phase 1: a pinned file (ATTEST_ZK_PTAU) gives a CEREMONY-mode dry run.
// Otherwise reuse an unpinned file (ATTEST_ZK_SYNTHETIC_PTAU or the receipt
// fixture's) or let init generate one, all under --synthetic-test-only.
const pinnedPtau = process.env.ATTEST_ZK_PTAU;
const syntheticPtau = process.env.ATTEST_ZK_SYNTHETIC_PTAU ??
  [path.join(root, "zk/.generated/presentation-receipt-v1/phase1.ptau")].find(existsSync);

const work = available ? mkdtempSync(path.join(tmpdir(), "attest-ceremony-test-")) : "";
afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

function run(...args: string[]) {
  const p = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: p.status === 0, out: p.stdout, err: p.stderr, json: () => JSON.parse(p.stdout) };
}
function ok(...args: string[]) {
  const r = run(...args);
  if (!r.ok) throw new Error(`ceremony ${args[0]} failed: ${r.err}`);
  return r.json();
}

describe.skipIf(!available)("Groth16 phase-2 ceremony tooling (3 simulated contributors)", () => {
  it("refuses to start without a pinned phase-1 file unless explicitly synthetic", () => {
    const missing = run("init", "--circuit", "presentation-receipt-v1", "--dir", path.join(work, "no-ptau"));
    expect(missing.ok).toBe(false);
    expect(missing.err).toMatch(/only available with --synthetic-test-only/);
    if (syntheticPtau) {
      const unpinned = run("init", "--circuit", "presentation-receipt-v1", "--dir", path.join(work, "unpinned"), "--ptau", syntheticPtau);
      expect(unpinned.ok).toBe(false);
      expect(unpinned.err).toMatch(/unpinned Blake2b-512/);
    }
  }, 300_000);

  it("runs init, contribute x3, beacon, verify and transcript, reproducibly and fail-closed", () => {
    const dir = path.join(work, "ceremony");
    const init = pinnedPtau
      ? ok("init", "--circuit", "presentation-receipt-v1", "--dir", dir, "--ptau", pinnedPtau)
      : ok("init", "--circuit", "presentation-receipt-v1", "--dir", dir, "--synthetic-test-only",
        ...(syntheticPtau ? ["--ptau", syntheticPtau] : []));
    expect(init.mode).toBe(pinnedPtau ? "CEREMONY" : "SYNTHETIC_TEST_ONLY");
    expect(init.circuit.constraints).toBeGreaterThan(1000);

    const hashes: string[] = [];
    for (const name of ["alice", "bob", "carol"]) {
      writeFileSync(path.join(work, `${name}.txt`), `I, ${name}, contributed and destroyed my entropy.\n`);
      const c = ok("contribute", "--dir", dir, "--name", name, "--entropy-string", `typed by ${name}`,
        "--attestation", `${name} attests`, "--attestation-file", path.join(work, `${name}.txt`));
      expect(c.entropySource).toBe("os-csprng-64-bytes+contributor-string");
      expect(c.contributionHash).toMatch(/^[0-9a-f]{128}$/);
      hashes.push(c.contributionHash);
    }
    expect(new Set(hashes).size).toBe(3);

    // Not yet finalised: a production path refuses it.
    expect(run("verify-artifacts", "--dir", dir, "--require-production").ok).toBe(false);
    // Bad beacon inputs are refused.
    expect(run("beacon", "--dir", dir, "--beacon-hash", "xyz", "--source", "synthetic test beacon").ok).toBe(false);

    const beaconHash = "5b7d7c1f2c3a7f0e9d4b8a6c5e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b";
    const finalised = ok("beacon", "--dir", dir, "--beacon-hash", beaconHash,
      "--source", "SYNTHETIC test beacon (a real ceremony uses a pre-announced Ethereum block hash)");
    expect(finalised.final.zkey).toBe("final/final.zkey");
    expect(run("contribute", "--dir", dir, "--name", "late").ok).toBe(false);

    // Full verification: zkey chain via snarkjs, transcript hashes, beacon re-derivation, recompiled r1cs.
    const report = ok("verify", "--dir", dir, "--recompile");
    expect(report.finalised).toBe(true);
    expect(report.contributions.map((c: { name: string }) => c.name)).toEqual(["alice", "bob", "carol", "attest-beacon"]);
    expect(report.contributions.slice(0, 3).map((c: { contributionHash: string }) => c.contributionHash)).toEqual(hashes);

    const summaryPath = path.join(work, "summary.json");
    const summary = ok("transcript", "--dir", dir, "--out", summaryPath);
    expect(JSON.parse(readFileSync(summaryPath, "utf8"))).toEqual(summary);
    expect(summary.contributions.map((c: { attestation: string }) => c.attestation)).toEqual(["alice attests", "bob attests", "carol attests"]);
    expect(summary.final.hashes.verificationKey.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.artifacts["attestations/0002.txt"]).toBeTruthy();

    // A third party with a copy of the published artifacts reaches the same result.
    const copy = path.join(work, "third-party");
    cpSync(dir, copy, { recursive: true });
    expect(ok("verify", "--dir", copy).finalHashes).toEqual(report.finalHashes);

    // Production gate.
    const production = run("verify-artifacts", "--dir", dir, "--require-production");
    if (pinnedPtau) expect(production.ok).toBe(true);
    else {
      expect(production.ok).toBe(false);
      expect(production.err).toMatch(/refusing SYNTHETIC_TEST_ONLY/);
    }

    // Fail closed on tampering.
    const tamper = (name: string, mutate: (d: string) => void, pattern: RegExp) => {
      const t = path.join(work, `tamper-${name}`);
      cpSync(dir, t, { recursive: true });
      mutate(t);
      const r = run("verify", "--dir", t);
      expect(r.ok).toBe(false);
      expect(r.err).toMatch(pattern);
    };
    tamper("zkey", d => {
      const f = path.join(d, "zkey/0002.zkey");
      const b = readFileSync(f); b[b.length - 1] = b[b.length - 1]! ^ 1; writeFileSync(f, b);
    }, /artifact hash mismatch: zkey\/0002.zkey/);
    tamper("vkey", d => {
      const f = path.join(d, "final/verification_key.json");
      writeFileSync(f, readFileSync(f, "utf8").replace('"nPublic": 11', '"nPublic": 12'));
    }, /artifact hash mismatch: final\/verification_key.json/);
    tamper("missing", d => rmSync(path.join(d, "zkey/0001.zkey")), /artifact missing/);
    tamper("contribution-hash", d => {
      const f = path.join(d, "transcript.json");
      const t = JSON.parse(readFileSync(f, "utf8"));
      t.contributions[1].contributionHash = "00".repeat(64);
      writeFileSync(f, JSON.stringify(t));
    }, /contribution #2 in the zkey does not match/);
    tamper("chain", d => {
      const f = path.join(d, "transcript.json");
      const t = JSON.parse(readFileSync(f, "utf8"));
      t.contributions[2].previousZkey = "zkey/0000.zkey";
      writeFileSync(f, JSON.stringify(t));
    }, /contribution chain broken at #3/);
    tamper("beacon", d => {
      const f = path.join(d, "transcript.json");
      const t = JSON.parse(readFileSync(f, "utf8"));
      t.beacon.beaconHash = "11".repeat(32);
      writeFileSync(f, JSON.stringify(t));
    }, /re-applying the beacon does not reproduce/);
    if (!pinnedPtau) tamper("relabel", d => {
      const f = path.join(d, "transcript.json");
      const t = JSON.parse(readFileSync(f, "utf8"));
      t.mode = "CEREMONY";
      writeFileSync(f, JSON.stringify(t));
    }, /not pinned in ptau-sources.json/);
  }, 900_000);
});
