import {
  POD,
  POD_INT_MIN,
  POD_INT_MAX,
  type PODEntries,
  type PODValue,
} from "@pcd/pod";
import type { GPCProofConfig, GPCProofInputs } from "@pcd/gpc";
import { canonicalJson, commitValue } from "@attest/core";
import { GPC_ARTIFACTS_URL, type GpcProofEnvelope } from "./index";
export type PrivateCriterion = {
  field: string;
  operator: "eq" | "gte" | "lte";
  value: string | number | boolean;
  kind: "text" | "number" | "boolean" | "date";
};
export type CriteriaRequest = {
  contentID?: string;
  schema: string;
  subject: string;
  holderPublicKey: string;
  issuerPublicKey: string;
  challenge: string;
  criteria: readonly PrivateCriterion[];
};
export const criterionValue = (
  value: string | number | boolean,
  kind: PrivateCriterion["kind"],
): PODValue => {
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("Expected a finite numeric claim");
    const scaled = value * 1000;
    if (
      !Number.isSafeInteger(Math.round(scaled)) ||
      Math.abs(scaled - Math.round(scaled)) > 0.00001
    )
      throw new Error(
        "Numeric proof values support up to three decimal places",
      );
    return { type: "int", value: BigInt(Math.round(scaled)) };
  }
  if (kind === "date") {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw new Error("Expected a valid calendar date");
    return { type: "int", value: BigInt(Date.parse(value) / 86400000) };
  }
  if (kind === "boolean") {
    if (typeof value !== "boolean") throw new Error("Expected a boolean claim");
    return { type: "boolean", value };
  }
  if (typeof value !== "string") throw new Error("Expected a text claim");
  return { type: "string", value };
};
export const issueCriteriaPod = (
  request: CriteriaRequest,
  fields: Readonly<Record<string, string | number | boolean>>,
  key: string,
): POD => {
  const entries: PODEntries = {
    schema: { type: "string", value: request.schema },
    subject: { type: "string", value: request.subject },
    holder: { type: "eddsa_pubkey", value: request.holderPublicKey },
  };
  for (const c of request.criteria)
    entries[`claim_${c.field}`] = criterionValue(fields[c.field]!, c.kind);
  return POD.sign(entries, key);
};
const material = (r: CriteriaRequest) => {
  const config: GPCProofConfig = {
    pods: {
      credential: {
        entries: {
          schema: { isRevealed: false },
          subject: { isRevealed: false },
          holder: { isRevealed: false },
        },
        signerPublicKey: { isRevealed: false, isMemberOf: "issuers" },
        ...(r.contentID ? { contentID: { isRevealed: true } } : {}),
      },
    },
    tuples: {
      context: {
        entries: [
          "credential.schema",
          "credential.subject",
          "credential.holder",
        ],
        isMemberOf: "contexts",
      },
    },
  };
  const lists: NonNullable<GPCProofInputs["membershipLists"]> = {
    issuers: [{ type: "eddsa_pubkey", value: r.issuerPublicKey }],
    contexts: [
      [
        { type: "string", value: r.schema },
        { type: "string", value: r.subject },
        { type: "eddsa_pubkey", value: r.holderPublicKey },
      ],
    ],
  };
  r.criteria.forEach((c, index) => {
    const value = criterionValue(c.value, c.kind);
    const name = `claim_${c.field}`;
    if (c.operator === "eq") {
      const list = `rule_${index}`;
      lists[list] = [value];
      config.pods.credential!.entries[name] = {
        isRevealed: false,
        isMemberOf: list,
      };
    } else {
      if (value.type !== "int")
        throw new Error("Range criterion must be numeric or a date");
      config.pods.credential!.entries[name] = {
        isRevealed: false,
        inRange: {
          min: c.operator === "gte" ? value.value : POD_INT_MIN,
          max: c.operator === "lte" ? value.value : POD_INT_MAX,
        },
      };
    }
  });
  return { config, lists };
};
export async function proveCriteria(
  pod: POD,
  request: CriteriaRequest,
  artifacts = GPC_ARTIFACTS_URL,
): Promise<GpcProofEnvelope> {
  const gpc = await import("@pcd/gpc");
  const { config, lists } = material(request);
  const result = await gpc.gpcProve(
    config,
    {
      pods: { credential: pod },
      membershipLists: lists,
      watermark: { type: "string", value: request.challenge },
    },
    artifacts,
  );
  const serialized = {
    proof: result.proof,
    boundConfig: gpc.boundConfigToJSON(result.boundConfig),
    revealedClaims: gpc.revealedClaimsToJSON(result.revealedClaims),
  };
  return {
    version: "attest-gpc-v1",
    ...serialized,
    circuitIdentifier: result.boundConfig.circuitIdentifier,
    policyCommitment: await commitValue(request),
    proofCommitment: await commitValue(serialized),
  };
}
export async function verifyCriteria(
  envelope: GpcProofEnvelope,
  request: CriteriaRequest,
  artifacts = GPC_ARTIFACTS_URL,
): Promise<boolean> {
  try {
    const gpc = await import("@pcd/gpc");
    const { config, lists } = material(request);
    if (
      envelope.version !== "attest-gpc-v1" ||
      envelope.policyCommitment !== (await commitValue(request))
    )
      return false;
    const bound = gpc.boundConfigFromJSON(envelope.boundConfig),
      claims = gpc.revealedClaimsFromJSON(envelope.revealedClaims);
    if (
      request.contentID &&
      claims.pods.credential?.contentID?.toString() !== request.contentID
    )
      return false;
    if (
      canonicalJson(claims.membershipLists) !== canonicalJson(lists) ||
      canonicalJson(claims.watermark) !==
        canonicalJson({ type: "string", value: request.challenge })
    )
      return false;
    const expected = gpc.gpcBindConfig({
      ...config,
      circuitIdentifier: bound.circuitIdentifier,
    }).boundConfig;
    if (
      canonicalJson(envelope.boundConfig) !==
      canonicalJson(gpc.boundConfigToJSON(expected))
    )
      return false;
    if (
      envelope.proofCommitment !==
      (await commitValue({
        proof: envelope.proof,
        boundConfig: envelope.boundConfig,
        revealedClaims: envelope.revealedClaims,
      }))
    )
      return false;
    return gpc.gpcVerify(envelope.proof, bound, claims, artifacts);
  } catch {
    return false;
  }
}
