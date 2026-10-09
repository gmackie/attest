import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Collapsible,
  InputGroup,
  LayerCard,
  LinkButton,
  Select,
  Textarea,
} from "@cloudflare/kumo";
import { Effect } from "effect";
import {
  actors,
  actorNames,
  createWorkspace,
  disclosurePreview,
  documentYaml,
  inspectWorkspace,
  issuanceTemplate,
  parseWorkspaceDocument,
  requestDraft,
  runWorkspaceCommand,
  trustProfile,
  workspaceDocumentJsonSchema,
  workspaceSchema,
  type Actor,
  type RequestDocument,
  type Workspace,
  type WorkspaceCommand,
} from "@attest/demo";
const STORAGE = "attest-wallet-workspace-v1";
const json = (value: unknown) => JSON.stringify(value, null, 2);
function Inspector({ title, value }: { title: string; value: unknown }) {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger render={<Button variant="ghost" />}>
        {title}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <pre>{json(value)}</pre>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
function download(name: string, value: string, type = "application/yaml") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function WalletWorkspace() {
  const [state, setState] = useState<Workspace>(() => createWorkspace());
  const [actor, setActor] = useState<Actor>("jordan");
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [consent, setConsent] = useState(false);
  const [draft, setDraft] = useState<RequestDocument>(() => requestDraft());
  const [hours, setHours] = useState("36");
  const [jurisdiction, setJurisdiction] = useState("MI");
  const [licenseActive, setLicenseActive] = useState(true);
  const [validUntil, setValidUntil] = useState("");
  const [editor, setEditor] = useState("");
  const [docType, setDocType] = useState<"wallet" | "request" | "template">(
    "wallet",
  );
  const locked = useRef(false),
    saved = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void Effect.runPromise(
      Effect.try({
        try: () => {
          const stored = localStorage.getItem(STORAGE);
          const initial = stored
            ? workspaceSchema.parse(JSON.parse(stored))
            : createWorkspace();
          return { stored, initial };
        },
        catch: (cause) =>
          new Error(`Unable to load local wallet: ${String(cause)}`),
      }),
    )
      .then(({ stored, initial }) => {
        if (!active) return;
        saved.current = stored;
        setState(initial);
        setHours(String(initial.sources.trainingHours));
        setJurisdiction(initial.sources.jurisdiction);
        setLicenseActive(initial.sources.licenseActive);
        setReady(true);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const execute = async (command: WorkspaceCommand) => {
    if (locked.current || !ready) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const next = await Effect.runPromise(
        runWorkspaceCommand(state, actor, command),
      );
      await Effect.runPromise(
        Effect.try({
          try: () => {
            if (localStorage.getItem(STORAGE) !== saved.current)
              throw new Error(
                "Another tab changed this workspace. Reload before continuing.",
              );
            const encoded = json(next);
            localStorage.setItem(STORAGE, encoded);
            saved.current = encoded;
          },
          catch: (cause) =>
            new Error(`Unable to save wallet: ${String(cause)}`),
        }),
      );
      setState(next);
      setHours(String(next.sources.trainingHours));
      setJurisdiction(next.sources.jurisdiction);
      setLicenseActive(next.sources.licenseActive);
      setValidUntil(
        (actor === "board"
          ? next.sources.licenseValidUntil
          : next.sources.trainingValidUntil
        ).slice(0, 10),
      );
      setConsent(false);
      setNotice(next.history.at(-1)?.detail ?? "Saved");
      if (command.type === "request.create") setDraft(requestDraft());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const reset = async () => {
    if (locked.current) return;
    try {
      await Effect.runPromise(
        Effect.try({
          try: () => localStorage.removeItem(STORAGE),
          catch: (cause) => new Error(String(cause)),
        }),
      );
      saved.current = null;
      const next = createWorkspace();
      setState(next);
      setDraft(requestDraft());
      setHours("36");
      setJurisdiction("MI");
      setLicenseActive(true);
      setValidUntil("");
      setConsent(false);
      setReady(true);
      setError(null);
      setNotice("Started a fresh fictional network.");
    } catch (e) {
      setError(String(e));
    }
  };
  const switchActor = (value: Actor) => {
    setActor(value);
    setConsent(false);
    setEditor("");
    setNotice("");
    setError(null);
    setHours(String(state.sources.trainingHours));
    setJurisdiction(state.sources.jurisdiction);
    setLicenseActive(state.sources.licenseActive);
    setValidUntil(
      (value === "board"
        ? state.sources.licenseValidUntil
        : state.sources.trainingValidUntil
      ).slice(0, 10),
    );
  };
  const openDocument = (type: typeof docType) => {
    setDocType(type);
    const value =
      type === "wallet"
        ? state.wallets.find((w) => w.id === actor)
        : type === "request"
          ? draft
          : issuanceTemplate(state, actor as "board" | "training");
    setEditor(documentYaml(value));
  };
  const applyDocument = () => {
    try {
      const document = parseWorkspaceDocument(editor);
      void execute({
        type:
          docType === "wallet"
            ? "wallet.update"
            : docType === "request"
              ? "request.create"
              : "template.apply",
        document,
      });
    } catch (cause) {
      setError(String(cause));
    }
  };
  const request = state.request;
  const sent = request
    ? state.presentations.find((p) => p.requestId === request.id)
    : undefined;
  const decision = request
    ? state.decisions.filter((d) => d.requestId === request.id).at(-1)
    : undefined;
  const preview = request ? disclosurePreview(request) : null;
  const issuer = actor === "board" || actor === "training";
  const disabled = busy || !ready;
  const stage =
    !state.credentials.some((c) => c.issuer === "board") ||
    !state.credentials.some((c) => c.issuer === "training")
      ? 0
      : !request
        ? 1
        : !sent
          ? 2
          : !decision
            ? 3
            : 4;
  return (
    <section className="wallet-workspace" aria-label="Wallet workspace">
      <div className="wallet-hero">
        <div>
          <span className="eyebrow">
            YOUR WALLET. YOUR INSTITUTION. ONE TRUST JOURNEY.
          </span>
          <h1>
            Credentials you control.
            <br />
            <span>Decisions you can explain.</span>
          </h1>
          <p>
            Receive and share as Jordan. Issue as a board or training provider.
            Verify as the hospital. Every action uses the same engine as the
            CLI.
          </p>
        </div>
        <Badge variant="outline">Local, persistent demo</Badge>
      </div>
      <Banner
        title="A working sandbox, with explicit boundaries"
        description="Fictional records and public demo keys only. Participant switching simulates roles; it is not authentication. Browser storage is unencrypted and shared by these local workspaces. POD/GPC is beta and unaudited. No live institutions or blockchain transactions."
      />
      <div className="wallet-journey" aria-label="Journey progress">
        {[
          "Issue two credentials",
          "Create a request",
          "Review & share",
          "Verify independently",
          "Revoke & recheck",
        ].map((label, i) => (
          <div key={label} data-current={stage === i}>
            <span>{i + 1}</span>
            <strong>{label}</strong>
            <small>
              {i < stage ? "Completed" : i === stage ? "Next step" : "Then"}
            </small>
          </div>
        ))}
      </div>
      <div className="wallet-personas" aria-label="Choose a participant">
        {actors.map((value) => (
          <Button
            key={value}
            variant={actor === value ? "primary" : "secondary"}
            aria-pressed={actor === value}
            disabled={disabled}
            onClick={() => switchActor(value)}
          >
            <span>
              <strong>{actorNames[value]}</strong>
              <small>
                {value === "jordan"
                  ? "Personal wallet"
                  : value === "hospital"
                    ? "Verifier workspace"
                    : "Issuer workspace"}
              </small>
            </span>
          </Button>
        ))}
      </div>
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            {issuer
              ? "ORGANIZATION / ISSUANCE"
              : actor === "hospital"
                ? "ORGANIZATION / VERIFICATION"
                : "PERSONAL / HOLDER"}
          </span>
          <h2>{state.wallets.find((w) => w.id === actor)?.name}</h2>
        </div>
        <Badge variant="outline">{busy ? "Working…" : "Saved locally"}</Badge>
      </div>
      {error && (
        <div role="alert">
          <Banner title="Action could not complete" description={error} />
        </div>
      )}
      <p role="status" aria-live="polite">
        {busy
          ? "Processing locally. Private proof generation can take a little time; keep this page open."
          : notice}
      </p>
      {issuer && (
        <div className="infra-grid infra-two">
          <LayerCard className="infra-card">
            <Badge variant="outline">1 / Institution source record</Badge>
            <h3>
              {actor === "board" ? "Nursing license" : "Continuing education"}
            </h3>
            <p>
              Subject: Jordan Lee · clinician:jordan-lee. Save source changes
              before issuing. Existing credentials retain the values originally
              signed.
            </p>
            <div className="wallet-form">
              {actor === "board" ? (
                <>
                  <Checkbox
                    label="License is active"
                    checked={licenseActive}
                    disabled={disabled}
                    onCheckedChange={(value) =>
                      setLicenseActive(value === true)
                    }
                  />
                  <Select<string>
                    label="License jurisdiction"
                    value={jurisdiction}
                    disabled={disabled}
                    onValueChange={(value) => {
                      if (value) setJurisdiction(value);
                    }}
                  >
                    {["MI", "OH", "NY"].map((value) => (
                      <Select.Option key={value} value={value}>
                        {value}
                      </Select.Option>
                    ))}
                  </Select>
                  <p>The hospital recognizes this board for Michigan only.</p>
                </>
              ) : (
                <InputGroup
                  disabled={disabled}
                  label="Completed training hours"
                >
                  <InputGroup.Input
                    type="number"
                    min={0}
                    max={10000}
                    value={hours}
                    onChange={(e) => setHours(e.target.value)}
                  />
                </InputGroup>
              )}
              <InputGroup
                disabled={disabled}
                label="Credential valid through (date)"
              >
                <InputGroup.Input
                  type="date"
                  value={
                    validUntil ||
                    (actor === "board"
                      ? state.sources.licenseValidUntil
                      : state.sources.trainingValidUntil
                    ).slice(0, 10)
                  }
                  onChange={(e) => setValidUntil(e.target.value)}
                />
              </InputGroup>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() =>
                  void execute({
                    type: "sources.update",
                    records: {
                      ...state.sources,
                      ...(actor === "board"
                        ? {
                            licenseActive,
                            jurisdiction: jurisdiction as "MI" | "OH" | "NY",
                            licenseValidUntil: validUntil
                              ? `${validUntil}T00:00:00.000Z`
                              : state.sources.licenseValidUntil,
                          }
                        : {
                            trainingHours: hours === "" ? NaN : Number(hours),
                            trainingValidUntil: validUntil
                              ? `${validUntil}T00:00:00.000Z`
                              : state.sources.trainingValidUntil,
                          }),
                    },
                  })
                }
              >
                Save source record
              </Button>
            </div>
            <Inspector
              title="Preview the issuance template"
              value={issuanceTemplate(state, actor)}
            />
            <Button
              disabled={disabled}
              onClick={() => void execute({ type: "issue", approved: true })}
            >
              Approve & issue credential
            </Button>
            <p>
              This signs the saved record with this issuer’s demo key and
              delivers it to Jordan’s local wallet.
            </p>
          </LayerCard>
          <LayerCard className="infra-card">
            <Badge variant="outline">2 / Issuance & status</Badge>
            <h3>Issued credentials</h3>
            {state.credentials.filter((c) => c.issuer === actor).length ===
              0 && (
              <p>
                No credentials yet. Issue the first one from the saved source
                record.
              </p>
            )}
            {state.credentials
              .filter((c) => c.issuer === actor)
              .map((c) => (
                <div className="wallet-record" key={c.id}>
                  <strong>
                    Jordan Lee · {actor === "board" ? "License" : "Training"}
                  </strong>
                  <code>{c.id}</code>
                  <Badge variant="outline">
                    {state.statuses.find((s) => s.credentialId === c.id)
                      ?.state ?? "unknown"}
                  </Badge>
                  <Inspector title="Inspect signed credential" value={c} />
                  <Button
                    variant="secondary"
                    disabled={
                      disabled ||
                      state.statuses.find((s) => s.credentialId === c.id)
                        ?.state === "revoked"
                    }
                    onClick={() =>
                      void execute({
                        type: "revoke",
                        credentialId: c.id,
                        approved: true,
                      })
                    }
                  >
                    Revoke credential
                  </Button>
                </div>
              ))}
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void execute({ type: "status.refresh" })}
            >
              Refresh signed status
            </Button>
            <p>
              Revocation leaves the original signature intact. The verifier must
              check sufficiently fresh issuer status.
            </p>
          </LayerCard>
        </div>
      )}
      {actor === "jordan" && (
        <div className="infra-grid infra-two">
          <LayerCard className="infra-card">
            <Badge variant="outline">PERSONAL WALLET</Badge>
            <h3>Your credentials</h3>
            {!state.credentials.length && (
              <p>
                Your wallet is empty. Switch to Alder Nursing Board and Pine
                Training Institute to issue your first two credentials.
              </p>
            )}
            {state.credentials.map((c) => (
              <div className="wallet-record" key={c.id}>
                <strong>{actorNames[c.issuer]}</strong>
                <span>
                  {c.issuer === "board"
                    ? "Nursing license"
                    : "Training completion"}
                </span>
                <Badge variant="outline">
                  {state.statuses.find((s) => s.credentialId === c.id)?.state ??
                    "unknown"}
                </Badge>
                <code>{c.id}</code>
                <Inspector title="Inspect credential & signature" value={c} />
              </div>
            ))}
          </LayerCard>
          <LayerCard className="infra-card">
            <Badge variant="outline">REQUEST INBOX</Badge>
            <h3>
              {request
                ? "Willow Creek requests your qualifications"
                : "No requests yet"}
            </h3>
            {!request ? (
              <p>Switch to the hospital to create a placement request.</p>
            ) : (
              <>
                <p>{request.purpose}</p>
                <p>
                  Expires {new Date(request.expiresAt).toLocaleString()} ·{" "}
                  {request.disclosure === "private-proof"
                    ? "Private proof"
                    : "Full disclosed records"}
                </p>
                <div className="wallet-disclosure">
                  <h4>The hospital will learn</h4>
                  <ul>
                    {preview!.visible.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                  <h4>What stays private</h4>
                  <ul>
                    {preview!.hidden.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                  <p>{preview!.note}</p>
                </div>
                <Button
                  disabled={disabled || !!sent}
                  onClick={() => void execute({ type: "prepare" })}
                >
                  {request.disclosure === "private-proof"
                    ? "Prepare private proofs"
                    : "Prepare disclosed presentation"}
                </Button>
                <p>
                  Preparation checks local evidence and builds a preview.
                  Nothing is sent yet.
                </p>
                {state.prepared && (
                  <>
                    <Inspector
                      title="Inspect the exact prepared presentation"
                      value={state.prepared}
                    />
                    <Checkbox
                      label="I approve sharing the information listed above with Willow Creek Hospital."
                      checked={consent}
                      disabled={disabled}
                      onCheckedChange={(value) => setConsent(value === true)}
                    />
                    <Button
                      disabled={disabled || !consent}
                      onClick={() =>
                        void execute({ type: "send", approved: consent })
                      }
                    >
                      Send approved presentation
                    </Button>
                  </>
                )}
                {sent && (
                  <p>
                    Presentation sent. Switch to the hospital to verify it.
                    Sending again for this request is blocked.
                  </p>
                )}
              </>
            )}
          </LayerCard>
        </div>
      )}
      {actor === "hospital" && (
        <div className="infra-grid infra-two">
          <LayerCard className="infra-card">
            <Badge variant="outline">REQUEST BUILDER</Badge>
            <h3>Ask for the evidence you need</h3>
            <p>
              Require an active license and training for the same clinician. The
              board and training provider are accepted for separate schemas.
            </p>
            <div className="wallet-form">
              <InputGroup disabled={disabled} label="Purpose">
                <InputGroup.Input
                  value={draft.purpose}
                  onChange={(e) =>
                    setDraft({ ...draft, purpose: e.target.value })
                  }
                />
              </InputGroup>
              <InputGroup disabled={disabled} label="Minimum training hours">
                <InputGroup.Input
                  type="number"
                  min={1}
                  max={1000}
                  value={draft.requirements.minimumTrainingHours}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      requirements: {
                        ...draft.requirements,
                        minimumTrainingHours: Number(e.target.value),
                      },
                    })
                  }
                />
              </InputGroup>
              <Select<string>
                label="Required jurisdiction"
                value={draft.requirements.jurisdiction}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value)
                    setDraft({
                      ...draft,
                      requirements: {
                        ...draft.requirements,
                        jurisdiction: value as "MI" | "OH" | "NY",
                      },
                    });
                }}
              >
                {["MI", "OH", "NY"].map((value) => (
                  <Select.Option key={value} value={value}>
                    {value}
                  </Select.Option>
                ))}
              </Select>
              <Select<string>
                label="Presentation mode"
                value={draft.disclosure}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value)
                    setDraft({
                      ...draft,
                      disclosure: value as RequestDocument["disclosure"],
                    });
                }}
              >
                <Select.Option value="private-proof">
                  Private proof · hide exact values
                </Select.Option>
                <Select.Option value="disclosed-records">
                  Disclosed comparison · share full records
                </Select.Option>
              </Select>
              <Button
                disabled={disabled}
                onClick={() =>
                  void execute({ type: "request.create", document: draft })
                }
              >
                Create & sign request
              </Button>
            </div>
            <p>
              Requests expire after 24 hours by default. Both credentials must
              cover the expiry date. Use the YAML editor for subject, expiry and
              status freshness settings.
            </p>
            <Inspector
              title="Inspect accepted issuer keys and scopes"
              value={trustProfile}
            />
            {request && (
              <Inspector
                title="Inspect current signed request"
                value={{ document: request, signature: state.requestSignature }}
              />
            )}
          </LayerCard>
          <LayerCard className="infra-card">
            <Badge variant="outline">VERIFIER INBOX</Badge>
            <h3>
              {sent ? "A presentation is ready" : "Waiting for a presentation"}
            </h3>
            <p>
              {sent
                ? "Check signatures, recognized issuers, current status, and the exact request. Repeat verification after revocation to see the result change."
                : "Create a request, then have Jordan prepare and approve a presentation."}
            </p>
            <div className="controls">
              <Button
                disabled={disabled || !sent}
                onClick={() => void execute({ type: "verify" })}
              >
                {decision ? "Recheck presentation" : "Verify presentation"}
              </Button>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() =>
                  void execute({
                    type: "status.availability",
                    available: !state.statusAvailable,
                  })
                }
              >
                {state.statusAvailable
                  ? "Simulate status outage"
                  : "Restore status service"}
              </Button>
            </div>
            {sent && (
              <Inspector
                title="Inspect what the hospital actually received"
                value={sent}
              />
            )}
            {decision && (
              <div className="wallet-decision">
                <Badge variant="outline">
                  {decision.result.toUpperCase()} · checked{" "}
                  {new Date(decision.checkedAt).toLocaleTimeString()}
                </Badge>
                {decision.checks.map((check) => (
                  <div className="wallet-check" key={check.name}>
                    <div>
                      <strong>{check.name}</strong>
                      <Badge variant="outline">{check.result}</Badge>
                    </div>
                    <p>{check.detail}</p>
                  </div>
                ))}
                <p>
                  Historical result at the displayed time. Run another check
                  after evidence or status changes.
                </p>
                <Button
                  variant="secondary"
                  onClick={() =>
                    download("decision.yaml", documentYaml(decision))
                  }
                >
                  Download decision record
                </Button>
              </div>
            )}
          </LayerCard>
        </div>
      )}
      <LayerCard className="infra-card wallet-documents">
        <div className="section-heading">
          <div>
            <span className="eyebrow">HUMAN + LLM READABLE</span>
            <h3>One model. Forms, documents, and commands.</h3>
          </div>
          <Badge variant="outline">attest.dev/v1alpha1</Badge>
        </div>
        <p>
          Documents use a strict versioned schema. Unknown fields are rejected.
          Key references are identifiers, never private keys. Editing a wallet
          name cannot grant roles or authority.
        </p>
        <div className="controls">
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => openDocument("wallet")}
          >
            Edit wallet YAML
          </Button>
          {issuer && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => openDocument("template")}
            >
              Edit issuance template YAML
            </Button>
          )}
          {actor === "hospital" && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => openDocument("request")}
            >
              Edit new request YAML
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() =>
              download(
                "attest-documents.schema.json",
                json(workspaceDocumentJsonSchema),
                "application/json",
              )
            }
          >
            Download JSON Schema
          </Button>
        </div>
        {editor && (
          <div className="wallet-editor">
            <label htmlFor="wallet-document">
              {docType === "request"
                ? "New presentation request"
                : docType === "template"
                  ? "Issuance template"
                  : "Wallet manifest"}{" "}
              (YAML or JSON)
            </label>
            <Textarea
              id="wallet-document"
              value={editor}
              rows={18}
              disabled={disabled}
              onChange={(e) => setEditor(e.target.value)}
            />
            <div className="controls">
              <Button disabled={disabled} onClick={applyDocument}>
                {docType === "request"
                  ? "Validate & create request"
                  : "Validate & apply document"}
              </Button>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() => download(`${docType}.yaml`, editor)}
              >
                Download document
              </Button>
            </div>
          </div>
        )}
        <Collapsible.Root>
          <Collapsible.Trigger render={<Button variant="ghost" />}>
            Show equivalent CLI commands
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <pre>{`# From the repository; the CLI uses its own local state file.\npnpm attest init\npnpm attest inspect --actor ${actor} --json\npnpm attest document --actor ${actor}\n${issuer ? `pnpm attest template show --actor ${actor}\npnpm attest issue --actor ${actor} --approve\npnpm attest status refresh --actor ${actor}\npnpm attest revoke --actor ${actor} --credential ID --approve` : actor === "hospital" ? "pnpm --silent attest request draft > request.yaml\npnpm attest request create --actor hospital --file request.yaml\npnpm attest verify --actor hospital --json" : "pnpm attest prepare --actor jordan\npnpm attest inspect --actor jordan --json\npnpm attest send --actor jordan --approve"}\n# --agent permits inspection, preparation, and verification;\n# it cannot issue, send, revoke, or change configuration.`}</pre>
            <p>
              The browser and CLI share validation and operations, but do not
              synchronize storage. CLI actor selection is a demo role switch,
              not authentication.
            </p>
          </Collapsible.Panel>
        </Collapsible.Root>
        <Inspector
          title="Inspect this participant’s complete view"
          value={inspectWorkspace(state, actor)}
        />
      </LayerCard>
      <LayerCard className="infra-card">
        <h3>Your activity</h3>
        {state.history.filter((h) => h.actor === actor).length ? (
          <ol className="wallet-history">
            {state.history
              .filter((h) => h.actor === actor)
              .slice(-12)
              .reverse()
              .map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  <strong>{h.action}</strong>
                  <span>{h.detail}</span>
                  <small>{new Date(h.at).toLocaleString()}</small>
                </li>
              ))}
          </ol>
        ) : (
          <p>No activity for this participant yet.</p>
        )}
        <div className="controls">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void reset()}
          >
            Reset local demo
          </Button>
          <LinkButton href="#standards" variant="ghost">
            Explore the standards
          </LinkButton>
          <LinkButton href="#infrastructure" variant="ghost">
            Explore infrastructure
          </LinkButton>
        </div>
      </LayerCard>
    </section>
  );
}
