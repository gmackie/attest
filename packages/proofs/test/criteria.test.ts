import path from "node:path";
import { deriveSignerPublicKey } from "@pcd/pod";
import { expect, it } from "vitest";
import { commitValue } from "@attest/core";
import {
  issueCriteriaPod,
  proveCriteria,
  verifyCriteria,
  type CriteriaRequest,
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
});
