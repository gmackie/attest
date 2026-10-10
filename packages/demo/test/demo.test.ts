import path from "node:path";
import { expect, it } from "vitest";
import { Effect } from "effect";
import {
  advanceRun,
  authenticateRecord,
  checkReplay,
  createRun,
  defaultConfig,
  publicPresentation,
  type DemoConfig,
  type DemoRun,
  type ScenarioId,
} from "../src/index";
const artifacts = path.resolve(
  import.meta.dirname,
  "../../proofs/node_modules/@pcd/proto-pod-gpc-artifacts",
);
async function through(count: number, config: DemoConfig = defaultConfig) {
  let run = createRun(config);
  for (let i = 0; i < count; i++)
    run = await Effect.runPromise(advanceRun(run, artifacts));
  return run;
}
it.each(["supplier:acme", "supplier:beacon", "supplier:novus"])(
  "issues and plans coherent records for %s",
  async (supplier) => {
    const run = await through(5, { ...defaultConfig, supplier });
    expect(run.evaluation?.satisfied).toBe(true);
    expect(run.evaluation?.witnessIds).toHaveLength(3);
    expect(run.records?.every(authenticateRecord)).toBe(true);
    expect(
      new Set(run.records?.map((r) => r.signedPod.signerPublicKey)).size,
    ).toBe(3);
  },
  30_000,
);
it("supports all alternative issuers and the stricter buyer", async () => {
  const run = await through(5, {
    ...defaultConfig,
    supplier: "supplier:novus",
    buyer: "buyer:metro",
    insurer: "insurer:summit",
    auditor: "auditor:atlas",
    certifier: "certifier:clearline",
    aggregate: 5_000_000,
    occurrence: 2_000_000,
  });
  expect(run.evaluation?.satisfied).toBe(true);
}, 30_000);
it.each<[ScenarioId, number]>([
  ["tampered", 2],
  ["untrusted", 2],
  ["expired", 4],
  ["wrong-subject", 4],
  ["revoked", 4],
  ["insufficient", 4],
])(
  "stops %s at boundary %i",
  async (scenario, completed) => {
    const run = await through(completed, { ...defaultConfig, scenario });
    const result = await Effect.runPromise(
      Effect.result(advanceRun(run, artifacts)),
    );
    expect(result._tag).toBe("Failure");
    expect(run.proof).toBeUndefined();
    expect(run.completed).toBe(completed);
  },
  30_000,
);
it("rejects a smaller supplier for the stricter buyer", async () => {
  const run = await through(4, {
    ...defaultConfig,
    supplier: "supplier:beacon",
    buyer: "buyer:metro",
    aggregate: 5_000_000,
    occurrence: 2_000_000,
  });
  const result = await Effect.runPromise(Effect.result(advanceRun(run)));
  expect(result._tag).toBe("Failure");
}, 30_000);
it("runs a real proof, independently verifies, rejects replay and exports only the presentation", async () => {
  const run: DemoRun = await through(7);
  expect(run.receipt?.satisfied).toBe(true);
  expect(await Effect.runPromise(checkReplay(run, artifacts))).toBe(false);
  const presentation = publicPresentation(run);
  expect(presentation).not.toHaveProperty("records");
  expect(presentation).not.toHaveProperty("identity");
  expect(presentation.request.aggregateMinimumUsd).toBe("2000000");
  expect(presentation.scope.chain).toBe("not submitted");
}, 120_000);
