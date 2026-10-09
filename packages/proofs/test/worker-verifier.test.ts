import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  gpcPreVerify,
  boundConfigFromJSON,
  revealedClaimsFromJSON,
} from "@pcd/gpc";
import { deriveSignerPublicKey } from "@pcd/pod";
import { readExisting } from "../../../apps/issuer/src/verification-keys";
import { groth16 } from "../../../apps/issuer/src/groth16-worker";
import {
  createJourneyVault,
  journeyHolderKey,
  issueInstitutionCredential,
  prepareJourney,
  requestJourney,
  fictionalInstitutions,
} from "../../demo/src/testnet-journey";
const require = createRequire(import.meta.url);
const gpcRequire = createRequire(require.resolve("@pcd/gpc"));
const { ProtoPODGPC, gpcArtifactPaths } = gpcRequire("@pcd/gpcircuits");
const { groth16: reference } = gpcRequire("snarkjs");
it("Worker verifier agrees with snarkjs on real GPC proofs and rejects tampering", async () => {
  const keys = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
  const vault = createJourneyVault(
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    keys.map(deriveSignerPublicKey),
  );
  vault.credentials = fictionalInstitutions.map((i) =>
    issueInstitutionCredential(
      { ...vault, holderPublicKey: journeyHolderKey(vault) },
      i.id,
      i.value,
      keys[i.id]!,
      "44".repeat(32),
      new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10),
    ),
  );
  const artifacts = path.resolve(
    import.meta.dirname,
    "../node_modules/@pcd/proto-pod-gpc-artifacts",
  );
  const p = await prepareJourney(vault, requestJourney(vault), artifacts);
  for (const envelope of p.proofs) {
    const { circuitDesc, circuitPublicInputs, circuitOutputs } = gpcPreVerify(
      boundConfigFromJSON(envelope.boundConfig),
      revealedClaimsFromJSON(envelope.revealedClaims),
    );
    const vk = JSON.parse(
      await readFile(gpcArtifactPaths(artifacts, circuitDesc).vkeyPath, "utf8"),
    );
    const bundled = await readExisting(
      `https://cdn.jsdelivr.net/npm/@pcd/proto-pod-gpc-artifacts@0.13.0/${path.basename(gpcArtifactPaths(artifacts, circuitDesc).vkeyPath)}`,
    );
    expect(JSON.parse(new TextDecoder().decode(await bundled.read()))).toEqual(
      vk,
    );
    const signals = ProtoPODGPC.makePublicSignals(
      circuitPublicInputs,
      circuitOutputs,
    );
    expect(await reference.verify(vk, signals, envelope.proof)).toBe(true);
    expect(await groth16.verify(vk, signals, { ...envelope.proof })).toBe(true);
    const changed = [...signals];
    changed[0] = BigInt(changed[0]) + 1n;
    expect(await reference.verify(vk, changed, envelope.proof)).toBe(false);
    expect(await groth16.verify(vk, changed, { ...envelope.proof })).toBe(
      false,
    );
    expect(
      await groth16.verify(vk, signals, {
        ...envelope.proof,
        pi_a: ["1", "1", "1"],
      }),
    ).toBe(false);
    expect(
      await groth16.verify(vk, [-1n, ...signals.slice(1)], {
        ...envelope.proof,
      }),
    ).toBe(false);
  }
}, 120000);
