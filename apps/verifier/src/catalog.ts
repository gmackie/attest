/**
 * The verifier's own requirement catalog (static, reviewed in code).
 *
 * The canonical `definition` is what a proof request pins by digest. The issuer
 * policies next to it are this verifier's operational trust decisions; they are
 * NOT covered by the requirement digest, so changing an issuer from "pinned" to
 * "chain" authority does not change what Gatekeeper pins. Changing accepted
 * issuers or their keys does.
 */
import type { AuthorityAction, AuthorityGraph } from "@attest/domain";
import { defaultThresholds, demoAuthorityGraph } from "@attest/domains";
import { requirementDigest, type RequirementDefinition } from "@attest/verifier";

/**
 * - `pinned`: authority comes from a pinned authority graph evaluated at verification
 *   time. There is no on-chain grant and no credential-level revocation: status is
 *   issuer-level only, reported with `source: "registry"` evidence.
 * - `chain`: the issuer's grant (scope + signing-key commitment) is read from a
 *   WorkspaceRegistry on the configured chain, and the credential's status from its
 *   anchor, both at one settled block agreed by every RPC endpoint.
 */
export type IssuerPolicy =
  | {
      authority: "pinned";
      graph: AuthorityGraph;
      /** Issuer identity inside the graph (may differ from the accepted-issuer id). */
      graphIssuer: string;
      action: AuthorityAction;
      predicate: string;
      status: "issuer-level";
    }
  | {
      authority: "chain";
      chainId: number;
      registry: `0x${string}`;
      /** Issuer EVM account holding the grant. */
      account: `0x${string}`;
      /** commitValue(schema), as WorkspaceRegistry scopes are written. */
      scope: `0x${string}`;
      /** commitValue(issuer EdDSA public key). */
      signingKeyHash: `0x${string}`;
      status: "anchor";
    };

export interface CatalogEntry {
  definition: RequirementDefinition;
  title: string;
  /**
   * True when an accepted issuer is a published demo key. Anyone with the repository can
   * mint credentials it accepts; results are only meaningful as a protocol demonstration.
   */
  synthetic: boolean;
  notice: string;
  issuers: Record<string, IssuerPolicy>;
}
export type Catalog = ReadonlyMap<string, CatalogEntry>;

/**
 * Public key of the contractor-insurance domain pack's demo carrier
 * (`DEMO_INSURANCE_ISSUER_PRIVATE_KEY` in @attest/domains). Hard-coded so the
 * private key never enters the Worker bundle; a test checks the derivation.
 */
export const DEMO_CARRIER_PUBLIC_KEY = "NnGAciO/OIz+R5aYBlTUb+QwCgD5xossqB8gZtKLOxs";
export const DEMO_CARRIER_ID = "issuer:carrier";

const usd = (amount: bigint) => Number(amount);

export const cglMin2m: CatalogEntry = {
  title: "Commercial general liability: aggregate ≥ $2,000,000 and per occurrence ≥ $1,000,000",
  synthetic: true,
  notice:
    "Example profile from the contractor-insurance domain pack. It does not speak for ACORD, insurers or regulators. " +
    "The accepted issuer is the pack's demo carrier, whose signing key is published: treat results as demonstrations. " +
    "Proofs use POD/GPC, a beta, unaudited backend.",
  definition: {
    id: "insurance.cgl.min-2m",
    schema: "attest:insurance:cgl:v1",
    criteria: [
      { field: "aggregate", kind: "number", operator: "gte", value: usd(defaultThresholds.aggregateMinimumUsd) },
      { field: "per_occurrence", kind: "number", operator: "gte", value: usd(defaultThresholds.perOccurrenceMinimumUsd) },
    ],
    acceptedIssuers: [{ id: DEMO_CARRIER_ID, publicKey: DEMO_CARRIER_PUBLIC_KEY }],
  },
  issuers: {
    // No shared WorkspaceRegistry is deployed on Sepolia with a CGL issuer grant yet,
    // so authority is the domain pack's pinned graph (grant:carrier, insurance.*).
    [DEMO_CARRIER_ID]: {
      authority: "pinned",
      graph: demoAuthorityGraph,
      graphIssuer: "issuer:carrier",
      action: "issue",
      predicate: "insurance.cgl.aggregate",
      status: "issuer-level",
    },
  },
};

export const defaultCatalog: Catalog = new Map([[cglMin2m.definition.id, cglMin2m]]);

/** Every accepted issuer must carry an explicit policy, and no policy may be orphaned. */
export function assertCatalog(catalog: Catalog): void {
  for (const [id, entry] of catalog) {
    if (entry.definition.id !== id) throw new Error(`catalog id mismatch: ${id}`);
    const accepted = entry.definition.acceptedIssuers.map((i) => i.id).sort();
    const policies = Object.keys(entry.issuers).sort();
    if (accepted.join("\n") !== policies.join("\n")) throw new Error(`issuer policy mismatch: ${id}`);
  }
}

export async function catalogDigests(catalog: Catalog) {
  return Promise.all(
    [...catalog.values()].map(async (e) => ({
      id: e.definition.id,
      digest: await requirementDigest(e.definition),
      synthetic: e.synthetic,
    })),
  );
}
