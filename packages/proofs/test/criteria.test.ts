import path from "node:path";
import { deriveSignerPublicKey } from "@pcd/pod";
import { expect, it } from "vitest";
import { commitValue } from "@attest/core";
import {
  issueCriteriaPod,
  proveCriteria,
  verifyCriteria,
  type CriteriaRequest,
  type PrivateCriterion,
} from "../src/index";

const artifacts = path.resolve(
  import.meta.dirname,
  "../node_modules/@pcd/proto-pod-gpc-artifacts",
);
const issuerKey = "22".repeat(32);
const request: CriteriaRequest = {
  schema: "synthetic:training:v1",
  subject: "synthetic:alice",
  holderPublicKey: deriveSignerPublicKey("11".repeat(32)),
  issuerPublicKey: deriveSignerPublicKey(issuerKey),
  challenge: "ATTE-11-fixed-range-reproduction",
  criteria: [
    { field: "hours", kind: "number", operator: "gte", value: 10 },
    { field: "hours", kind: "number", operator: "lte", value: 40 },
  ],
};

it("rejects a weaker proof relabeled as a two-sided range request", async () => {
  const pod = issueCriteriaPod(request, { hours: 5 }, issuerKey);
  const weakerRequest = { ...request, criteria: request.criteria.slice(1) };
  const weakerProof = await proveCriteria(pod, weakerRequest, artifacts);
  expect(await verifyCriteria(weakerProof, weakerRequest, artifacts)).toBe(true);

  expect(
    await verifyCriteria(
      { ...weakerProof, policyCommitment: await commitValue(request) },
      request,
      artifacts,
    ),
  ).toBe(false);
  await expect(proveCriteria(pod, request, artifacts)).rejects.toThrow();
});

const numberRule = (
  operator: PrivateCriterion["operator"],
  value: number,
): PrivateCriterion => ({ field: "hours", kind: "number", operator, value });

it.each<{
  name: string;
  criteria: PrivateCriterion[];
  fields: Record<string, string | number | boolean>;
}>([
  {
    name: "upper bound before lower bound",
    criteria: [numberRule("lte", 40), numberRule("gte", 10)],
    fields: { hours: 50 },
  },
  {
    name: "stricter lower bound before a weaker lower bound",
    criteria: [numberRule("gte", 20), numberRule("gte", 10)],
    fields: { hours: 15 },
  },
  {
    name: "stricter upper bound before a weaker upper bound",
    criteria: [numberRule("lte", 20), numberRule("lte", 40)],
    fields: { hours: 30 },
  },
  {
    name: "equality before a range",
    criteria: [numberRule("eq", 10), numberRule("gte", 5)],
    fields: { hours: 7 },
  },
  {
    name: "a range before incompatible equality",
    criteria: [numberRule("gte", 10), numberRule("eq", 5)],
    fields: { hours: 5 },
  },
  {
    name: "conflicting equalities",
    criteria: [numberRule("eq", 10), numberRule("eq", 20)],
    fields: { hours: 20 },
  },
  {
    name: "an expired value before the permitted date range",
    criteria: [
      { field: "validThrough", kind: "date", operator: "gte", value: "2030-01-01" },
      { field: "validThrough", kind: "date", operator: "lte", value: "2030-12-31" },
    ],
    fields: { validThrough: "2029-12-31" },
  },
])("enforces $name", async ({ criteria, fields }) => {
  const fullRequest = { ...request, criteria };
  const pod = issueCriteriaPod(fullRequest, fields, issuerKey);
  const weakerRequest = { ...fullRequest, criteria: criteria.slice(1) };
  const weakerProof = await proveCriteria(pod, weakerRequest, artifacts);
  expect(await verifyCriteria(weakerProof, weakerRequest, artifacts)).toBe(true);
  expect(
    await verifyCriteria(
      { ...weakerProof, policyCommitment: await commitValue(fullRequest) },
      fullRequest,
      artifacts,
    ),
  ).toBe(false);
  await expect(proveCriteria(pod, fullRequest, artifacts)).rejects.toThrow();
});

it.each([10, 40])("accepts the inclusive range boundary %s", async (hours) => {
  const pod = issueCriteriaPod(request, { hours }, issuerKey);
  const proof = await proveCriteria(pod, request, artifacts);
  expect(await verifyCriteria(proof, request, artifacts)).toBe(true);
});

it.each([false, true])("preserves equality and ranges in either order (%s)", async (reverse) => {
  const criteria = [numberRule("eq", 20), numberRule("gte", 10), numberRule("lte", 40)];
  const fullRequest = { ...request, criteria: reverse ? criteria.reverse() : criteria };
  const pod = issueCriteriaPod(fullRequest, { hours: 20 }, issuerKey);
  const proof = await proveCriteria(pod, fullRequest, artifacts);
  expect(await verifyCriteria(proof, fullRequest, artifacts)).toBe(true);
});

it("accepts repeated consistent equalities and intersected bounds", async () => {
  const fullRequest = {
    ...request,
    criteria: [
      numberRule("eq", 20), numberRule("eq", 20),
      numberRule("gte", 10), numberRule("gte", 15),
      numberRule("lte", 40), numberRule("lte", 30),
    ],
  };
  const pod = issueCriteriaPod(fullRequest, { hours: 20 }, issuerKey);
  const proof = await proveCriteria(pod, fullRequest, artifacts);
  expect(await verifyCriteria(proof, fullRequest, artifacts)).toBe(true);
});

it("cannot prove an empty intersection of ranges", async () => {
  const fullRequest = {
    ...request,
    criteria: [numberRule("gte", 40), numberRule("lte", 10)],
  };
  const pod = issueCriteriaPod(fullRequest, { hours: 5 }, issuerKey);
  await expect(proveCriteria(pod, fullRequest, artifacts)).rejects.toThrow();
});
