import { useState } from "react";
import { Badge, Button, LayerCard, LinkButton } from "@cloudflare/kumo";

type Standard = {
  name: string;
  status: string;
  role: string;
  example: string;
  boundary: string;
  href: string;
  reference: string;
};
const layers: {
  name: string;
  question: string;
  handoff: string;
  standards: Standard[];
}[] = [
  {
    name: "Meaning & provenance",
    question: "What does the assertion mean, and where did it come from?",
    handoff: "Named concepts + source provenance → a coherent issuer assertion",
    standards: [
      {
        name: "RDF / JSON-LD",
        status: "Proposed alignment",
        role: "RDF describes linked statements using identifiers; JSON-LD expresses linked data in JSON. Shared identifiers let institutions refer to the same concepts without sharing one database.",
        example:
          "A training issuer identifies the clinician, course, and competency with explicit identifiers, instead of relying on an ambiguous field called status.",
        boundary:
          "The demo uses typed application objects, not an RDF graph or JSON-LD processor. Adding a context alone would not make these records interoperable or cryptographically secured.",
        href: "https://www.w3.org/TR/json-ld11/",
        reference: "JSON-LD 1.1",
      },
      {
        name: "PROV-O",
        status: "Proposed alignment",
        role: "The provenance ontology describes entities, activities, agents, attribution, and derivation. It explains which source and transformation produced an assertion.",
        example:
          "An imported training assertion records that a registrar derived it from a course completion record, preserving the original institution and observation date.",
        boundary:
          "Local evidence references retain provenance, but no PROV-O export is implemented. A provenance statement still needs authentication and an accepted issuer.",
        href: "https://www.w3.org/TR/prov-o/",
        reference: "W3C PROV-O",
      },
      {
        name: "SKOS",
        status: "Proposed alignment",
        role: "Concept schemes and mapping relationships let independently governed vocabularies be related without forcing every institution to adopt one taxonomy.",
        example:
          "A hospital maps a training provider’s course category to its requested competency, with a reviewed mapping and version.",
        boundary:
          "A close or broader mapping is not exact equivalence. The demo compares explicit values; it does not infer approval through SKOS mappings.",
        href: "https://www.w3.org/TR/skos-reference/",
        reference: "W3C SKOS",
      },
    ],
  },
  {
    name: "Shape & qualifications",
    question: "Which fields and domain concepts must an assertion contain?",
    handoff:
      "Versioned profile + domain vocabulary → structurally meaningful claims",
    standards: [
      {
        name: "SHACL",
        status: "Proposed alignment",
        role: "Shapes constrain RDF data: required properties, datatypes, cardinality, and other structural rules. They can describe a public assertion profile.",
        example:
          "A license shape could require one subject, a jurisdiction, license category, and expiry date before the credential enters the assurance workflow.",
        boundary:
          "The demo validates its own typed fields. It does not run a SHACL engine. Shape conformance does not prove an issuer’s authority or a hidden value’s correctness.",
        href: "https://www.w3.org/TR/shacl/",
        reference: "W3C SHACL",
      },
      {
        name: "Open Badges",
        status: "Proposed alignment",
        role: "Open Badges describes issued achievements, their earners, criteria, and supporting evidence. It provides an existing education credential model to profile or adapt.",
        example:
          "A course badge could provide the training assertion used in a clinical placement request, while the licensing board remains responsible for the license.",
        boundary:
          "The current training and education credentials are fictional POD-backed records, not Open Badges conformant credentials. An adapter must preserve achievement criteria and issuer provenance.",
        href: "https://www.1edtech.org/standards/open-badges",
        reference: "1EdTech Open Badges",
      },
      {
        name: "CTDL",
        status: "Proposed alignment",
        role: "Credential Transparency Description Language describes credentials, organizations, learning opportunities, competencies, and their relationships for discovery and comparison.",
        example:
          "A university could discover what a qualification represents and compare its requirements with an admissions profile before requesting holder evidence.",
        boundary:
          "A catalog description is not proof that a particular applicant earned a qualification. No CTDL registry integration or mapping is implemented.",
        href: "https://credreg.net/ctdl/handbook",
        reference: "CTDL handbook",
      },
      {
        name: "ACORD / SOC 2 / ISO 9001",
        status: "Domain examples only",
        role: "These are distinct domain ecosystems: ACORD supplies insurance data standards; AICPA SOC 2 concerns reporting on controls; ISO 9001 specifies quality management system requirements.",
        example:
          "Supplier approval combines insurance coverage, an in-scope SOC 2 assertion, and a current ISO 9001 certification assertion from separate fictional issuers.",
        boundary:
          "These are simplified example profiles, not ACORD document parsing, a SOC 2 examination, or ISO certification. No endorsement or conformance is claimed. The current supplier story proves twenty criteria across seven issuer-specific PODs.",
        href: "https://github.com/gmackie/attest/blob/feat/assurance-kernel-poc/packages/domains/src/index.ts",
        reference: "Inspect the domain profiles",
      },
    ],
  },
  {
    name: "Credentials & exchange",
    question:
      "How does an issuer deliver a credential, and a holder present it?",
    handoff:
      "Authenticated credential → holder wallet → request-bound presentation",
    standards: [
      {
        name: "W3C Verifiable Credentials",
        status: "Proposed alignment",
        role: "The VC data model describes issuer claims about subjects and presentations made to verifiers. A composition profile must also select compatible securing mechanisms and formats.",
        example:
          "A board could issue a license credential to a clinician’s wallet; the hospital requests a presentation that satisfies its placement requirements.",
        boundary:
          "The demo issues PODs and application-specific envelopes, not conformant W3C VCs. VC structure alone does not confer authority, privacy, or acceptance. A POD proof cannot automatically prove an arbitrary VC signature.",
        href: "https://www.w3.org/TR/vc-data-model-2.0/",
        reference: "VC Data Model 2.0",
      },
      {
        name: "OpenID4VCI",
        status: "Proposed alignment",
        role: "OpenID for Verifiable Credential Issuance defines a protocol for authorized delivery of credentials from an issuer to a wallet.",
        example:
          "A clinician authorizes the wallet to obtain an issued license from the board’s credential endpoint, instead of manually copying a record.",
        boundary:
          "Demo issuance is a local operation. There is no credential endpoint, authorization server, or OpenID issuance exchange. An integration must select credential formats and holder-binding rules.",
        href: "https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html",
        reference: "OpenID4VCI",
      },
      {
        name: "OpenID4VP",
        status: "Proposed alignment",
        role: "OpenID for Verifiable Presentations defines request and response flows between verifiers and wallets, with protocol protections and format-specific presentation handling.",
        example:
          "The hospital sends a presentation request; the wallet responds with supported evidence bound to the intended verifier and fresh request.",
        boundary:
          "The demo has local challenges and presentation checks, not an OpenID4VP exchange. Carrying GPC proofs would require a defined compatible format and profile, not merely putting proof JSON in a response.",
        href: "https://openid.net/specs/openid-4-verifiable-presentations-1_0.html",
        reference: "OpenID4VP",
      },
    ],
  },
  {
    name: "Authority & governance",
    question: "Why should this issuer be trusted for this particular claim?",
    handoff:
      "Recognized key + scoped authority + fresh metadata → accepted issuer set",
    standards: [
      {
        name: "ISO/IEC 11179 principles",
        status: "Proposed alignment",
        role: "Metadata registry principles inform stewardship, definitions, identifiers, registration, and lifecycle management for shared assertion schemas.",
        example:
          "A registry steward publishes a coverage field’s definition, unit, version, owner, and deprecation path so buyers do not compare incompatible amounts.",
        boundary:
          "This is a proposed governance influence, not an ISO/IEC 11179 compliant registry. The local schemas have no live registry lifecycle service.",
        href: "https://www.iso.org/standard/78914.html",
        reference: "ISO/IEC 11179-1",
      },
      {
        name: "Federation / recognized entities",
        status: "Proposed alignment",
        role: "Federation mechanisms can distribute authenticated entity metadata and trust relationships. Attest would add a profile for claim scope, delegation, jurisdiction, and effective time.",
        example:
          "A clearinghouse recognizes a board’s key for nursing licenses in a particular jurisdiction; an insurer’s recognized key remains limited to insurance assertions.",
        boundary:
          "No specific federation protocol is integrated. A directory entry or valid key does not grant unlimited issuing authority; the local authority engine applies explicit scoped rules.",
        href: "https://github.com/gmackie/attest/blob/feat/assurance-kernel-poc/specs/authority.md",
        reference: "Attest scoped authority proposal",
      },
    ],
  },
  {
    name: "Private assurance",
    question:
      "Can the holder establish the criteria without sending the source values?",
    handoff:
      "Signed private inputs + exact request → proof + public inputs → verification",
    standards: [
      {
        name: "POD",
        status: "Implemented backend",
        role: "Provable Object Data is the signed data format used by this implementation. Institutions sign structured entries that the selected proof backend can authenticate.",
        example:
          "Each fictional institution signs its own record. The holder keeps signed credentials and presents either private proofs or deliberately disclosed records.",
        boundary:
          "POD is an ecosystem format, not a claim of W3C VC conformance. A valid signature authenticates the issuer’s assertion, not the real-world truth of entered data. Demo keys are public.",
        href: "https://github.com/proofcarryingdata/zupass/tree/main/packages/lib/pod",
        reference: "POD implementation",
      },
      {
        name: "GPC / Groth16",
        status: "Implemented backend",
        role: "General Purpose Circuits compile supported constraints over PODs into zero-knowledge proofs using Groth16. The verifier checks the expected configuration, proof, and public-input bindings.",
        example:
          "Prove signed coverage meets a threshold without revealing its exact amount. All four industry stories generate separate issuer-specific proofs for their criteria.",
        boundary:
          "POD/GPC is beta and unaudited. Public thresholds, identifiers, and equality requirements can reveal information. Authority and live status are not automatically proven by these circuits; arbitrary graph queries are not supported.",
        href: "https://github.com/proofcarryingdata/zupass/tree/main/packages/lib/gpc",
        reference: "GPC implementation",
      },
      {
        name: "Semaphore V4 identity",
        status: "Implemented backend",
        role: "The legacy insurance adapter uses a Semaphore V4 identity for GPC holder ownership and a request-scoped nullifier. This demonstrates one holder-binding mechanism.",
        example:
          "The insurance proof binds the credential’s owner to the holder secret and derives a nullifier for the challenge, supporting application-level replay rejection.",
        boundary:
          "This is not a deployed Semaphore group or anonymous membership service. The current industry and connected flows use holder-key and signed-presentation bindings. WorkspaceRegistry enforces per-verifier request uniqueness, not Semaphore nullifiers.",
        href: "https://docs.semaphore.pse.dev/",
        reference: "Semaphore documentation",
      },
      {
        name: "Attest composition profile",
        status: "Local reference model",
        role: "The proposed addition ties coherent assertions, scoped authority, subject joins, verifier requirements, provenance, and minimum disclosure together without choosing a mandatory chain or credential ecosystem.",
        example:
          "A buyer requires all clauses for one subject while keeping the licensing board, training body, and employer responsible for their own distinct assertions.",
        boundary:
          "This is an incubation proposal, not an adopted standard. The local implementation covers a subset of the proposed proof algebra and needs independent implementations and conformance vectors.",
        href: "https://github.com/gmackie/attest/blob/feat/assurance-kernel-poc/specs/w3c-explainer.md",
        reference: "Read the composition proposal",
      },
    ],
  },
  {
    name: "Commitments & receipts",
    question: "What can be recorded for audit without publishing the evidence?",
    handoff:
      "Decision commitments → optional ledger record → independent interpretation",
    standards: [
      {
        name: "SHA-256 / local serialization",
        status: "Implemented backend",
        role: "Web Crypto SHA-256 hashes stable serialized application objects into commitments for requests, evidence, and policies.",
        example:
          "The full approval agreement is committed into a request so a presentation cannot silently switch its thresholds or descriptive terms.",
        boundary:
          "The project’s sorted JSON serializer is custom; it is not a claim of RFC 8785 or RDF canonicalization conformance. Interoperable commitments must pin serialization. Hashes do not encrypt predictable values.",
        href: "https://github.com/gmackie/attest/blob/feat/assurance-kernel-poc/packages/core/src/index.ts",
        reference: "Inspect commitment encoding",
      },
      {
        name: "EVM / Solidity ABI",
        status: "Reference + testnet workspace",
        role: "The Ethereum Virtual Machine executes the Solidity anchor contract. ABI encoding defines function arguments and event data; the contract uses Keccak-256 to derive receipt identifiers.",
        example:
          "An institution could submit a commitment and expiry to the anchor contract, while the buyer indexes a verification event for audit.",
        boundary:
          "Guided stories submit no transactions. The connected Sepolia workspace can deploy a separate scoped WorkspaceRegistry and anchor commitments through an EVM wallet. Both contracts record caller assertions without on-chain proof verification. SHA-256 application commitments and Keccak-256 contract receipt IDs serve different purposes; no ERC credential-token interface is implemented.",
        href: "https://docs.soliditylang.org/en/latest/abi-spec.html",
        reference: "Solidity ABI specification",
      },
    ],
  },
];

export function StandardsExplorer() {
  const [layerIndex, setLayerIndex] = useState(0);
  const [standardIndex, setStandardIndex] = useState(0);
  const layer = layers[layerIndex]!;
  const standard = layer.standards[standardIndex]!;
  return (
    <section
      id="standards"
      className="infrastructure-explorer standards-explorer"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">THE COMPOSITION MAP</span>
          <h2>
            Existing standards.
            <br />
            One assurance journey.
          </h2>
        </div>
        <Badge variant="outline">
          {layers.length} layers ·{" "}
          {layers.reduce((count, layer) => count + layer.standards.length, 0)}{" "}
          building blocks
        </Badge>
      </div>
      <p className="infra-intro">
        Meaning, credentials, exchange, trust, proofs, and receipts solve
        different problems. Explore how Attest proposes to connect them—and
        which parts this demo actually runs.
      </p>
      <p>
        This map includes formal standards, domain frameworks, ecosystem
        protocols, and reference code. “Proposed alignment” means an integration
        target, not implemented conformance or certification.
      </p>
      <div className="standards-map" aria-label="Composition layers">
        {layers.map((item, i) => (
          <Button
            key={item.name}
            variant={layerIndex === i ? "primary" : "secondary"}
            aria-pressed={layerIndex === i}
            onClick={() => {
              setLayerIndex(i);
              setStandardIndex(0);
            }}
          >
            <span>
              {i + 1}. {item.name}
            </span>
          </Button>
        ))}
      </div>
      <div className="infra-content">
        <div>
          <span className="eyebrow">
            LAYER {layerIndex + 1} / {layer.name}
          </span>
          <h3>{layer.question}</h3>
          <p className="infra-boundary">{layer.handoff}</p>
        </div>
        <div className="controls" aria-label="Standards in selected layer">
          {layer.standards.map((item, i) => (
            <Button
              key={item.name}
              variant={standardIndex === i ? "primary" : "secondary"}
              aria-pressed={standardIndex === i}
              onClick={() => setStandardIndex(i)}
            >
              {item.name}
            </Button>
          ))}
        </div>
        <LayerCard className="infra-detail" key={standard.name}>
          <Badge variant="outline">{standard.status}</Badge>
          <h3>{standard.name}</h3>
          <p>{standard.role}</p>
          <div className="infra-facts">
            <div>
              <h4>In an assurance journey</h4>
              <p>{standard.example}</p>
            </div>
            <div>
              <h4>Implementation boundary</h4>
              <p>{standard.boundary}</p>
            </div>
          </div>
          <LinkButton href={standard.href} variant="secondary">
            {standard.reference} ↗
          </LinkButton>
        </LayerCard>
        <div className="controls">
          <Button
            variant="secondary"
            disabled={layerIndex === 0}
            onClick={() => {
              setLayerIndex(layerIndex - 1);
              setStandardIndex(0);
            }}
          >
            Previous layer
          </Button>
          <Button
            disabled={layerIndex === layers.length - 1}
            onClick={() => {
              setLayerIndex(layerIndex + 1);
              setStandardIndex(0);
            }}
          >
            Next layer
          </Button>
        </div>
        <LayerCard className="infra-card">
          <h3>The handoffs are the work</h3>
          <p>
            A proposed clinical integration could describe a training
            achievement with Open Badges, preserve derivation with PROV-O, align
            competency concepts with SKOS, constrain its shape with SHACL, issue
            a secured VC through OpenID4VCI, and request a supported
            presentation through OpenID4VP. A governed registry supplies scoped
            issuer trust; a compatible proof backend checks private criteria; an
            optional EVM receipt records commitments.
          </p>
          <p>
            That complete standards path is not implemented here. Importing a VC
            or badge into POD would need a reviewed adapter: re-signing creates
            a new issuer assertion and trust dependency unless the original
            signature is independently verified by the chosen proof system.
            Semantic mappings, proof formats, status freshness, and subject
            bindings must be agreed at every handoff.
          </p>
          <LinkButton
            href="https://github.com/gmackie/attest/blob/feat/assurance-kernel-poc/specs/w3c-explainer.md"
            variant="ghost"
          >
            Read the standards composition proposal ↗
          </LinkButton>
        </LayerCard>
      </div>
    </section>
  );
}
