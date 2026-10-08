import { it, expect } from "vitest";
import { Effect } from "effect";
import {
  industries,
  defaultIndustryInputs,
  createIndustryRun,
  advanceIndustryRun,
  type Industry,
  type IndustryInputs,
  type IndustryRun,
} from "../src/industries";
const through = async (
  industry: Industry,
  count: number,
  inputs: IndustryInputs = defaultIndustryInputs(industry),
) => {
  let run = createIndustryRun(industry, inputs);
  for (let i = 0; i < count; i++)
    run = await Effect.runPromise(advanceIndustryRun(run));
  return run;
};
it.each(industries)(
  "$id: moves data through distinct institution stores and verifies",
  async (industry) => {
    const run = await through(industry, 7);
    expect(run.receipt?.satisfied).toBe(true);
    expect(run.issued).toHaveLength(5);
    expect(new Set(run.issued.map((c) => c.pod.signerPublicKey)).size).toBe(5);
    expect(run.ledger).toHaveLength(1);
    expect(JSON.stringify(run.inbox)).not.toContain("internalNote");
    expect(JSON.stringify(run.ledger)).not.toContain("fields");
    expect(Object.keys(run.raw)).toHaveLength(5);
    expect(run.raw[industry.sources[0]!.id]?.internalNote).toBeTruthy();
  },
  30_000,
);
it.each(industries)(
  "$id: rejects its meaningful failure example",
  async (industry) => {
    const inputs = defaultIndustryInputs(industry);
    const f = industry.failure;
    const run = await through(industry, 6, {
      ...inputs,
      [f.source]: {
        ...inputs[f.source]!,
        fields: { ...inputs[f.source]!.fields, [f.field]: f.value },
      },
    });
    expect(run.receipt?.satisfied).toBe(false);
    expect(run.checks.filter((c) => !c.satisfied)).toHaveLength(1);
  },
  30_000,
);
it("cannot combine credentials for different subjects", async () => {
  const industry = industries[0]!;
  const inputs = defaultIndustryInputs(industry);
  const id = industry.sources[0]!.id;
  const run = await through(industry, 6, {
    ...inputs,
    [id]: { ...inputs[id]!, subject: "clinician:someone-else" },
  });
  expect(run.receipt?.satisfied).toBe(false);
}, 30_000);
it("fails on malformed numeric/date input and incoherent sensor readings", async () => {
  const industry = industries[2]!;
  const inputs = defaultIndustryInputs(industry);
  for (const fields of [
    { minimum: 10, maximum: 6 },
    { minimum: "abc", maximum: 6 },
  ]) {
    const run = await through(industry, 1, {
      ...inputs,
      sensor: { ...inputs.sensor!, fields },
    });
    expect(
      (await Effect.runPromise(Effect.result(advanceIndustryRun(run))))._tag,
    ).toBe("Failure");
  }
  const run = await through(industry, 1, {
    ...inputs,
    laboratory: {
      ...inputs.laboratory!,
      fields: { passed: true, validThrough: "2027-02-31" },
    },
  });
  expect(
    (await Effect.runPromise(Effect.result(advanceIndustryRun(run))))._tag,
  ).toBe("Failure");
});
it("rejects modified claims, duplicate credentials, changed challenges and other holders", async () => {
  const run = await through(industries[1]!, 5);
  const first = run.inbox!.credentials[0]!;
  const cases: IndustryRun[] = [
    { ...run, challenge: run.challenge + ":replay" },
    {
      ...run,
      holderPublicKey: createIndustryRun(industries[1]!).holderPublicKey,
    },
    { ...run, inbox: { ...run.inbox!, credentials: [first, first, first] } },
    {
      ...run,
      inbox: {
        ...run.inbox!,
        credentials: [
          {
            ...first,
            claims: {
              ...first.claims,
              fields: { ...first.claims.fields, gpa: 4 },
            },
          },
          ...run.inbox!.credentials.slice(1),
        ],
      },
    },
  ];
  for (const modified of cases)
    expect(
      (await Effect.runPromise(advanceIndustryRun(modified))).receipt
        ?.satisfied,
    ).toBe(false);
}, 30_000);
it("snapshots do not mutate earlier institution stores", async () => {
  const source = createIndustryRun(industries[0]!);
  const captured = await Effect.runPromise(advanceIndustryRun(source));
  expect(source.raw).toEqual({});
  const prepared = await Effect.runPromise(advanceIndustryRun(captured));
  expect(captured.prepared).toEqual([]);
  expect(prepared.wallet).toEqual([]);
});
