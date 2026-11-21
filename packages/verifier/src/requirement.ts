/**
 * A requirement definition is owned by the verifier and pinned by digest in each
 * proof request. The criteria are never taken from the holder or the request
 * body, so a weaker or relabelled requirement cannot be substituted.
 */
import type {PrivateCriterion} from "@attest/proofs";
import {digestOf, isText, need, shape} from "./jws.ts";

export interface AcceptedIssuer {
  /** Stable issuer identifier, also passed to the authority check. */
  id: string;
  /** EdDSA (POD) credential-signing public key. */
  publicKey: string;
}
export interface RequirementDefinition {
  id: string;
  /** Credential schema the hidden fields must come from. */
  schema: string;
  criteria: PrivateCriterion[];
  acceptedIssuers: AcceptedIssuer[];
}

const operators = new Set(["eq", "gte", "lte"]), kinds = new Set(["text", "number", "boolean", "date"]);
export function parseRequirement(value: unknown): RequirementDefinition {
  shape(value, ["id", "schema", "criteria", "acceptedIssuers"]);
  need(isText(value.id, 256) && isText(value.schema, 256), "invalid_requirement");
  need(Array.isArray(value.criteria) && value.criteria.length > 0 && value.criteria.length <= 16, "invalid_requirement");
  const criteria = value.criteria.map(c => {
    shape(c, ["field", "operator", "value", "kind"]);
    need(typeof c.field === "string" && /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(c.field) &&
      operators.has(c.operator as string) && kinds.has(c.kind as string) &&
      ["string", "number", "boolean"].includes(typeof c.value), "invalid_requirement");
    return {field: c.field, operator: c.operator, value: c.value, kind: c.kind} as PrivateCriterion;
  });
  need(Array.isArray(value.acceptedIssuers) && value.acceptedIssuers.length > 0 &&
    value.acceptedIssuers.length <= 32, "invalid_requirement");
  const acceptedIssuers = value.acceptedIssuers.map(i => {
    shape(i, ["id", "publicKey"]);
    need(isText(i.id, 256) && isText(i.publicKey, 256), "invalid_requirement");
    return {id: i.id, publicKey: i.publicKey};
  });
  need(new Set(acceptedIssuers.map(i => i.id)).size === acceptedIssuers.length &&
    new Set(acceptedIssuers.map(i => i.publicKey)).size === acceptedIssuers.length, "invalid_requirement");
  return {id: value.id, schema: value.schema, criteria, acceptedIssuers};
}
export const requirementDigest = async (definition: RequirementDefinition): Promise<string> =>
  digestOf(parseRequirement(definition));
