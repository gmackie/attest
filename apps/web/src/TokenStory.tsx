import { useEffect, useId, useState } from "react";
import { Badge, Button, LinkButton } from "@cloudflare/kumo";
import {
  ArrowLeftIcon, ArrowRightIcon, LockKeyIcon, PlayIcon,
  PauseIcon, SealCheckIcon, WalletIcon,
} from "@phosphor-icons/react";
import {
  getTokenStoryFrame, tokenScenes, type TokenProofPath, type TokenWallet,
} from "@attest/demo";
import "./token-story.css";

const colors = ["#48b9d8", "#a78ce8", "#f1c46a", "#69d1ad"] as const;
const colorNames = ["Experience", "Qualifications", "Assurance", "Participation"] as const;

function WalletArtwork({
  wallet, label, highlighted, passportVisible,
}: {
  wallet: TokenWallet;
  label: string;
  highlighted: boolean;
  passportVisible: boolean;
}) {
  let x = 0;
  const stripes = wallet.composition.map((count, index) => {
    const width = wallet.amount === 0 ? 0
      : index === 3 ? Math.max(0, 100 - x) : (count / wallet.amount) * 100;
    const from = x;
    x += width;
    return <rect key={index} x={from} y="0" width={width} height="100" fill={colors[index]} />;
  });
  return (
    <div className={`token-wallet ${highlighted ? "token-wallet--highlight" : ""} ${passportVisible ? "token-wallet--passport" : ""}`}>
      <div className="token-wallet__heading">
        <WalletIcon aria-hidden size={19} />
        <strong>{label}</strong>
        <span>{wallet.amount.toLocaleString("en-US")} test units</span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="token-wallet__art" aria-hidden="true">
        <rect width="100" height="100" fill="#223b4a" />
        {stripes}
        <g stroke="#ffffff" strokeOpacity=".28" fill="none" strokeWidth=".5">
          <path d="M0 25H100M0 50H100M0 75H100M25 0V100M50 0V100M75 0V100" />
        </g>
      </svg>
      <span className="token-visually-hidden">Four-channel composition: {colorNames.map((name, index) => `${name} ${wallet.composition[index]}`).join("; ")}.</span>
      <div className="token-wallet__footer">{passportVisible ? "PASSPORT ERC-721 · soulbound artwork" : "Balance preview · no passport NFT yet"}</div>
    </div>
  );
}

function TokenDiagram({
  frameIndex, proofPath,
}: {
  frameIndex: number;
  proofPath: TokenProofPath;
}) {
  const frame = getTokenStoryFrame(frameIndex, proofPath);
  const stage = tokenScenes[frameIndex]!;
  return (
    <div className="token-diagram" key={`${stage.id}-${proofPath}`} aria-label="Illustration of the selected token lifecycle stage">
      <div className="token-diagram__caption">
        <span className="token-diagram__signal"><span /> SIMULATED LIFECYCLE</span>
        <span>{String(frameIndex + 1).padStart(2, "0")} / {String(tokenScenes.length).padStart(2, "0")}</span>
      </div>
      <div className="token-diagram__chain">
        <div className={`token-object token-object--claim ${frame.claimRevoked ? "token-object--revoked" : ""}`}>
          <div className="token-object__eyebrow"><LockKeyIcon size={15} aria-hidden /> PRIVATE CREDENTIAL</div>
          <div className="token-claim-graphic" aria-hidden="true">
            <span /><span /><span /><span /><span /><span /><span /><span /><span />
          </div>
          <strong>{frame.claimRevoked ? "Claim revoked" : "Signed claim"}</strong>
          {frame.claimNftVisible && <span className="token-object__nft-stamp">CLAIM ERC-721 · OPT-IN</span>}
          <small>{frame.claimNftVisible ? "Public commitment; private values stay hidden" : "Not a public NFT"}</small>
        </div>
        <div className={`token-flow-arrow ${frame.privateProofPrepared ? "token-flow-arrow--active" : ""}`} aria-hidden="true">
          <span className="token-flow-arrow__line" />
          <span className="token-flow-arrow__packet" />
          <ArrowRightIcon size={18} />
        </div>
        <div className={`token-object token-object--proof ${frame.privateProofPrepared && !frame.claimRevoked ? "token-object--verified" : ""}`}>
          <div className="token-object__eyebrow"><SealCheckIcon size={15} aria-hidden /> ZERO-KNOWLEDGE</div>
          <div className="token-proof-symbol" aria-hidden="true">
            <span className="token-proof-symbol__shield">{frame.claimRevoked ? "!" : frame.privateProofPrepared ? "✓" : "?"}</span>
          </div>
          <strong>{frame.claimRevoked ? "Prior proof only" : frame.privateProofPrepared ? "Eligible proof" : "Prove privately"}</strong>
          <small>{proofPath === "bridge" ? "GPC → trusted verifier" : "Issuer root → Groth16"}</small>
        </div>
        <div className={`token-flow-arrow ${frame.issuanceRecorded ? "token-flow-arrow--active" : ""}`} aria-hidden="true">
          <span className="token-flow-arrow__line" />
          <span className="token-flow-arrow__packet" />
          <ArrowRightIcon size={18} />
        </div>
        <div className={`token-object token-object--token ${frame.issuanceRecorded ? "token-object--minted" : ""}`}>
          <div className="token-object__eyebrow">$ATTEST / ERC-20</div>
          <div className="token-coin" aria-hidden="true">A</div>
          <strong>{frame.issuanceRecorded ? "200 minted" : "Not minted"}</strong>
          <small>{frame.entitlementSpent ? "Nullifier spent once" : "No conversion yet"}</small>
        </div>
      </div>

      <div className="token-diagram__divider">
        <span>{frame.transferRecorded ? "TRANSFER • PROPORTIONAL COLOR MIXING" : "WALLETS • ECONOMIC PROVENANCE"}</span>
      </div>
      <div className="token-diagram__wallets">
        <WalletArtwork wallet={frame.alice} label="Alice" highlighted={frame.issuanceRecorded && !frame.transferRecorded} passportVisible={frame.passportVisible} />
        <div className={`token-transfer-bridge ${frame.transferRecorded ? "token-transfer-bridge--sent" : ""}`}>
          <span className="token-transfer-bridge__packet" aria-hidden="true">A</span>
          <ArrowRightIcon size={21} aria-hidden />
          <strong>{frame.transferRecorded ? "50 sent" : "Transfer"}</strong>
        </div>
        <WalletArtwork wallet={frame.bob} label="Bob" highlighted={frame.transferRecorded} passportVisible={frame.passportVisible} />
      </div>
      <div className="token-diagram__flags">
        {frame.passportVisible ? (
          <span className="token-flag token-flag--passport">ERC-721 artwork follows each wallet's holdings</span>
        ) : (
          <span className="token-flag">Passport artwork is optional and non-transferable</span>
        )}
        {frame.claimRevoked ? (
          <span className="token-flag token-flag--revoked">New conversions blocked · existing tokens remain</span>
        ) : (
          <span className="token-flag">{frame.entitlementSpent ? "Spent entitlement cannot mint again" : "No claim has been spent"}</span>
        )}
      </div>
      <div className="token-color-legend">
        {colorNames.map((name, index) => (
          <span key={name}><i style={{ background: colors[index] }} />{name}</span>
        ))}
      </div>
    </div>
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(query.matches);
    change();
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

export function TokenStory({ compact = false }: { compact?: boolean }) {
  const [index, setIndex] = useState(0);
  const [path, setPath] = useState<TokenProofPath>("bridge");
  const [playing, setPlaying] = useState(false);
  const reducedMotion = useReducedMotion();
  const titleId = useId();
  const scene = tokenScenes[index]!;

  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);
  useEffect(() => {
    if (!playing || reducedMotion) return;
    if (index === tokenScenes.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex((n) => Math.min(n + 1, tokenScenes.length - 1)), 4600);
    return () => window.clearTimeout(timer);
  }, [playing, reducedMotion, index]);

  const go = (next: number) => {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(next, tokenScenes.length - 1)));
  };

  return (
    <section className={`token-story ${compact ? "token-story--compact" : ""}`} aria-labelledby={titleId}>
      <div className="token-story__header">
        <div>
          <span className="token-story__eyebrow">HOW ATTEST TOKENS WORK</span>
          <h2 id={titleId}>From private claims to living token artwork.</h2>
          <p>Seven interactive scenes · fictional values · no wallet required</p>
        </div>
        <Badge variant="outline">Educational simulation</Badge>
      </div>
      <div className="token-story__grid">
        <TokenDiagram frameIndex={index} proofPath={path} />
        <div className="token-story__copy">
          <span className="token-story__chapter">SCENE {index + 1} OF {tokenScenes.length} · {scene.label.toUpperCase()}</span>
          <div aria-live="polite" aria-atomic="true" className="token-story__narrative">
            <h3>{scene.title}</h3>
            <p>{scene.explanation}</p>
            {index === 2 || index === 3 ? (
              <p className="token-story__path-caption">
                {path === "bridge"
                  ? "Bridge path: a GPC proof can be verified off-chain before a trusted signer authorizes a separate testnet mint. The animation never signs or mints."
                  : "Native path: a separate experimental Groth16 circuit verifies an issuer-managed Poseidon-root claim in Anvil tests. It does not directly verify Attest PODs."}
              </p>
            ) : null}
          </div>
          <div className="token-story__disclosures">
            <div><strong>What becomes public</strong><p>{scene.publicText}</p></div>
            <div><strong>What stays private</strong><p>{scene.privateText}</p></div>
          </div>
          <div className="token-story__proof-choice" aria-label="Compare conversion proof paths">
            <span>Compare proof architectures</span>
            <div>
              <Button size="sm" variant={path === "bridge" ? "primary" : "secondary"} aria-pressed={path === "bridge"} onClick={() => { setPlaying(false); setPath("bridge"); }}>
                Trusted bridge
              </Button>
              <Button size="sm" variant={path === "native" ? "primary" : "secondary"} aria-pressed={path === "native"} onClick={() => { setPlaying(false); setPath("native"); }}>
                Native ZK
              </Button>
            </div>
            <p>{path === "bridge" ? "POD/GPC → off-chain verification → EIP-712 authorization" : "Issuer Poseidon root → Groth16 contract (Anvil test) → mint"}</p>
          </div>
        </div>
      </div>
      <nav className="token-story__chapters" aria-label="Token lifecycle scenes">
        {tokenScenes.map((stage, step) => (
          <Button key={stage.id} size="sm" variant={step === index ? "primary" : "ghost"} onClick={() => go(step)} aria-current={step === index ? "step" : undefined}>
            <span>{String(step + 1).padStart(2, "0")}</span> {stage.label}
          </Button>
        ))}
      </nav>
      <div className="token-story__controls">
        <div className="token-story__controls-buttons">
          <Button size="sm" variant="secondary" onClick={() => go(index - 1)} disabled={index === 0}>
            <ArrowLeftIcon aria-hidden /> Previous
          </Button>
          <Button size="sm" variant="secondary" onClick={() => go(index + 1)} disabled={index === tokenScenes.length - 1}>
            Next <ArrowRightIcon aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" disabled={reducedMotion} onClick={() => {
            if (!playing && index === tokenScenes.length - 1) setIndex(0);
            setPlaying((v) => !v);
          }}>
            {playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
            {playing ? "Pause" : "Play story"}
          </Button>
        </div>
        <span>{reducedMotion ? "Animations reduced for your system preference." : "Use the scenes manually or play the narrated sequence."}</span>
      </div>
      <div className="token-story__boundary">
        An economic token does not transfer professional qualifications. The browser animation never mints or transfers real $ATTEST.
        <LinkButton href="#/economy" variant="ghost">Try the interactive token lab <ArrowRightIcon aria-hidden /></LinkButton>
      </div>
    </section>
  );
}
