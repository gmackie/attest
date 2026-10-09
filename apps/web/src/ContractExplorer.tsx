import { useState } from "react";
import { Badge, Button, Collapsible, LayerCard } from "@cloudflare/kumo";
import {
  contractDocument,
  contractFor,
  clauseId,
  type Industry,
  type IndustryRun,
} from "@attest/demo";
export function ContractExplorer({
  industry,
  run,
  onSource,
}: {
  industry: Industry;
  run: IndustryRun;
  onSource: (id: string) => void;
}) {
  const [tab, setTab] = useState<"clauses" | "terms" | "document">("clauses");
  const contract = contractFor(industry);
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(contractDocument(industry), null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${industry.id}-${contract.level}-contract.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <LayerCard className="contract-explorer">
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            THE AGREEMENT / VERSION {contract.version}
          </span>
          <h3>{contract.title}</h3>
          <p>{contract.purpose}</p>
        </div>
        <Badge variant="outline">
          {contract.level} · {industry.rules.length} mandatory clauses
        </Badge>
      </div>
      <div className="contract-parties">
        <div>
          <span>APPLICANT / SUBJECT</span>
          <strong>{industry.holder}</strong>
          <code>{industry.subject}</code>
        </div>
        <div>
          <span>ACCEPTING PARTY</span>
          <strong>{industry.verifier}</strong>
          <code>Effective {contract.effectiveAt}</code>
        </div>
        <div>
          <span>APPROVAL LOGIC</span>
          <strong>ALL clauses must pass</strong>
          <code>5 independent source proofs</code>
        </div>
      </div>
      <div className="controls">
        {(["clauses", "terms", "document"] as const).map((t) => (
          <Button
            key={t}
            size="sm"
            variant={tab === t ? "secondary" : "ghost"}
            onClick={() => setTab(t)}
          >
            {t === "clauses"
              ? "Executable clauses"
              : t === "terms"
                ? "Scope & obligations"
                : "Contract JSON"}
          </Button>
        ))}
        <Button size="sm" variant="outline" onClick={download}>
          Download contract
        </Button>
      </div>
      {tab === "clauses" && (
        <div className="contract-clauses">
          {industry.rules.map((rule) => {
            const source = industry.sources.find((s) => s.id === rule.source)!;
            const check = run.checks.find((c) => c.label === rule.label);
            return (
              <Collapsible.Root key={`${rule.source}:${rule.field}`}>
                <Collapsible.Trigger
                  render={<Button variant="ghost" className="clause-trigger" />}
                >
                  <code>{clauseId(industry, rule)}</code>
                  <span>{rule.label}</span>
                  <Badge
                    variant={
                      check
                        ? check.satisfied
                          ? "success"
                          : "error"
                        : "outline"
                    }
                  >
                    {check
                      ? check.satisfied
                        ? "Verified"
                        : "Failed"
                      : "Not verified"}
                  </Badge>
                </Collapsible.Trigger>
                <Collapsible.Panel>
                  <div className="clause-body">
                    <p>
                      <strong>Required statement.</strong> {source.name} must
                      attest that <code>{rule.field}</code> for{" "}
                      <code>{industry.subject}</code>{" "}
                      {rule.operator === "eq"
                        ? "equals"
                        : rule.operator === "gte"
                          ? "is at least"
                          : "is at most"}{" "}
                      <strong>{String(rule.value)}</strong>.
                    </p>
                    <p>
                      <strong>Evidence.</strong> A credential under{" "}
                      <code>{source.schema}</code>, signed by this issuer and
                      bound to the same holder and subject.
                    </p>
                    <p>
                      <strong>Private enforcement.</strong>{" "}
                      {rule.operator === "eq"
                        ? "A membership constraint proves the required category or boolean. Passing therefore implies that value."
                        : "A range constraint proves the threshold without revealing the exact value."}{" "}
                      The proof is bound to the agreement and fresh request
                      challenge.
                    </p>
                    <p>
                      <strong>Failure consequence.</strong> This clause blocks
                      the entire approval. A different issuer’s record or
                      another subject’s facts cannot repair it.
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onSource(source.id)}
                    >
                      Inspect issuer statement
                    </Button>
                  </div>
                </Collapsible.Panel>
              </Collapsible.Root>
            );
          })}
        </div>
      )}
      {tab === "terms" && (
        <div className="contract-terms">
          {[
            ["Scope", contract.scope],
            ["Data handling", contract.retention],
            ["Re-evaluation trigger", contract.event],
            ["Outside this demo", contract.exclusion],
          ].map(([title, text]) => (
            <div key={title}>
              <h4>{title}</h4>
              <p>{text}</p>
            </div>
          ))}
          <p>
            <strong>Enforcement boundary:</strong> the numeric, date and
            categorical clauses are executable. Retention, future monitoring and
            re-evaluation duties are explanatory terms; no background monitoring
            or legal enforcement is implemented.
          </p>
        </div>
      )}
      {tab === "document" && (
        <pre>{JSON.stringify(contractDocument(industry), null, 2)}</pre>
      )}
      <p className="contract-footnote">
        The canonical contract document is hashed into the request challenge
        during Capture. Changing the agreement starts a fresh request. This is a
        fictional approval specification, not a legal agreement or an on-chain
        smart contract.
      </p>
    </LayerCard>
  );
}
