import { useState } from "react";
import { Button, LinkButton } from "@cloudflare/kumo";
import {
  DatabaseIcon,
  WalletIcon,
  SealCheckIcon,
  ArrowRightIcon,
  FingerprintIcon,
} from "@phosphor-icons/react";
import { industries, supplierIndustry } from "@attest/demo";
import { IndustryIcon } from "./IndustryIcon";

const moments = [
  {
    title: "Institutions sign the facts.",
    text: "A university, employer or auditor signs its own credentials. Each signature binds the claims to that issuer.",
    label: "Signed credential",
    private: "Source records stay with their institution",
  },
  {
    title: "Your wallet holds the evidence.",
    text: "Collect credentials from independent sources. Your wallet creates a proof that satisfies a request without disclosing every field.",
    label: "Private proof",
    private: "Exact values stay in your wallet",
  },
  {
    title: "A verifier checks the claim.",
    text: "The verifier checks issuer keys, proof constraints and request binding. In the testnet flow, a public receipt records its decision.",
    label: "Decision receipt",
    private: "Public receipts contain commitments, not raw evidence",
  },
];
export function TrustAnimation() {
  const [moment, setMoment] = useState(0);
  const current = moments[moment]!;
  return (
    <div className="trust-animation">
      <div className="trust-caption">
        <span className="eyebrow">HOW TRUST MOVES</span>
        <span>0{moment + 1} / 03</span>
      </div>
      <div className="trust-nodes" aria-label="Explore the trust flow">
        {[DatabaseIcon, WalletIcon, SealCheckIcon].map((Icon, index) => (
          <Button
            key={index}
            variant="ghost"
            className={`trust-node ${moment === index ? "active" : ""}`}
            aria-label={["Institutions", "Your wallet", "Verifier"][index]}
            aria-pressed={moment === index}
            onClick={() => setMoment(index)}
          >
            <Icon size={30} />
            <span>{["Institutions", "Your wallet", "Verifier"][index]}</span>
          </Button>
        ))}
      </div>
      <div className="trust-packet" key={moment}>
        <FingerprintIcon size={22} />
        <span>{current.label}</span>
        <span className="packet-mark">✓</span>
      </div>
      <div className="trust-description" aria-live="polite">
        <h3>{current.title}</h3>
        <p>{current.text}</p>
      </div>
      <div className="trust-bottom">
        <span>{current.private}</span>
        <Button
          variant="ghost"
          aria-label="Next explanation"
          onClick={() => setMoment((moment + 1) % 3)}
        >
          <ArrowRightIcon size={22} />
        </Button>
      </div>
    </div>
  );
}
export function BrowserDemos({ compact = false }: { compact?: boolean }) {
  return (
    <section className={`browser-catalog ${compact ? "compact" : ""}`}>
      <div className="catalog-heading">
        <div>
          <span className="eyebrow">FOUR BROWSER DEMOS</span>
          <h2>Different decisions. The same trust.</h2>
        </div>
        <p>
          No wallet or test ETH needed. Edit fictional records and follow real
          signatures and private proofs in your browser.
        </p>
      </div>
      <div className="browser-cards">
        {[supplierIndustry, ...industries].map((industry, index) => (
          <a
            className={`browser-card theme-${industry.color}`}
            key={industry.id}
            href={`#/explore/${industry.id}`}
          >
            <div className="browser-card-top">
              <IndustryIcon id={industry.id} size={30} />
              <span>0{index + 1}</span>
            </div>
            <h3>{industry.name}</h3>
            <p>{industry.purpose}</p>
            <div className="browser-card-meta">
              {industry.sources.length} sources <span>·</span>{" "}
              {industry.rules.length} criteria
            </div>
            <div className="browser-card-action">
              Explore the demo <ArrowRightIcon size={19} />
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
export function Landing() {
  return (
    <div className="landing-page">
      <section className="landing-split">
        <div className="landing-copy">
          <span className="eyebrow">CREDENTIALS, WITHOUT THE OVERSHARING</span>
          <h1>
            Prove what matters.
            <br />
            <span>Keep the rest yours.</span>
          </h1>
          <p>
            Trusted institutions issue the facts. You hold the evidence. Share a
            proof that opens the next door.
          </p>
          <div className="controls">
            <LinkButton href="#/explore" variant="primary">
              Explore the browser demos <ArrowRightIcon />
            </LinkButton>
            <LinkButton href="#/testnet" variant="secondary">
              Use a real wallet
            </LinkButton>
          </div>
          <small>Start in your browser. Take the next step on Sepolia.</small>
        </div>
        <TrustAnimation />
      </section>
      <BrowserDemos compact />
      <section className="testnet-invitation">
        <div>
          <span className="eyebrow">READY FOR THE CHAIN?</span>
          <h2>Your wallet. Real testnet transactions.</h2>
          <p>
            Connect your EVM wallet on Ethereum Sepolia. Request credentials
            from fictional institutions and inspect the public receipts.
          </p>
        </div>
        <LinkButton href="#/testnet" variant="primary">
          Open the testnet workspace <ArrowRightIcon />
        </LinkButton>
      </section>
      <div className="landing-reference">
        <span>Understand what makes a proof trustworthy.</span>
        <LinkButton href="#/learn" variant="ghost">
          Standards & architecture →
        </LinkButton>
        <LinkButton href="#/developers" variant="ghost">
          Developer tools →
        </LinkButton>
      </div>
    </div>
  );
}
