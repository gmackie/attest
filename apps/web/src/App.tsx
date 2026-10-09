import { lazy, Suspense, useEffect, useState } from "react";
import { Badge, Button, LayerCard, LinkButton } from "@cloudflare/kumo";
import { FingerprintIcon } from "@phosphor-icons/react";
import { industries, supplierIndustry } from "@attest/demo";
import { IndustryLab, IndustryIcon } from "./IndustryLab";
import { WalletWorkspace } from "./WalletWorkspace";
import { ConnectedWorkspace } from "./ConnectedWorkspace";
import { StandardsExplorer } from "./StandardsExplorer";
import { InfrastructureExplorer } from "./InfrastructureExplorer";
const TestnetJourney = lazy(() =>
  import("./TestnetJourney").then((m) => ({ default: m.TestnetJourney })),
);
const IndustryJourney = lazy(() =>
  import("./IndustryJourney").then((m) => ({ default: m.IndustryJourney })),
);
const DemoChooser = lazy(() =>
  import("./IndustryJourney").then((m) => ({ default: m.DemoChooser })),
);
const stories = [supplierIndustry, ...industries];
function route() {
  return location.hash.slice(1) || "/";
}
export function App() {
  const [path, setPath] = useState(route);
  useEffect(() => {
    const update = () => {
      setPath(route());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const story = stories.find((i) => path === `/explore/${i.id}`);
  const known =
    path === "/" ||
    path === "/explore" ||
    !!story ||
    path === "/sandbox" ||
    path.split("?")[0] === "/demo" ||
    path.startsWith("/demo/") ||
    path.startsWith("/app") ||
    path === "/learn" ||
    path.startsWith("/learn/") ||
    path === "/developers";
  return (
    <div className="app redesigned">
      <header className="topbar">
        <a href="#/" className="brand">
          <FingerprintIcon size={26} />
          attest
        </a>
        <nav aria-label="Primary navigation">
          {[
            { name: "Explore", href: "/explore" },
            { name: "Testnet demo", href: "/demo" },
            { name: "Workspace", href: "/app" },
            { name: "Learn", href: "/learn" },
            { name: "Developers", href: "/developers" },
          ].map((item) => (
            <LinkButton
              key={item.href}
              href={`#${item.href}`}
              variant={path.startsWith(item.href) ? "secondary" : "ghost"}
              aria-current={path.startsWith(item.href) ? "page" : undefined}
            >
              {item.name}
            </LinkButton>
          ))}
        </nav>
      </header>
      <main>
        {path === "/" && (
          <>
            <section className="landing-hero">
              <span className="eyebrow">
                PRIVATE EVIDENCE. EXPLAINABLE TRUST.
              </span>
              <h1>
                Prove what matters.
                <br />
                <span>Keep the rest yours.</span>
              </h1>
              <p>
                Connect credentials from independent institutions. Share the
                evidence a decision needs, with clear control over what stays
                private.
              </p>
              <div className="controls">
                <LinkButton href="#/explore" variant="primary">
                  Try a guided demo
                </LinkButton>
                <LinkButton href="#/demo" variant="secondary">
                  Try with a real wallet
                </LinkButton>
              </div>
            </section>
            <div className="landing-flow">
              <span>Institutions issue</span>
              <span>→</span>
              <span>You hold & prove</span>
              <span>→</span>
              <span>Verifiers decide</span>
            </div>
            <div className="destination-grid">
              <LayerCard className="infra-card">
                <h2>Understand the journey</h2>
                <p>
                  Follow a supplier, clinician, applicant or shipment. Inspect
                  each handoff and the exact clauses behind the decision.
                </p>
                <LinkButton href="#/explore" variant="ghost">
                  Choose a story →
                </LinkButton>
              </LayerCard>
              <LayerCard className="infra-card">
                <h2>Work with your wallet</h2>
                <p>
                  Connect an EVM account, manage encrypted local custody, and
                  work with a scoped testnet registry.
                </p>
                <LinkButton href="#/app" variant="ghost">
                  Connect a wallet →
                </LinkButton>
              </LayerCard>
              <LayerCard className="infra-card">
                <h2>Build on standards</h2>
                <p>
                  Understand credential formats, private proofs, trust
                  registries, and what the chain does—and does not—establish.
                </p>
                <LinkButton href="#/learn" variant="ghost">
                  Explore the architecture →
                </LinkButton>
              </LayerCard>
            </div>
          </>
        )}
        {path === "/explore" && (
          <section className="page-section">
            <span className="eyebrow">GUIDED DEMOS</span>
            <h1>Choose a decision to understand.</h1>
            <p>
              Fictional institutions, real signatures and private proofs.
              Nothing is submitted to a blockchain.
            </p>
            <div className="story-grid">
              {stories.map((i) => (
                <LayerCard key={i.id} className="infra-card">
                  <IndustryIcon id={i.id} size={30} />
                  <h2>{i.name}</h2>
                  <p>{i.purpose}</p>
                  <p className="muted">
                    {i.sources.length} sources · {i.rules.length} clauses · 3
                    agreement levels
                  </p>
                  <LinkButton href={`#/explore/${i.id}`} variant="secondary">
                    Follow this story →
                  </LinkButton>
                  <LinkButton
                    href={`#/demo/${i.id === "supplier" ? "contractor" : i.id}`}
                    variant="primary"
                  >
                    Try with real Sepolia wallets →
                  </LinkButton>
                </LayerCard>
              ))}
            </div>
            <LinkButton href="#/sandbox" variant="ghost">
              Try the personal / institution workspace sandbox →
            </LinkButton>
          </section>
        )}
        {story && (
          <section className="page-section">
            <LinkButton href="#/explore" variant="ghost">
              ← All stories
            </LinkButton>
            <IndustryLab key={story.id} industry={story} />
          </section>
        )}
        {path === "/sandbox" && (
          <section className="page-section">
            <div className="section-heading">
              <LinkButton href="#/explore" variant="ghost">
                ← Explore
              </LinkButton>
              <Badge variant="outline">
                Local role simulation · no connected account
              </Badge>
            </div>
            <WalletWorkspace />
          </section>
        )}
        {(path.split("?")[0] === "/demo" || path.startsWith("/demo/")) && (
          <Suspense
            fallback={
              <p className="page-section">Opening the testnet journey…</p>
            }
          >
            {path.split("?")[0] === "/demo" && !path.includes("registry=") ? (
              <DemoChooser />
            ) : (["healthcare", "education", "logistics"] as const).find(
                (id) => path.split("?")[0] === `/demo/${id}`,
              ) ? (
              <IndustryJourney
                key={path}
                industry={(
                  ["healthcare", "education", "logistics"] as const
                ).find((id) => path.split("?")[0] === `/demo/${id}`)!}
              />
            ) : (
              <TestnetJourney key={path} />
            )}
          </Suspense>
        )}
        {path.startsWith("/app") && <ConnectedWorkspace />}
        {(path === "/learn" || path.startsWith("/learn/")) && (
          <section className="page-section">
            <span className="eyebrow">REFERENCE LIBRARY</span>
            <h1>Understand the trust model.</h1>
            <div className="controls">
              <LinkButton
                href="#/learn/standards"
                variant={path.endsWith("standards") ? "primary" : "secondary"}
              >
                Standards composition
              </LinkButton>
              <LinkButton
                href="#/learn/infrastructure"
                variant={
                  path.endsWith("infrastructure") ? "primary" : "secondary"
                }
              >
                EVM & clearinghouses
              </LinkButton>
            </div>
            {path.endsWith("infrastructure") ? (
              <InfrastructureExplorer />
            ) : (
              <StandardsExplorer />
            )}
          </section>
        )}
        {path === "/developers" && (
          <section className="page-section narrow">
            <span className="eyebrow">DEVELOPER TOOLS</span>
            <h1>One model. UI, documents, and CLI.</h1>
            <p>
              Use versioned YAML or JSON to describe wallets, issuance
              templates, requests, and decision records. The local demo CLI and
              UI share validation and operations.
            </p>
            <pre>{`pnpm attest --help\npnpm attest init\npnpm attest issue --actor board --approve\npnpm attest schema --json`}</pre>
            <p>
              The CLI actor switch is a fictional local simulation. It is not
              authorization for the connected registry.
            </p>
            <div className="controls">
              <LinkButton
                href="https://github.com/gmackie/attest/blob/feat/assurance-kernel-poc/specs/wallet-workspaces.md"
                variant="secondary"
              >
                Wallet / CLI reference ↗
              </LinkButton>
              <LinkButton
                href="https://github.com/gmackie/attest"
                variant="ghost"
              >
                Source code ↗
              </LinkButton>
            </div>
            <details className="quiet-details">
              <summary>Custody and deployment boundaries</summary>
              <p>
                Private evidence remains on your device or in an encrypted
                export you store with a provider of your choice. The connected
                testnet registry stores commitments and status. Ethereum
                production writes are gated pending security review and a
                trusted deployment. POD/GPC remains an experimental backend.
              </p>
            </details>
          </section>
        )}
        {!known && (
          <section className="page-section">
            <h1>Page not found</h1>
            <LinkButton href="#/" variant="primary">
              Return home
            </LinkButton>
          </section>
        )}
        <footer>
          <span className="brand">
            <FingerprintIcon size={22} />
            attest
          </span>
          <p>
            Private evidence stays in your custody.
            <br />
            Experimental protocol and fictional demonstrations.
          </p>
          <LinkButton
            href="https://github.com/gmackie/attest/pull/1"
            variant="ghost"
          >
            Source & implementation ↗
          </LinkButton>
        </footer>
      </main>
    </div>
  );
}
