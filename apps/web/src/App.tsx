import { CryptoExplainer } from "./CryptoExplainer";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Collapsible,
  InputGroup,
  LayerCard,
  LinkButton,
  Select,
} from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  FingerprintIcon,
  PlayIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import { Effect } from "effect";
import {
  advanceRun,
  byRole,
  buyerThresholds,
  checkReplay,
  createRun,
  defaultConfig,
  institution,
  institutions,
  publicPresentation,
  scenarios,
  steps,
  type DemoConfig,
  type DemoRun,
  type DemoStepError,
} from "@attest/demo";

const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
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
export function App() {
  const [config, setConfig] = useState<DemoConfig>(defaultConfig);
  const [run, setRun] = useState<DemoRun>(() => createRun(defaultConfig));
  const [history, setHistory] = useState<DemoRun[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<DemoStepError | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  const generation = useRef(0);
  const executing = useRef(false);
  const autoRef = useRef(false);
  const current = useRef(run);
  const step = steps[selected]!;
  const snapshot = history[selected];
  const reset = (next = config) => {
    generation.current++;
    autoRef.current = false;
    executing.current = false;
    const fresh = createRun(next);
    current.current = fresh;
    setRun(fresh);
    setHistory([]);
    setSelected(0);
    setBusy(false);
    setAuto(false);
    setError(null);
    setReplay(null);
  };
  const change = (next: DemoConfig) => {
    setConfig(next);
    reset(next);
  };
  const advance = async () => {
    if (executing.current || current.current.completed === steps.length) return;
    executing.current = true;
    const token = generation.current;
    const before = current.current;
    setSelected(before.completed);
    setBusy(true);
    setError(null);
    const result = await Effect.runPromise(Effect.result(advanceRun(before)));
    if (token !== generation.current) return;
    executing.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      setError(result.failure);
      autoRef.current = false;
      setAuto(false);
    } else {
      current.current = result.success;
      setRun(result.success);
      setHistory((h) => [...h, result.success]);
      if (result.success.completed === steps.length) {
        autoRef.current = false;
        setAuto(false);
      }
    }
  };
  useEffect(() => {
    if (!auto || busy || error || run.completed === steps.length) return;
    const timer = window.setTimeout(
      () => {
        if (autoRef.current) void advance();
      },
      run.completed ? 6500 : 100,
    );
    return () => window.clearTimeout(timer);
  }, [auto, busy, run.completed, error]);
  useEffect(
    () => () => {
      generation.current++;
      autoRef.current = false;
    },
    [],
  );
  const toggleAuto = () => {
    autoRef.current = !autoRef.current;
    setAuto(autoRef.current);
  };
  const testReplay = async () => {
    const token = generation.current;
    setReplay("Checking a different request challenge…");
    const result = await Effect.runPromise(Effect.result(checkReplay(run)));
    if (token === generation.current)
      setReplay(
        result._tag === "Failure"
          ? result.failure.message
          : result.success
            ? "Unexpected verification success"
            : "Rejected. This proof cannot be reused for a different request challenge.",
      );
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([json(publicPresentation(run))], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "attest-presentation.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  const evaluation =
    selected === run.completed && error?.evaluation
      ? error.evaluation
      : snapshot?.evaluation;
  return (
    <div className="app">
      <header className="topbar">
        <a href="#" className="brand">
          <FingerprintIcon size={27} weight="bold" />
          attest<span>NETWORK LAB</span>
        </a>
        <div>
          <Badge variant="secondary">Interactive demo</Badge>
          <LinkButton
            href="https://github.com/gmackie/attest/pull/1"
            variant="ghost"
            size="sm"
          >
            Source ↗
          </LinkButton>
        </div>
      </header>
      <main>
        <section className="hero">
          <div>
            <div className="eyebrow">PRIVATE EVIDENCE. PUBLIC CONFIDENCE.</div>
            <h1>
              Trust travels.
              <br />
              <span>Your evidence stays private.</span>
            </h1>
            <p>
              Build a network of institutions. Issue signed credentials. Follow
              a real proof from a supplier’s wallet to a buyer’s decision.
            </p>
          </div>
          <div className="hero-stat">
            <strong>15</strong>
            <span>fictional institutions</span>
            <strong>7</strong>
            <span>working stages</span>
          </div>
        </section>
        <Banner
          variant="secondary"
          title="A working, local sandbox"
          description="All institutions and credentials are fictional. Demo keys are public. Insurance uses a real POD / GPC proof; SOC 2 and ISO 9001 use local signed-record checks. The proof backend is beta and unaudited."
        />
        <section className="workspace">
          <LayerCard className="configuration">
            <div className="section-heading">
              <span className="eyebrow">01 / SET THE SCENE</span>
              <Badge variant="outline">In your browser</Badge>
            </div>
            <h2>Your assurance network</h2>
            <p>
              Switch participants, then test a successful onboarding or a
              failure at its actual boundary.
            </p>
            <div className="config-grid">
              {(
                [
                  "supplier",
                  "buyer",
                  "insurer",
                  "auditor",
                  "certifier",
                ] as const
              ).map((role) => (
                <Select<string>
                  key={role}
                  label={
                    role === "certifier"
                      ? "Certification body"
                      : role.charAt(0).toUpperCase() + role.slice(1)
                  }
                  value={config[role]}
                  items={byRole(role).map((i) => ({
                    label: i.name,
                    value: i.id,
                  }))}
                  disabled={busy || auto}
                  onValueChange={(value) => {
                    if (value) {
                      const limits =
                        role === "buyer" ? buyerThresholds[value] : undefined;
                      change({
                        ...config,
                        [role]: value,
                        ...(limits
                          ? { aggregate: limits[0], occurrence: limits[1] }
                          : {}),
                      });
                    }
                  }}
                />
              ))}
              <Select<string>
                label="Scenario"
                value={config.scenario}
                items={scenarios.map((s) => ({ label: s.label, value: s.id }))}
                disabled={busy || auto}
                onValueChange={(value) => {
                  if (value)
                    change({
                      ...config,
                      scenario: value as DemoConfig["scenario"],
                    });
                }}
              />
              <InputGroup
                label="Aggregate minimum (USD)"
                disabled={busy || auto}
              >
                <InputGroup.Input
                  type="number"
                  min={0}
                  step={1000000}
                  value={config.aggregate}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isSafeInteger(n) && n >= 0)
                      change({ ...config, aggregate: n });
                  }}
                />
              </InputGroup>
              <InputGroup label="Per occurrence (USD)" disabled={busy || auto}>
                <InputGroup.Input
                  type="number"
                  min={0}
                  step={1000000}
                  value={config.occurrence}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isSafeInteger(n) && n >= 0)
                      change({ ...config, occurrence: n });
                  }}
                />
              </InputGroup>
            </div>
            <p className="scenario-note">
              {scenarios.find((s) => s.id === config.scenario)?.description}
            </p>
          </LayerCard>
        </section>
        <LayerCard className="walkthrough">
          <div className="section-heading">
            <div>
              <span className="eyebrow">02 / RUN THE PROTOCOL</span>
              <h2>See what makes trust work.</h2>
            </div>
            <div className="controls">
              <Button
                variant="primary"
                onClick={toggleAuto}
                disabled={!!error || run.completed === 7}
              >
                {auto ? (
                  "Pause walkthrough"
                ) : run.completed ? (
                  "Continue walkthrough"
                ) : (
                  <>
                    <PlayIcon />
                    Run walkthrough
                  </>
                )}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void advance()}
                disabled={busy || auto || !!error || run.completed === 7}
              >
                Next step <ArrowRightIcon />
              </Button>
              <Button variant="ghost" onClick={() => reset()}>
                Reset
              </Button>
            </div>
          </div>
          <nav className="step-list" aria-label="Walkthrough steps">
            {steps.map((s, index) => (
              <Button
                key={s.title}
                variant={selected === index ? "secondary" : "ghost"}
                className="step-button"
                disabled={index > run.completed || auto || busy}
                onClick={() => setSelected(index)}
              >
                <span
                  className={`step-number ${index < run.completed ? "done" : ""}`}
                >
                  {index < run.completed
                    ? "✓"
                    : String(index + 1).padStart(2, "0")}
                </span>
                <span>
                  {s.title}
                  <small>{s.actor}</small>
                </span>
              </Button>
            ))}
          </nav>
          <div className="walkthrough-layout">
            {" "}
            <LayerCard className="flow-card">
              <div className="section-heading">
                <span className="eyebrow">THE LIVE NETWORK</span>
                <Badge variant={run.receipt ? "success" : "secondary"}>
                  {run.completed} / 7 complete
                </Badge>
              </div>
              <div
                className={`network ${busy || auto ? "animating" : ""}`}
                aria-label="Authority roots authorize issuers. Issuers sign records for the private wallet. The wallet presents a proof to the buyer."
              >
                <div
                  className={`network-roots ${selected === 2 ? "active" : ""}`}
                >
                  <ShieldCheckIcon size={23} />
                  <div>
                    <strong>Three accepted trust roots</strong>
                    <small>Insurance · Audit · Quality → Meridian</small>
                  </div>
                </div>
                <div className="vertical-link" />
                <div className="issuer-row">
                  {(["insurer", "auditor", "certifier"] as const).map(
                    (role) => (
                      <div
                        key={role}
                        className={`network-node ${selected === 1 || selected === 2 ? "active" : ""}`}
                      >
                        <span className="node-monogram">
                          {institution(config[role]).short}
                        </span>
                        <strong>{institution(config[role]).name}</strong>
                        <small>{role}</small>
                      </div>
                    ),
                  )}
                </div>
                <div className="transfer">
                  <span /> <span /> <span />
                  <small>Signed private credentials</small>
                </div>
                <div
                  className={`wallet-node ${selected >= 3 && selected <= 5 ? "active" : ""}`}
                >
                  <FingerprintIcon size={34} />
                  <div>
                    <strong>{institution(config.supplier).name}</strong>
                    <small>Private wallet · compliance persona</small>
                  </div>
                  <Badge variant="outline">
                    {run.wallet ? "3 records" : "Awaiting records"}
                  </Badge>
                </div>
                <div className="proof-transfer">
                  <div className="vertical-link" />
                  <span>
                    {selected >= 5
                      ? "Insurance proof + public request"
                      : "Only the proof crosses this boundary"}
                  </span>
                </div>
                <div
                  className={`buyer-node ${selected === 0 || selected === 6 ? "active" : ""}`}
                >
                  <ShieldCheckIcon size={26} />
                  <div>
                    <strong>{institution(config.buyer).name}</strong>
                    <small>
                      {run.receipt
                        ? "Insurance proof verified"
                        : "Buyer · independent verification"}
                    </small>
                  </div>
                  {run.receipt && <CheckCircleIcon size={24} weight="fill" />}
                </div>
              </div>
            </LayerCard>
            <div className="step-detail" key={selected}>
              <div className="section-heading">
                <Badge variant="outline">{step.component}</Badge>
                <span className="eyebrow">STEP {selected + 1} OF 7</span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.explanation}</p>
              <div className="boundary">
                <ShieldCheckIcon size={20} />
                <span>{step.boundary}</span>
              </div>
              <div aria-live="polite" className="step-result">
                {busy && selected === run.completed ? (
                  <Banner
                    title={
                      selected === 5
                        ? "Computing the real proof…"
                        : "Running this stage…"
                    }
                    description={
                      selected === 5
                        ? "The first proof downloads circuit artifacts. Computation may take a moment; completion follows the actual prover result."
                        : "The next stage starts only when this operation succeeds."
                    }
                  />
                ) : error && selected === run.completed ? (
                  <Banner
                    variant="error"
                    title="Stopped at the boundary"
                    description={error.message}
                  />
                ) : snapshot ? (
                  <Banner
                    variant="secondary"
                    title="Stage complete"
                    description={snapshot.events[selected]?.message}
                  />
                ) : (
                  <p>
                    Ready when you are. Choose Next step or run the animated
                    walkthrough.
                  </p>
                )}
              </div>
              <CryptoExplainer
                key={`${run.id}:${selected}`}
                step={selected}
                run={snapshot ?? run}
              />
              {selected === 0 && snapshot && (
                <Inspector
                  title="Inspect the buyer request"
                  value={snapshot.requirement}
                />
              )}
              {selected === 1 && snapshot && (
                <Inspector
                  title="Reveal private signed records"
                  value={snapshot.records}
                />
              )}
              {selected === 2 && snapshot && (
                <Inspector
                  title="Inspect authority paths"
                  value={snapshot.authority}
                />
              )}
              {selected === 3 && snapshot && (
                <p className="caption">
                  3 records · insurance, SOC 2, ISO 9001 · compliance persona
                  only
                </p>
              )}
              {selected === 4 && evaluation && (
                <>
                  <div className="policy-results">
                    {evaluation.leaves.map((leaf) => (
                      <div key={leaf.id}>
                        <Badge variant={leaf.satisfied ? "success" : "error"}>
                          {leaf.satisfied ? "Pass" : "Fail"}
                        </Badge>
                        <span>
                          {leaf.label}
                          {leaf.reason && <small>{leaf.reason}</small>}
                        </span>
                      </div>
                    ))}
                  </div>
                  <Inspector
                    title="Inspect every policy result"
                    value={evaluation}
                  />
                </>
              )}
              {selected === 5 && snapshot && (
                <Inspector
                  title="Inspect the generated proof"
                  value={snapshot.proof}
                />
              )}
              {selected === 6 && snapshot?.receipt && (
                <>
                  <div className="controls">
                    <Button onClick={download}>
                      Download public presentation
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void testReplay()}
                    >
                      Test replay rejection
                    </Button>
                  </div>
                  {replay && <p role="status">{replay}</p>}
                  <Inspector
                    title="Inspect the local receipt"
                    value={snapshot.receipt}
                  />
                </>
              )}
            </div>
          </div>
        </LayerCard>
        <section className="directory">
          <div className="section-heading">
            <div>
              <span className="eyebrow">THE PARTICIPANTS</span>
              <h2>A network, not a single issuer.</h2>
            </div>
            <Badge variant="outline">15 fictional organizations</Badge>
          </div>
          <div className="institution-grid">
            {institutions.map((i) => (
              <LayerCard key={i.id} className="institution-card">
                <div className="section-heading">
                  <span className="node-monogram">{i.short}</span>
                  <Badge variant="secondary">{i.role}</Badge>
                </div>
                <h3>{i.name}</h3>
                <p>{i.description}</p>
              </LayerCard>
            ))}
          </div>
        </section>
        <footer>
          <span className="brand">
            <FingerprintIcon size={24} />
            attest
          </span>
          <p>
            Synthetic evidence · local authority graph and status · evaluation
            date October 7, 2026.
            <br />
            No external institution is contacted. No blockchain transaction is
            submitted.
          </p>
          <LinkButton href="https://github.com/gmackie/attest" variant="ghost">
            Explore the protocol ↗
          </LinkButton>
        </footer>
      </main>
    </div>
  );
}
