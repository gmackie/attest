# Groth16 phase-2 ceremony runbook (ATTE-25)

This tooling is ready for a real multi-party phase-2 ceremony. **No such ceremony has happened yet.** The only keys
that exist are synthetic test fixtures. The circuits and this tooling are not audited. An external audit must be
scheduled before mainnet (`specs/production-readiness.md`).

A Groth16 phase 2 is secure if at least one contributor generated its entropy honestly and destroyed it. The
tooling also checks three things:
- every step is reproducible;
- every artifact is hashed;
- any third party can re-verify the whole chain.

## Commands

All commands run from the repository root, with the pinned toolchain from `zk/README.md` installed under
`ATTEST_ZK_TOOLS` (default `/tmp/attest-zk-toolchain`).

| Step | Command |
| --- | --- |
| Init | `node zk/ceremony/ceremony.mjs init --circuit presentation-receipt-v1 --dir <dir> --ptau <phase-1 file>` |
| Contribute | `node zk/ceremony/ceremony.mjs contribute --dir <dir> --name <id> [--entropy-string <text>] [--attestation <text>] [--attestation-file <signed statement>]` |
| Beacon | `node zk/ceremony/ceremony.mjs beacon --dir <dir> --beacon-hash <hex> --source "<chain, height, announcement URL>" [--iterations-exp 10]` |
| Verify | `node zk/ceremony/ceremony.mjs verify --dir <dir> [--recompile] [--require-production]` |
| Transcript | `node zk/ceremony/ceremony.mjs transcript --dir <dir> --out transcript-summary.json` |
| Verify artifacts | `node zk/ceremony/ceremony.mjs verify-artifacts --dir <dir> [--require-production] [--min-contributions 3]` |

- **init** compiles the circuit and copies the phase-1 file. It accepts the phase-1 file only if its Blake2b-512
  digest is pinned in `ptau-sources.json`. Entries under `candidates` are not accepted. There is no local phase-1
  fallback. `--synthetic-test-only` allows an unpinned or locally generated phase 1, and labels the whole ceremony
  `SYNTHETIC_TEST_ONLY`.
- **contribute** first verifies every artifact and fails closed on a mismatch. Entropy is 64 bytes from the OS
  CSPRNG plus an optional typed string, and snarkjs mixes in another 64 OS bytes. Nothing in the CLI is
  deterministic. The entropy is passed in-process, never on a command line. The step records:
  - the contribution hash;
  - the previous zkey;
  - the zkey's sha256 and Blake2b-512;
  - the contributor's attestation.
- **beacon** applies `snarkjs zkey beacon` and then exports `final/verification_key.json` and
  `final/Groth16Verifier.sol`.
- **verify** runs these checks:
  1. `verify-artifacts`.
  2. `snarkjs zkey verify` of the newest zkey against the r1cs and phase-1 file. This step re-checks every
     contribution in the chain.
  3. Each contribution hash and name in the zkey is matched against the transcript.
  4. The beacon step is re-applied to the last contribution, and the result must be byte-identical to the final
     zkey.
  5. The verification key is re-exported.
  6. With `--recompile`, the r1cs is rebuilt from source and must match.
- **verify-artifacts** fails closed in all of these cases:
  - a missing file, or a sha256 or Blake2b-512 mismatch;
  - an unpinned phase-1 file in `CEREMONY` mode;
  - a broken contribution chain;
  - a circuit source that has changed since init.

  With `--require-production` it also refuses:
  - `SYNTHETIC_TEST_ONLY`;
  - a ceremony with no beacon;
  - test entropy;
  - fewer than `--min-contributions` distinct contributors (default 3).

  `contracts/scripts/compile-zk.mjs` runs it before compiling the receipt verifier. The receipt test also runs it
  before loading the keys.

The `zk-ceremony` test runs a dry run with three simulated contributors (alice, bob and carol), a beacon, full
verification and tamper checks. It is gated on the toolchain.

## Running a real ceremony

1. **Freeze the circuit.** Tag the commit. Publish the circuit's sha256 and the compiler, library and snarkjs
   versions. Any later source change invalidates the ceremony, and `verify-artifacts` enforces that.
2. **Choose phase 1.** Use a file whose digest is pinned in `sources`. The Hermez 2^14 file is pinned. The PSE
   Perpetual Powers of Tau file is only a candidate: Attest observed its digest itself, and a full
   `snarkjs powersoftau verify` has not been completed. To promote a file, cross-check its digest against
   independently published checksums, run `snarkjs powersoftau verify` to completion, and land the entry in a
   reviewed change.
3. **Recruit participants.** Aim for at least 3 independent contributors from different organisations; more is
   better. Each one uses their own machine, preferably an offline or freshly booted one. Publish the participant
   list and the order in advance.
4. **Announce.** Publish the ceremony ID and its schedule. Name the beacon in advance, for example "the hash of
   Ethereum mainnet block N". Choose N so that it will be mined only after the last contribution is due. Record
   the URL of the announcement.
5. **Coordinate.** The coordinator runs `init` and publishes `transcript.json`, `zkey/0000.zkey` and the r1cs.
   For each contributor in turn:
   1. The coordinator sends them the latest zkey and the transcript.
   2. The contributor runs `verify-artifacts`, then `contribute` with their own typed string.
   3. The contributor signs a statement containing their contribution hash, for example with minisign, an SSH
      signature or GPG.
   4. The contributor returns the new zkey, the transcript and the signed statement
      (`--attestation-file`). After that they wipe the machine, or at least end the process and reboot.

   The coordinator publishes every intermediate zkey and transcript as it arrives.
6. **Apply the beacon.** Once block N is final, run `beacon --beacon-hash <block hash without 0x> --source
   "Ethereum mainnet block N, announced at <url>"`. Use `--iterations-exp` 10 or more.
7. **Publish.** Publish the transcript summary, every zkey, the attestations, and the final key, verification key
   and verifier hashes. Mirror them in at least two places.
8. **Third-party verification.** Anyone can verify the published artifacts like this:
   1. Clone the tagged commit.
   2. Install the pinned toolchain.
   3. Download the published artifacts into a directory, using the same layout as the transcript.
   4. Run `verify --recompile --require-production`.
   5. Check that each contributor's signed statement matches the contribution hash with the same index.
   6. Check that the beacon hash equals the announced block's hash.
   7. Check that the deployed verifier's bytecode matches the compiled `final/Groth16Verifier.sol`.

Only then may a deployment pin the verification-key hash and verifier bytecode, and only together with the
external audit. A ceremony makes the setup trustworthy. It does not make the circuit or the contracts correct.
