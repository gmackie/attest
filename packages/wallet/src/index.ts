import type { Attestation, AuthorityGraph, EvidenceRecord, Persona, PersonaId } from "@attest/domain";
import { evaluatePolicyEffect, type PolicyEvaluation, type RequirementProfile } from "@attest/policy";
import { matchesPattern } from "@attest/authority";
import { Effect } from "effect";

export class WalletError extends Error {
  readonly _tag = "WalletError";
}

export type PresentationContext = Readonly<{
  id: string;
  label: string;
  personaIds: readonly PersonaId[];
  allowedPredicatePatterns: readonly string[];
  mayBindGovernmentIdentity: boolean;
}>;

/**
 * Holder-controlled local evidence index. It deliberately stores no blockchain
 * address and does not make persona relationships public.
 */
export class PrivateEvidenceWallet {
  readonly rootId: string;
  readonly personas: ReadonlyMap<PersonaId, Persona>;
  readonly records: readonly EvidenceRecord[];

  constructor(
    rootId: string,
    personas: ReadonlyMap<PersonaId, Persona> = new Map(),
    records: readonly EvidenceRecord[] = []
  ) {
    this.rootId = rootId;
    this.personas = personas;
    this.records = records;
  }

  addPersona(persona: Persona): PrivateEvidenceWallet {
    if (this.personas.has(persona.id)) throw new WalletError(`Persona ${persona.id} already exists`);
    return new PrivateEvidenceWallet(this.rootId, new Map([...this.personas, [persona.id, persona]]), this.records);
  }

  ingest(attestation: Attestation, personaId?: PersonaId): PrivateEvidenceWallet {
    if (personaId !== undefined && !this.personas.has(personaId)) {
      throw new WalletError(`Unknown persona ${personaId}`);
    }
    if (this.records.some((record) => record.attestation.id === attestation.id)) {
      throw new WalletError(`Attestation ${attestation.id} already exists`);
    }
    const record: EvidenceRecord = {
      attestation,
      importedAt: new Date().toISOString(),
      ...(personaId === undefined ? {} : { sourcePersona: personaId })
    };
    return new PrivateEvidenceWallet(this.rootId, this.personas, [...this.records, record]);
  }

  private visibleAttestations(context: PresentationContext): readonly Attestation[] {
    const personas = new Set(context.personaIds);
    return this.records
      .filter((record) => record.sourcePersona === undefined || personas.has(record.sourcePersona))
      .map((record) => record.attestation)
      .map((attestation) => ({
        ...attestation,
        claims: Object.fromEntries(
          Object.entries(attestation.claims).filter(([predicate]) =>
            context.allowedPredicatePatterns.some((pattern) => matchesPattern(pattern, predicate))
          )
        )
      }))
      .filter((attestation) => Object.keys(attestation.claims).length > 0);
  }

  plan(
    context: PresentationContext,
    profile: RequirementProfile,
    authority: AuthorityGraph
  ): Effect.Effect<PolicyEvaluation, WalletError> {
    const unknown = context.personaIds.find((id) => !this.personas.has(id));
    if (unknown !== undefined) return Effect.fail(new WalletError(`Presentation context references unknown persona ${unknown}`));
    return evaluatePolicyEffect(profile, this.visibleAttestations(context), authority);
  }
}

export const createPersona = (
  id: PersonaId,
  label: string,
  allowedPredicatePatterns: readonly string[],
  identityDisclosure: Persona["identityDisclosure"] = "predicate-only"
): Persona => ({ id, label, allowedPredicatePatterns, identityDisclosure });

export const createPresentationContext = (
  id: string,
  label: string,
  personaIds: readonly PersonaId[],
  allowedPredicatePatterns: readonly string[],
  mayBindGovernmentIdentity = false
): PresentationContext => ({ id, label, personaIds, allowedPredicatePatterns, mayBindGovernmentIdentity });
