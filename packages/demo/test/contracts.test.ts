import { expect, it } from "vitest";
import { Effect } from "effect";
import {
  industries,
  createIndustryRun,
  advanceIndustryRun,
  defaultIndustryInputs,
} from "../src/industries";
import {
  withContract,
  contractDocument,
  statementDocument,
} from "../src/contracts";
it.each(industries)(
  "$id standard passes and critical requires stronger evidence",
  async (base) => {
    for (const level of ["standard", "critical"] as const) {
      const industry = withContract(base, level);
      let run = createIndustryRun(industry);
      for (let i = 0; i < 6; i++)
        run = await Effect.runPromise(advanceIndustryRun(run));
      expect(run.receipt?.satisfied).toBe(level === "standard");
      expect(contractDocument(industry).clauses).toHaveLength(10);
      expect(
        statementDocument(run, industry.sources[0]!.id)?.signedRecord.pod
          .signature,
      ).toBeTruthy();
    }
  },
  120_000,
);
it("binds even descriptive agreement changes to a distinct request challenge", async () => {
  const industry = withContract(industries[0]!, "standard");
  const run = createIndustryRun(industry);
  const changed = {
    ...run,
    industry: {
      ...industry,
      contract: {
        ...industry.contract!,
        retention: "A different retention obligation",
      },
    },
  };
  const a = await Effect.runPromise(advanceIndustryRun(run));
  const b = await Effect.runPromise(advanceIndustryRun(changed));
  expect(a.challenge).not.toBe(b.challenge);
  expect(a.challenge).toContain(":contract:0x");
}, 30_000);
it("critical education passes after every required source assertion is strengthened", async () => {
  const industry = withContract(industries[1]!, "critical");
  const defaults = defaultIndustryInputs(industry);
  const inputs = Object.fromEntries(
    Object.entries(defaults).map(([id, input]) => [
      id,
      {
        ...input,
        fields: {
          ...input.fields,
          ...Object.fromEntries(
            industry.rules
              .filter((r) => r.source === id)
              .map((r) => [r.field, r.value]),
          ),
        },
      },
    ]),
  );
  let run = createIndustryRun(industry, inputs);
  for (let i = 0; i < 6; i++)
    run = await Effect.runPromise(advanceIndustryRun(run));
  expect(run.receipt?.satisfied).toBe(true);
}, 120_000);

it("rejects descriptive contract substitution after presentation", async () => {
  const industry = withContract(industries[0]!, "standard");
  let run = createIndustryRun(industry);
  for (let i = 0; i < 5; i++)
    run = await Effect.runPromise(advanceIndustryRun(run));
  const altered = {
    ...run,
    industry: {
      ...industry,
      contract: {
        ...industry.contract!,
        scope: "A different person or purpose",
      },
    },
  };
  const verified = await Effect.runPromise(advanceIndustryRun(altered));
  expect(verified.receipt?.satisfied).toBe(false);
}, 120_000);
