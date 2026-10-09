import path from "node:path";
import { it, expect } from "vitest";
import { Effect } from "effect";
import { supplierIndustry } from "../src/supplier";
import { withContract, contractDocument } from "../src/contracts";
import {
  advanceIndustryRun,
  createIndustryRun,
  defaultIndustryInputs,
} from "../src/industries";
const artifacts = path.resolve(
  import.meta.dirname,
  "../../proofs/node_modules/@pcd/proto-pod-gpc-artifacts",
);
it("supplier has twenty versioned clauses and seven independent sources", () => {
  expect(supplierIndustry.rules).toHaveLength(20);
  expect(supplierIndustry.sources).toHaveLength(7);
  expect(
    contractDocument(withContract(supplierIndustry, "critical")).clauses[0]
      ?.required,
  ).toBe(10000000);
});
it("supplier privately proves all sources and keeps clauses bound to their original issuer", async () => {
  let run = createIndustryRun(
    withContract(supplierIndustry, "standard"),
    undefined,
    true,
  );
  for (let i = 0; i < 6; i++)
    run = await Effect.runPromise(advanceIndustryRun(run, artifacts));
  expect(run.receipt?.satisfied).toBe(true);
  expect(run.privateInbox?.proofs).toHaveLength(7);
  const inputs = defaultIndustryInputs(supplierIndustry);
  const failedInputs = {
    ...inputs,
    finance: {
      ...inputs.finance!,
      fields: { ...inputs.finance!.fields, liquidity: 100000 },
    },
  };
  let failed = createIndustryRun(supplierIndustry, failedInputs, true);
  for (let i = 0; i < 4; i++)
    failed = await Effect.runPromise(advanceIndustryRun(failed, artifacts));
  await expect(
    Effect.runPromise(advanceIndustryRun(failed, artifacts)),
  ).rejects.toThrow();
}, 120000);
