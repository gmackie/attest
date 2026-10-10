import path from "node:path";
import { it, expect } from "vitest";
import { Effect } from "effect";
import {
  industries,
  createIndustryRun,
  advanceIndustryRun,
  criteriaRequest,
} from "../src/industries";
import { commitValue } from "@attest/core";
import { criterionValue, verifyCriteria } from "@attest/proofs";
const artifacts = path.resolve(
  import.meta.dirname,
  "../../proofs/node_modules/@pcd/proto-pod-gpc-artifacts",
);
it.each(industries)(
  "$id privately proves ten criteria across five issuers and rejects replay",
  async (industry) => {
    let run = createIndustryRun(industry, undefined, true);
    for (let i = 0; i < 6; i++)
      run = await Effect.runPromise(advanceIndustryRun(run, artifacts));
    expect(run.receipt?.satisfied).toBe(true);
    expect(run.privateInbox?.proofs).toHaveLength(5);
    expect(run.inbox).toBeNull();
    expect(JSON.stringify(run.privateInbox)).not.toContain('"fields"');
    expect(JSON.stringify(run.privateInbox)).not.toContain(
      '"credential"' + ':"',
    );
    const proof = run.privateInbox!.proofs[0]!;
    const request = criteriaRequest(run, industry.sources[0]!.id);
    expect(
      await verifyCriteria(
        proof,
        { ...request, challenge: request.challenge + "different" },
        artifacts,
      ),
    ).toBe(false);
    expect(
      await verifyCriteria(
        proof,
        { ...request, subject: "another-person" },
        artifacts,
      ),
    ).toBe(false);
    expect(
      await verifyCriteria(
        proof,
        {
          ...request,
          criteria: request.criteria.map((c, index) =>
            index === 0
              ? {
                  ...c,
                  value:
                    c.kind === "number"
                      ? Number(c.value) + 100000
                      : c.kind === "text"
                        ? "unacceptable"
                        : c.kind === "boolean"
                          ? !c.value
                          : "2035-01-01",
                }
              : c,
          ),
        },
        artifacts,
      ),
    ).toBe(false);
    const changedIssuer = {
      ...request,
      issuerPublicKey: criteriaRequest(run, industry.sources[1]!.id)
        .issuerPublicKey,
    };
    expect(
      await verifyCriteria(
        { ...proof, policyCommitment: await commitValue(changedIssuer) },
        changedIssuer,
        artifacts,
      ),
    ).toBe(false);
    const changedHolder = {
      ...request,
      holderPublicKey: createIndustryRun(industry).holderPublicKey,
    };
    expect(
      await verifyCriteria(
        { ...proof, policyCommitment: await commitValue(changedHolder) },
        changedHolder,
        artifacts,
      ),
    ).toBe(false);
    const replayed = await Effect.runPromise(
      advanceIndustryRun(
        { ...run, completed: 5, challenge: "another-request" },
        artifacts,
      ),
    );
    expect(replayed.receipt?.satisfied).toBe(false);
  },
  240_000,
);
it("private preflight rejects insufficient evidence without a presentation", async () => {
  const industry = industries[0]!;
  let run = createIndustryRun(industry, undefined, true);
  run = {
    ...run,
    inputs: {
      ...run.inputs,
      screening: {
        ...run.inputs.screening!,
        fields: { ...run.inputs.screening!.fields, eligible: false },
      },
    },
  };
  for (let i = 0; i < 4; i++)
    run = await Effect.runPromise(advanceIndustryRun(run, artifacts));
  expect(
    (await Effect.runPromise(Effect.result(advanceIndustryRun(run, artifacts))))
      ._tag,
  ).toBe("Failure");
  expect(run.privateInbox).toBeNull();
}, 30_000);

it("encodes fractional claims exactly and rejects ambiguous typed values", () => {
  expect(criterionValue(3.7, "number")).toEqual({ type: "int", value: 3700n });
  expect(criterionValue(-2.5, "number")).toEqual({
    type: "int",
    value: -2500n,
  });
  expect(() => criterionValue(3.1234, "number")).toThrow();
  expect(() => criterionValue("false", "boolean")).toThrow();
  expect(() => criterionValue("2027-02-31", "date")).toThrow();
});
