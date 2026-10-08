import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Badge,
  Banner,
  Button,
  Collapsible,
  InputGroup,
  LayerCard,
  Select,
} from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  DatabaseIcon,
  FingerprintIcon,
  FirstAidKitIcon,
  GraduationCapIcon,
  TruckIcon,
  PlayIcon,
  SealCheckIcon,
  WalletIcon,
} from "@phosphor-icons/react";
import { Effect } from "effect";
import {
  advanceIndustryRun,
  createIndustryRun,
  defaultIndustryInputs,
  industries,
  industrySteps,
  type Industry,
  type IndustryInputs,
  type IndustryRun,
  type FieldValue,
} from "@attest/demo";
const format = (value: unknown) => JSON.stringify(value, null, 2);
const fingerprint = (value?: string) =>
  value ? `${value.slice(0, 14)}…${value.slice(-8)}` : "Not created yet";
export const IndustryIcon = ({
  id,
  size = 28,
}: {
  id: string;
  size?: number;
}) =>
  id === "healthcare" ? (
    <FirstAidKitIcon size={size} />
  ) : id === "education" ? (
    <GraduationCapIcon size={size} />
  ) : id === "logistics" ? (
    <TruckIcon size={size} />
  ) : (
    <SealCheckIcon size={size} />
  );
function DataDrawer({ title, value }: { title: string; value: unknown }) {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger render={<Button size="sm" variant="ghost" />}>
        {title}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <pre>{format(value)}</pre>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
export function IndustryLab({ industry }: { industry: Industry }) {
  const [privateMode, setPrivateMode] = useState(true);
  const [inputs, setInputs] = useState<IndustryInputs>(() =>
    defaultIndustryInputs(industry),
  );
  const [run, setRun] = useState<IndustryRun>(() =>
    createIndustryRun(industry, defaultIndustryInputs(industry), true),
  );
  const [history, setHistory] = useState<IndustryRun[]>([]);
  const [selected, setSelected] = useState(0);
  const [focus, setFocus] = useState(industry.sources[0]!.id);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const current = useRef(run);
  const locked = useRef(false);
  const playingRef = useRef(false);
  const snapshot = history[selected] ?? run;
  const step = industrySteps[selected]!;
  const activeSource = industry.sources.find((s) => s.id === focus);
  const reset = (next = inputs, mode = privateMode) => {
    generation.current++;
    locked.current = false;
    playingRef.current = false;
    const fresh = createIndustryRun(industry, next, mode);
    current.current = fresh;
    setRun(fresh);
    setHistory([]);
    setSelected(0);
    setPlaying(false);
    setBusy(false);
    setError(null);
  };
  const change = (next: IndustryInputs) => {
    setInputs(next);
    reset(next);
  };
  const updateField = (source: string, field: string, value: FieldValue) =>
    change({
      ...inputs,
      [source]: {
        ...inputs[source]!,
        fields: { ...inputs[source]!.fields, [field]: value },
      },
    });
  const advance = async () => {
    if (locked.current || current.current.completed >= industrySteps.length)
      return;
    locked.current = true;
    setBusy(true);
    setSelected(current.current.completed);
    if (current.current.completed >= 3)
      setFocus(
        current.current.completed <= 4
          ? "wallet"
          : current.current.completed === 5
            ? "verifier"
            : "ledger",
      );
    const token = generation.current;
    const result = await Effect.runPromise(
      Effect.result(advanceIndustryRun(current.current)),
    );
    if (token !== generation.current) return;
    locked.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(result.failure.message);
      setPlaying(false);
      playingRef.current = false;
    } else {
      current.current = result.success;
      setRun(result.success);
      setHistory((h) => [...h, result.success]);
      if (result.success.completed === 7) {
        setPlaying(false);
        playingRef.current = false;
      }
    }
  };
  useEffect(() => {
    if (!playing || busy || error || run.completed >= 7) return;
    const timer = window.setTimeout(
      () => {
        if (playingRef.current) void advance();
      },
      run.completed ? 4000 : 150,
    );
    return () => window.clearTimeout(timer);
  }, [playing, busy, error, run.completed]);
  useEffect(
    () => () => {
      generation.current++;
      playingRef.current = false;
    },
    [],
  );
  const togglePlay = () => {
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
  };
  const loadFailure = () => {
    const defaults = defaultIndustryInputs(industry);
    const f = industry.failure;
    change({
      ...defaults,
      [f.source]: {
        ...defaults[f.source]!,
        fields: { ...defaults[f.source]!.fields, [f.field]: f.value },
      },
    });
    setFocus(f.source);
  };
  const issuerData = activeSource && snapshot.raw[activeSource.id];
  const credential =
    activeSource &&
    snapshot.issued.find((c) => c.claims.issuer === activeSource.id);
  const prepared =
    activeSource && snapshot.prepared.find((c) => c.issuer === activeSource.id);
  const pending = snapshot.completed <= selected;
  const allInstitutions = [
    ...industry.sources.map((s) => ({
      id: s.id,
      name: s.name,
      short: s.short,
      role: s.role,
    })),
    { id: "wallet", name: industry.holder, short: "W", role: "Holder wallet" },
    { id: "verifier", name: industry.verifier, short: "V", role: "Verifier" },
    {
      id: "ledger",
      name: "Receipt ledger",
      short: "#",
      role: "Blockchain simulation",
    },
  ];
  return (
    <section className={`industry-lab theme-${industry.color}`}>
      <div className="industry-hero">
        <div className="industry-orbit" aria-hidden="true">
          <div className="orbit-ring" />
          <div className="orbit-ring second" />
          <IndustryIcon id={industry.id} size={70} />
          {industry.sources.map((s, i) => (
            <span key={s.id} style={{ "--i": i } as CSSProperties}>
              {s.short}
            </span>
          ))}
        </div>
        <div>
          <Badge variant="outline">{industry.name} / live data journey</Badge>
          <h2>{industry.headline}</h2>
          <p>{industry.description}</p>
          <div className="industry-pills">
            <span>{industry.sources.length} independent issuers</span>
            <span>7 working stages</span>
            <span>{industry.rules.length} approval criteria</span>
          </div>
        </div>
      </div>
      <Banner
        variant="secondary"
        title={
          privateMode
            ? "Private approval with real zero-knowledge proofs"
            : "Disclosed credential comparison mode"
        }
        description={
          privateMode
            ? "Five issuer-specific GPC proofs establish the ten approval criteria. Exact values, dates and credential signatures stay in the wallet. Subject, holder public key, trusted issuer keys, thresholds and request challenge remain public. Equality checks imply their required value. POD/GPC is beta and unaudited."
            : "All signed claims are disclosed in comparison mode. Real signatures and request binding remain checked. These fictional systems exist only in browser memory."
        }
      />
      <section className="approval-sources">
        <div className="section-heading">
          <div>
            <span className="eyebrow">THE APPROVAL CONTRACT</span>
            <h3>
              {industry.sources.length} sources. {industry.rules.length}{" "}
              independent criteria.
            </h3>
          </div>
          <Badge variant="outline">
            {privateMode
              ? "Proven without exact values"
              : "Disclosed comparison"}
          </Badge>
        </div>
        <div className="approval-grid">
          {industry.sources.map((source) => (
            <LayerCard className="approval-card" key={source.id}>
              <div className="section-heading">
                <span className="actor-avatar">{source.short}</span>
                <Badge variant="secondary">
                  {privateMode ? "ZK proof" : "Signed record"}
                </Badge>
              </div>
              <h4>{source.name}</h4>
              <p>{source.role}</p>
              <ul>
                {industry.rules
                  .filter((r) => r.source === source.id)
                  .map((rule) => (
                    <li key={rule.field}>
                      <strong>{rule.label}</strong>
                      <code>
                        {rule.field}{" "}
                        {rule.operator === "eq"
                          ? "="
                          : rule.operator === "gte"
                            ? "≥"
                            : "≤"}{" "}
                        {String(rule.value)}
                      </code>
                    </li>
                  ))}
              </ul>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFocus(source.id);
                  document
                    .querySelector(".institution-console")
                    ?.scrollIntoView({
                      behavior: window.matchMedia(
                        "(prefers-reduced-motion: reduce)",
                      ).matches
                        ? "auto"
                        : "smooth",
                      block: "start",
                    });
                }}
              >
                Inspect source <ArrowRightIcon />
              </Button>
            </LayerCard>
          ))}
        </div>
        <p>
          Thresholds and required categories are public. Private proofs hide
          exact numerical values and expiry dates; equality criteria necessarily
          reveal that the required category or boolean is satisfied. This demo
          does not prove the underlying real-world truth of an issuer’s
          assertion.
        </p>
      </section>
      <LayerCard className="journey-control">
        <div>
          <span className="eyebrow">YOUR EXPERIMENT</span>
          <h3>{industry.purpose}</h3>
          <p>
            Edit the institution records, then follow every copy of the data.
          </p>
        </div>
        <div className="controls">
          <Button
            variant="primary"
            disabled={!!error || run.completed === 7}
            onClick={togglePlay}
          >
            <PlayIcon />
            {playing
              ? "Pause journey"
              : run.completed
                ? "Continue journey"
                : "Run data journey"}
          </Button>
          <Button
            variant="secondary"
            disabled={playing || busy || !!error || run.completed === 7}
            onClick={() => void advance()}
          >
            Next stage <ArrowRightIcon />
          </Button>
          <Button variant="ghost" onClick={() => reset()}>
            Reset journey
          </Button>
        </div>
      </LayerCard>
      <div className="journey-presets">
        <Select<string>
          label="Approval privacy"
          value={privateMode ? "private" : "disclosed"}
          items={[
            { label: "Private proofs · hide source values", value: "private" },
            { label: "Disclosed credentials · compare", value: "disclosed" },
          ]}
          disabled={busy || playing}
          onValueChange={(value) => {
            if (value) {
              setPrivateMode(value === "private");
              reset(inputs, value === "private");
            }
          }}
        />

        <span>TRY A SCENARIO</span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || playing}
          onClick={() => change(defaultIndustryInputs(industry))}
        >
          Successful {industry.id === "logistics" ? "shipment" : "application"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || playing}
          onClick={loadFailure}
        >
          {industry.failure.label}
        </Button>
        <Badge variant="secondary">Editing starts a fresh request</Badge>
      </div>
      <nav className="journey-stages" aria-label="Industry process stages">
        {industrySteps.map((s, index) => (
          <Button
            key={s.title}
            variant={selected === index ? "secondary" : "ghost"}
            disabled={index > run.completed || playing || busy}
            onClick={() => {
              setSelected(index);
              setFocus(
                index < 3
                  ? industry.sources[0]!.id
                  : index <= 4
                    ? "wallet"
                    : index === 5
                      ? "verifier"
                      : "ledger",
              );
            }}
            aria-current={selected === index ? "step" : undefined}
          >
            <span className="stage-index">{index < run.completed ? "✓" : `0${index + 1}`}</span>
            {s.title}
          </Button>
        ))}
      </nav>
      <div className="journey-workspace">
        <LayerCard className="institution-map">
          <div className="section-heading">
            <span className="eyebrow">WHERE THE DATA LIVES</span>
            <Badge variant="outline">{run.completed} / 7</Badge>
          </div>
          <p>
            Choose an institution to inspect its inputs, stored data and
            outbound messages.
          </p>
          <div className={`data-network ${playing || busy ? "moving" : ""}`}>
            <div className="source-nodes">
              {industry.sources.map((source) => (
                <Button
                  key={source.id}
                  variant={focus === source.id ? "secondary" : "outline"}
                  className={`actor-node ${selected < 3 ? "processing" : ""}`}
                  onClick={() => setFocus(source.id)}
                >
                  <span className="actor-avatar">
                    <DatabaseIcon size={19} />
                  </span>
                  <strong>{source.name}</strong>
                  <small>
                    {snapshot.raw[source.id]
                      ? "Source record stored"
                      : "Awaiting input"}
                  </small>
                  <span className="actor-count">
                    {snapshot.issued.some((c) => c.claims.issuer === source.id)
                      ? "1 signed credential"
                      : "0 credentials"}
                  </span>
                </Button>
              ))}
            </div>
            <div className="data-wires">
              <i />
              <i />
              <i />
              <span>
                {selected < 2
                  ? "Source → validated claims"
                  : selected === 2
                    ? "Issuer signatures → credentials"
                    : "Signed credential copies"}
              </span>
            </div>
            <Button
              className={`actor-node wallet-actor ${selected === 3 || selected === 4 ? "processing" : ""}`}
              variant={focus === "wallet" ? "secondary" : "outline"}
              onClick={() => setFocus("wallet")}
            >
              <WalletIcon size={29} />
              <span>
                <strong>{industry.holder}</strong>
                <small>
                  Private wallet · {snapshot.wallet.length} credentials
                </small>
              </span>
            </Button>
            <div className="data-wire">
              <i />
              <span>
                {snapshot.privateInbox
                  ? "Zero-knowledge proofs · values stay private"
                  : snapshot.inbox
                    ? "Signed claims + holder signature shared"
                    : "Holder chooses what to present"}
              </span>
            </div>
            <Button
              className={`actor-node verifier-actor ${selected === 5 ? "processing" : ""}`}
              variant={focus === "verifier" ? "secondary" : "outline"}
              onClick={() => setFocus("verifier")}
            >
              <SealCheckIcon size={29} />
              <span>
                <strong>{industry.verifier}</strong>
                <small>
                  {snapshot.receipt
                    ? snapshot.receipt.satisfied
                      ? "Verified · policy satisfied"
                      : "Verified · policy failed"
                    : snapshot.inbox || snapshot.privateInbox
                      ? "Presentation received"
                      : "Inbox empty"}
                </small>
              </span>
            </Button>
            <div className="data-wire">
              <i />
              <span>Only commitments + outcome</span>
            </div>
            <Button
              className="actor-node ledger-actor"
              variant={focus === "ledger" ? "secondary" : "outline"}
              onClick={() => setFocus("ledger")}
            >
              <span className="actor-avatar">#</span>
              <span>
                <strong>Receipt ledger</strong>
                <small>
                  {snapshot.ledger.length} simulated entries · no network
                  transaction
                </small>
              </span>
            </Button>
          </div>
        </LayerCard>
        <div className="journey-details">
          <LayerCard className="stage-explanation">
            <div className="section-heading">
              <Badge variant="outline">
                {pending ? "Up next" : "Completed"}
              </Badge>
              <span className="eyebrow">STAGE {selected + 1}</span>
            </div>
            <h3>
              {privateMode && selected === 4
                ? "Prove the approval criteria privately"
                : step.verb}
            </h3>
            <p>
              {privateMode && selected === 4
                ? "The wallet checks the criteria locally, then generates one real zero-knowledge proof per issuer. Failing criteria stop the flow without sharing source values. Proof generation can take a minute or longer on the first run."
                : privateMode && selected === 5
                  ? "The verifier checks every proof against its own source-specific policy, accepted issuer, subject, holder binding and challenge. It receives no raw credentials or exact field values."
                  : step.description.replace(/three|3 /g, (match) =>
                      match === "three" ? "five" : "5 ",
                    )}
            </p>
            <div className="stage-io">
              <div>
                <span>INPUT</span>
                <strong>
                  {
                    [
                      "Institution form fields",
                      "Stored source records",
                      "Validated credential claims",
                      "Signed issuer credentials",
                      "Wallet + fresh challenge",
                      privateMode
                        ? "Request-bound proof bundle"
                        : "Signed presentation",
                      "Local verification receipt",
                    ][selected]
                  }
                </strong>
              </div>
              <ArrowRightIcon />
              <div>
                <span>OUTPUT</span>
                <strong>
                  {
                    [
                      "Separate institution stores",
                      "Subject + schema + claims",
                      `${industry.sources.length} independent signatures`,
                      `${industry.sources.length} wallet copies`,
                      privateMode
                        ? "Five proofs; no source claims"
                        : "Verifier inbox",
                      "Checks + decision receipt",
                      "Simulated public ledger",
                    ][selected]
                  }
                </strong>
              </div>
            </div>
            {error && (
              <Banner
                variant="error"
                title="Stage stopped"
                description={error}
              />
            )}
            <div aria-live="polite">
              {busy ? (
                <p>
                  {privateMode && selected === 4
                    ? "Generating five real private proofs sequentially. This can take a minute or longer; no simulated completion."
                    : "Processing actual local data…"}
                </p>
              ) : (
                !pending && (
                  <p className="stage-status">
                    ✓ Stage completed. Inspect the resulting stores below.
                  </p>
                )
              )}
            </div>
          </LayerCard>
          <LayerCard className="institution-console">
            <div className="section-heading">
              <div>
                <span className="eyebrow">INSTITUTION WORKSPACE</span>
                <h3>{allInstitutions.find((a) => a.id === focus)?.name}</h3>
              </div>
              <Badge variant="secondary">
                {activeSource
                  ? "Issuer"
                  : "wallet" === focus
                    ? "Holder"
                    : focus === "verifier"
                      ? "Verifier"
                      : "Simulation"}
              </Badge>
            </div>
            {activeSource && (
              <>
                <div className="system-label">
                  <DatabaseIcon />
                  <span>{activeSource.system}</span>
                  <Badge variant="outline">Local memory</Badge>
                </div>
                <p className="console-intro">
                  Staff enter or import these values in this institution’s
                  source system. This form simulates that input. Internal notes
                  are stored here but never signed or sent.
                </p>
                <div className="source-form">
                  <InputGroup
                    label="Subject / record owner"
                    disabled={busy || playing}
                  >
                    <InputGroup.Input
                      value={inputs[activeSource.id]!.subject}
                      onChange={(e) =>
                        change({
                          ...inputs,
                          [activeSource.id]: {
                            ...inputs[activeSource.id]!,
                            subject: e.target.value,
                          },
                        })
                      }
                    />
                  </InputGroup>
                  {activeSource.fields.map((field) =>
                    field.type === "boolean" ? (
                      <Select<string>
                        key={field.id}
                        label={field.label}
                        value={String(
                          inputs[activeSource.id]!.fields[field.id],
                        )}
                        items={[
                          { label: "Yes", value: "true" },
                          { label: "No", value: "false" },
                        ]}
                        disabled={busy || playing}
                        onValueChange={(value) => {
                          if (value)
                            updateField(
                              activeSource.id,
                              field.id,
                              value === "true",
                            );
                        }}
                      />
                    ) : (
                      <InputGroup
                        key={field.id}
                        label={`${field.label}${field.unit ? ` (${field.unit})` : ""}`}
                        disabled={busy || playing}
                      >
                        <InputGroup.Input
                          type={
                            field.type === "number"
                              ? "number"
                              : field.type === "date"
                                ? "date"
                                : "text"
                          }
                          step={field.type === "number" ? "any" : undefined}
                          value={String(
                            inputs[activeSource.id]!.fields[field.id] ?? "",
                          )}
                          onChange={(e) =>
                            updateField(
                              activeSource.id,
                              field.id,
                              field.type === "number" && e.target.value !== ""
                                ? Number(e.target.value)
                                : e.target.value,
                            )
                          }
                        />
                      </InputGroup>
                    ),
                  )}
                  <InputGroup
                    label="Internal note — never shared"
                    disabled={busy || playing}
                  >
                    <InputGroup.Input
                      value={inputs[activeSource.id]!.internalNote}
                      onChange={(e) =>
                        change({
                          ...inputs,
                          [activeSource.id]: {
                            ...inputs[activeSource.id]!,
                            internalNote: e.target.value,
                          },
                        })
                      }
                    />
                  </InputGroup>
                </div>
                <div className="store-stats">
                  <span>
                    <strong>{issuerData ? 1 : 0}</strong> source records
                  </span>
                  <span>
                    <strong>{prepared ? 1 : 0}</strong> prepared claims
                  </span>
                  <span>
                    <strong>{credential ? 1 : 0}</strong> issued credentials
                  </span>
                </div>
                <div className="processing-pipeline">
                  <span className={issuerData ? "done" : ""}>Capture</span>
                  <ArrowRightIcon />
                  <span className={prepared ? "done" : ""}>Map schema</span>
                  <ArrowRightIcon />
                  <span className={credential ? "done" : ""}>Sign</span>
                  <ArrowRightIcon />
                  <span className={snapshot.wallet.length ? "done" : ""}>
                    Send copy
                  </span>
                </div>
                {credential && (
                  <div className="credential-stamp">
                    <FingerprintIcon size={25} />
                    <div>
                      <strong>
                        {activeSource.short} signed this credential
                      </strong>
                      <code>{fingerprint(credential.pod.signature)}</code>
                    </div>
                  </div>
                )}
                <DataDrawer
                  title="Inspect this institution’s stored source record"
                  value={issuerData ?? { state: "No source data saved yet" }}
                />
                <DataDrawer
                  title="Inspect mapped claims (note excluded)"
                  value={prepared ?? { state: "Claims have not been prepared" }}
                />
                <DataDrawer
                  title="Inspect issued credential + signature"
                  value={credential ?? { state: "Nothing has been signed" }}
                />
              </>
            )}
            {focus === "wallet" && (
              <>
                <div className="wallet-owner">
                  <WalletIcon size={40} />
                  <div>
                    <strong>{industry.holder}</strong>
                    <p>{industry.subject}</p>
                  </div>
                </div>
                <p>
                  The wallet stores credential copies from each issuer. Original
                  source records and internal notes remain in issuer stores. The
                  holder has a separate signing key for the presentation.
                </p>
                <code className="public-key-label">
                  Holder public key: {fingerprint(snapshot.holderPublicKey)}
                </code>
                <div className="stored-credentials">
                  {industry.sources.map((source) => {
                    const c = snapshot.wallet.find(
                      (c) => c.claims.issuer === source.id,
                    );
                    return (
                      <LayerCard key={source.id} className="stored-credential">
                        <div className="section-heading">
                          <strong>{source.name}</strong>
                          <Badge variant={c ? "success" : "outline"}>
                            {c ? "Stored" : "Not received"}
                          </Badge>
                        </div>
                        <p>{source.schema}</p>
                        {c && (
                          <>
                            <div className="claim-chips">
                              {Object.entries(c.claims.fields).map(
                                ([key, value]) => (
                                  <span key={key}>
                                    {key}
                                    <strong>{String(value)}</strong>
                                  </span>
                                ),
                              )}
                            </div>
                            <DataDrawer title="Inspect wallet copy" value={c} />
                          </>
                        )}
                      </LayerCard>
                    );
                  })}
                </div>
                <Banner
                  variant="secondary"
                  title={
                    privateMode
                      ? "Only proofs cross the privacy boundary"
                      : "This presentation discloses the signed claims"
                  }
                  description={
                    privateMode
                      ? "Issuer credentials supply private witnesses. The holder signs the proof bundle for this request. Exact values and signatures remain local; the verifier sees policies, context and proofs."
                      : "The holder signs the verifier challenge and a commitment to all five credentials. Exact values go to the verifier in this comparison mode."
                  }
                />
              </>
            )}
            {focus === "verifier" && (
              <>
                <div className="system-label">
                  <SealCheckIcon />
                  <span>Application inbox & decision engine</span>
                </div>
                <p>
                  Receives{" "}
                  {snapshot.privateInbox
                    ? `${snapshot.privateInbox.proofs.length} private proofs`
                    : `${snapshot.inbox?.credentials.length ?? 0} signed credentials`}
                  . Checks each against the expected issuer key, subject and
                  schema, then evaluates the following requirements.
                </p>
                <div className="verifier-rules">
                  {snapshot.checks.length
                    ? snapshot.checks.map((check) => (
                        <div key={check.label}>
                          <Badge
                            variant={check.satisfied ? "success" : "error"}
                          >
                            {check.satisfied ? "Pass" : "Fail"}
                          </Badge>
                          <span>
                            {check.label}
                            <small>{check.detail}</small>
                          </span>
                        </div>
                      ))
                    : industry.rules.map((rule) => (
                        <div key={rule.label}>
                          <Badge variant="outline">Pending</Badge>
                          <span>{rule.label}</span>
                        </div>
                      ))}
                </div>
                {snapshot.receipt && (
                  <Banner
                    variant={snapshot.receipt.satisfied ? "secondary" : "error"}
                    title={
                      snapshot.receipt.satisfied
                        ? "Application accepted by demo policy"
                        : "Application does not meet demo policy"
                    }
                    description="The outcome is computed from verified proofs or disclosed credentials, depending on the selected mode. These example policies do not represent a real institution’s requirements."
                  />
                )}
                <DataDrawer
                  title="Inspect exact verifier inbox"
                  value={
                    snapshot.privateInbox ??
                    snapshot.inbox ?? { state: "No presentation sent" }
                  }
                />
                <DataDrawer
                  title="Inspect decision receipt"
                  value={snapshot.receipt ?? { state: "Not evaluated" }}
                />
              </>
            )}
            {focus === "ledger" && (
              <>
                <div className="ledger-banner">
                  <span>#</span>
                  <div>
                    <strong>A public fingerprint, not a document store.</strong>
                    <p>
                      No credentials, private notes or secret keys are written
                      here.
                    </p>
                  </div>
                </div>
                <p>
                  The demonstration below models receipt event data. In this
                  repository, the contract emits a VerificationRecorded event
                  supplied by a caller; it does not independently verify this
                  presentation.
                </p>
                {snapshot.ledger.length ? (
                  snapshot.ledger.map((entry, index) => (
                    <div className="industry-block" key={index}>
                      <div className="section-heading">
                        <strong>Illustrative block 01</strong>
                        <Badge variant="outline">Local simulation</Badge>
                      </div>
                      {Object.entries(entry.receipt).map(([key, value]) => (
                        <div className="block-field" key={key}>
                          <span>{key}</span>
                          <code>
                            {typeof value === "string"
                              ? fingerprint(value)
                              : String(value)}
                          </code>
                        </div>
                      ))}
                      <DataDrawer
                        title="Inspect simulated receipt event"
                        value={entry}
                      />
                    </div>
                  ))
                ) : (
                  <Banner
                    title="No receipt entry yet"
                    description="Run the Anchor stage after verification to populate this local illustration."
                  />
                )}
                <p>
                  evidenceRoot hashes the proof-commitment set in private mode,
                  or the credential set in disclosed mode; it is not a Merkle
                  root. proofCommitment commits to the selected presentation.
                  The holder-derived nullifier is scoped to this request.
                </p>
              </>
            )}
          </LayerCard>
        </div>
      </div>
      <section className="data-ownership">
        <div className="section-heading">
          <div>
            <span className="eyebrow">EVERY COPY ACCOUNTED FOR</span>
            <h3>Who can see what?</h3>
          </div>
          <Badge variant="outline">At the selected stage</Badge>
        </div>
        <div className="ownership-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                {industry.sources.map((s) => (
                  <th key={s.id}>{s.short}</th>
                ))}
                <th>Wallet</th>
                <th>Verifier</th>
                <th>Ledger</th>
              </tr>
            </thead>
            <tbody>
              {industry.sources.map((source) => (
                <tr key={source.id}>
                  <th>{source.name} source + note</th>
                  {industry.sources.map((s) => (
                    <td key={s.id}>
                      {s.id === source.id && snapshot.raw[s.id]
                        ? "Stored"
                        : "—"}
                    </td>
                  ))}
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              ))}
              <tr>
                <th>Signed credential claims</th>
                {industry.sources.map((s) => (
                  <td key={s.id}>
                    {snapshot.issued.length ? "Own only" : "—"}
                  </td>
                ))}
                <td>
                  {snapshot.wallet.length
                    ? `All ${industry.sources.length}`
                    : "—"}
                </td>
                <td>
                  {snapshot.inbox ? `All ${industry.sources.length}` : "—"}
                </td>
                <td>—</td>
              </tr>
              <tr>
                <th>Private proof bundle</th>
                {industry.sources.map((s) => (
                  <td key={s.id}>—</td>
                ))}
                <td>{snapshot.privateInbox ? "Generated" : "—"}</td>
                <td>{snapshot.privateInbox ? "Proofs only" : "—"}</td>
                <td>—</td>
              </tr>
              <tr>
                <th>Decision commitments</th>
                {industry.sources.map((s) => (
                  <td key={s.id}>—</td>
                ))}
                <td>—</td>
                <td>{snapshot.receipt ? "Stored" : "—"}</td>
                <td>{snapshot.ledger.length ? "Simulated" : "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Logical institution boundaries inside one browser session. No remote
          databases, persistence after reload, or production access controls are
          implied.
        </p>
      </section>
    </section>
  );
}
