const HostSetup = lazy(() =>
  import("./HostSetup").then((m) => ({ default: m.HostSetup })),
);
import { Landing, BrowserDemos } from "./Landing";
import { lazy, Suspense, useEffect, useState } from "react";
import { Badge, LinkButton } from "@cloudflare/kumo";
import { FingerprintIcon } from "@phosphor-icons/react";
import { industries, supplierIndustry } from "@attest/demo";
const IndustryLab = lazy(() =>
  import("./IndustryLab").then((m) => ({ default: m.IndustryLab })),
);
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
  const path = location.hash.slice(1) || "/";
  return path.replace(/^\/testnet(?=\/|\?|$)/, "/demo");
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
            { name: "Browser demos", href: "/explore" },
            { name: "Onchain testnet", href: "/testnet" },

            { name: "Learn", href: "/learn" },
            { name: "Developers", href: "/developers" },
          ].map((item) => (
            <LinkButton
              key={item.href}
              href={`#${item.href}`}
              variant={
                path.startsWith(item.href === "/testnet" ? "/demo" : item.href)
                  ? "secondary"
                  : "ghost"
              }
              aria-current={
                path.startsWith(item.href === "/testnet" ? "/demo" : item.href)
                  ? "page"
                  : undefined
              }
            >
              {item.name}
            </LinkButton>
          ))}
        </nav>
      </header>
      <main>
        {path === "/" && <Landing />}
        {path === "/explore" && (
          <section className="page-section browser-directory">
            <span className="mode-label">
              BROWSER EXPERIENCE · NO WALLET REQUIRED
            </span>
            <h1>See how a private decision happens.</h1>
            <p>
              Choose a story. Change the evidence, inspect each handoff, and see
              what a verifier can learn. Everything runs locally; the ledger is
              simulated.
            </p>
            <BrowserDemos />
            <LinkButton href="#/testnet" variant="ghost">
              Looking for real wallets? Open the onchain testnet →
            </LinkButton>
          </section>
        )}
        {story && (
          <section className="page-section">
            <LinkButton href="#/explore" variant="ghost">
              ← Browser demos
            </LinkButton>
            <Suspense fallback={<p>Opening the browser demo…</p>}>
              <IndustryLab key={story.id} industry={story} />
            </Suspense>
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
            {path === "/demo/setup" ? (
              <HostSetup />
            ) : path.split("?")[0] === "/demo" &&
              !path.includes("registry=") ? (
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
