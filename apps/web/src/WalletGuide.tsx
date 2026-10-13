import { useEffect, useState } from "react";
import { TokenStory } from "./TokenStory";
import { Badge, Button, LayerCard, LinkButton } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ArrowLeftIcon,
  WalletIcon,
  LockKeyIcon,
  SealCheckIcon,
  KeyIcon,
  DatabaseIcon,
  PlayIcon,
  PauseIcon,
  ArrowCounterClockwiseIcon,
  FileTextIcon,
} from "@phosphor-icons/react";

const chapters = [
  {
    name: "Connect",
    title: "Your address is your public identity.",
    text: "Your Ethereum wallet holds the account key. Connecting lets Attest see your address. Signing a request proves you control that account; it does not hand over the key.",
    detail:
      "Connecting, signing a message and sending a transaction are different actions. Read the wallet prompt before approving.",
    packet: "Signed request",
    public: "Account address",
    private: "Account key stays in your wallet",
  },
  {
    name: "Collect",
    title: "An institution signs a fact about you.",
    text: "A credential is a signed record. A claim is one fact inside it, such as your insurance coverage. The issuer’s signature binds the facts to the issuer and the credential’s subject.",
    detail:
      "A signature shows who signed and whether the record changed. Trust still depends on whether that issuer has authority to make the claim.",
    packet: "Issuer-signed credential",
    public: "Credential commitment + status",
    private: "Full credential stays in your passport",
  },
  {
    name: "Keep",
    title: "Your private passport holds the details.",
    text: "Attest keeps credentials in a separate local vault, called your passport in the demos. Your passphrase encrypts its records and credential key. The Ethereum account key and passport key do different jobs.",
    detail:
      "An optional encrypted browser copy helps you return on this device. Export an encrypted backup after collecting new credentials; the chain cannot restore them.",
    packet: "Encrypted backup",
    public: "No raw evidence uploaded",
    private: "Passphrase + credential key stay with you",
  },
  {
    name: "Prove",
    title: "Answer a question without sharing every field.",
    text: "A verifier asks for a specific requirement. Your browser uses a signed credential to prepare a private proof for that request. You review what will be revealed before sharing the presentation.",
    detail:
      "In this illustration, the verifier learns whether coverage meets a minimum. The exact coverage amount stays hidden. Real requests may reveal other fields and metadata.",
    packet: "Request-bound presentation",
    public: "Required result + disclosed fields",
    private: "Exact coverage stays in your passport",
  },
  {
    name: "Verify",
    title: "A proof is checked. A receipt records the decision.",
    text: "The verifier checks the proof, issuer authority, subject binding, expiry and revocation status. In the testnet flow, an authorized verifier can record a decision receipt on Ethereum Sepolia.",
    detail:
      "The contract records the verifier’s assertion; it does not check the private proof itself. A receipt is meaningful only with the proof checks and a trusted verifier.",
    packet: "Verifier decision receipt",
    public: "Commitments + decision receipt",
    private: "Source evidence stays off-chain",
  },
];

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function WalletGuide() {
  const [chapter, setChapter] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replay, setReplay] = useState(0);
  const [animated, setAnimated] = useState(false);
  const [motionPaused, setMotionPaused] = useState(false);
  const [minimum, setMinimum] = useState(1);
  const reduced = useReducedMotion();
  const current = chapters[chapter]!;
  const qualifies = minimum <= 2;
  useEffect(() => {
    if (reduced) setPlaying(false);
  }, [reduced]);
  useEffect(() => {
    if (!playing || reduced) return;
    const timer = window.setTimeout(() => {
      if (chapter === chapters.length - 1) setPlaying(false);
      else setChapter((value) => value + 1);
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [playing, chapter, replay, reduced]);
  const select = (index: number) => {
    setAnimated(true);
    setMotionPaused(false);
    setPlaying(false);
    setChapter(index);
    setReplay((value) => value + 1);
  };
  return (
    <div className="wallet-guide">
      <section className="guide-intro">
        <LinkButton href="#/" variant="ghost">
          ← Back to home
        </LinkButton>
        <span className="eyebrow">YOUR WALLET, EXPLAINED</span>
        <h1>
          One wallet. Your credentials.
          <br />
          <span>You choose what to share.</span>
        </h1>
        <p>
          You already know how to keep a document and show it when asked. Attest
          adds a way to prove a fact inside that document while keeping the rest
          private.
        </p>
        <div className="controls">
          <Badge variant="outline">No wallet needed to learn</Badge>
          <span className="guide-note">
            About 3 minutes · fictional insurance example
          </span>
        </div>
      </section>
      <details className="token-story-disclosure">
        <summary>What about Claim NFTs and $ATTEST? Explore the animated token layer</summary>
        <p>The wallet guide below teaches ordinary private credential presentations; it does not issue tokens. The optional walkthrough shows how an additional experimental token economy could work.</p>
        <TokenStory compact />
      </details>

      <section
        className="guide-story"
        aria-labelledby="guide-story-title"
        data-paused={motionPaused}
        data-animated={animated}
      >
        <div className="guide-story-heading">
          <div>
            <span className="eyebrow">FOLLOW A CREDENTIAL</span>
            <h2 id="guide-story-title">
              From a signed fact to a private answer.
            </h2>
          </div>
          <span className="guide-counter">0{chapter + 1} / 05</span>
        </div>
        <div className="guide-chapters" aria-label="Walkthrough chapters">
          {chapters.map((item, index) => (
            <Button
              key={item.name}
              variant={index === chapter ? "secondary" : "ghost"}
              aria-pressed={index === chapter}
              onClick={() => select(index)}
            >
              <span className="guide-chapter-number">0{index + 1}</span>
              {item.name}
            </Button>
          ))}
        </div>
        <div
          className={`guide-scene scene-${chapter}`}
          key={`${chapter}-${replay}`}
          aria-label={`Illustration: ${current.title}`}
        >
          <div className="guide-actors">
            <div className={`guide-actor ${chapter === 1 ? "is-active" : ""}`}>
              <DatabaseIcon size={28} />
              <strong>Institution</strong>
              <small>Signs the credential</small>
            </div>
            <div
              className={`guide-actor ${chapter < 4 && chapter !== 1 ? "is-active" : ""}`}
            >
              <WalletIcon size={28} />
              <strong>You + your wallet</strong>
              <small>Control the passport</small>
            </div>
            <div className={`guide-actor ${chapter === 4 ? "is-active" : ""}`}>
              <SealCheckIcon size={28} />
              <strong>Verifier</strong>
              <small>Checks the proof</small>
            </div>
          </div>
          <div className="guide-transfer" aria-hidden="true">
            <div className="guide-track" />
            <div className="guide-moving-packet">
              <FileTextIcon size={18} />
              <span>{current.packet}</span>
              <ArrowRightIcon size={16} />
            </div>
          </div>
          <div className="guide-compartments">
            <div className="guide-private">
              <div className="guide-panel-label">
                <LockKeyIcon size={18} /> YOUR PRIVATE PASSPORT
              </div>
              {chapter === 0 ? (
                <div className="guide-identity">
                  <KeyIcon size={30} />
                  <strong>Two keys. Two jobs.</strong>
                  <span>Account key → wallet approvals</span>
                  <span>Credential key → presentations</span>
                </div>
              ) : (
                <div className="guide-credential">
                  <div className="guide-credential-heading">
                    <FileTextIcon size={22} />
                    <strong>Insurance credential</strong>
                    <Badge variant="secondary">Signed</Badge>
                  </div>
                  <dl>
                    <div>
                      <dt>Subject</dt>
                      <dd>You · example account</dd>
                    </div>
                    <div className="guide-hidden-field">
                      <dt>Coverage</dt>
                      <dd>
                        $2,000,000 <LockKeyIcon size={15} />
                      </dd>
                    </div>
                    <div>
                      <dt>Issuer</dt>
                      <dd>Fictional insurer</dd>
                    </div>
                  </dl>
                  <div className="guide-seal">
                    <SealCheckIcon size={16} />
                    {chapter === 2
                      ? "Encrypted export → your backup"
                      : "Issuer signature binds these claims"}
                  </div>
                </div>
              )}
              <p className="guide-boundary">{current.private}</p>
            </div>
            <div className="guide-public">
              <div className="guide-panel-label">
                <DatabaseIcon size={18} />{" "}
                {chapter === 3 ? "WHAT THE VERIFIER LEARNS" : "PUBLIC SIDE"}
              </div>
              {chapter === 0 ? (
                <div className="guide-public-record">
                  <WalletIcon size={30} />
                  <strong>0x… your address</strong>
                  <p>A public identifier, not your password.</p>
                </div>
              ) : chapter === 2 ? (
                <div className="guide-public-record">
                  <LockKeyIcon size={30} />
                  <strong>Your evidence stays off-chain.</strong>
                  <p>A commitment cannot recover a lost credential.</p>
                </div>
              ) : chapter >= 3 ? (
                <div className="guide-proof-result">
                  <span>Question: coverage ≥ ${minimum}M?</span>
                  <strong className={qualifies ? "guide-pass" : "guide-fail"}>
                    {qualifies
                      ? "Requirement satisfied"
                      : "Requirement not satisfied"}
                  </strong>
                  <p>
                    Exact coverage: <b>not disclosed</b>
                  </p>
                  <small>
                    {chapter === 4
                      ? qualifies
                        ? "An authorized verifier can record acceptance."
                        : "No acceptance receipt for this requirement."
                      : "Presentation is bound to this request."}
                  </small>
                </div>
              ) : (
                <div className="guide-public-record">
                  <FileTextIcon size={30} />
                  <strong>A fingerprint of the credential</strong>
                  <p>
                    A commitment identifies the signed record without publishing
                    its contents.
                  </p>
                  <small>Registry status: active</small>
                </div>
              )}
              <p className="guide-boundary">{current.public}</p>
            </div>
          </div>
          <p className="guide-illustration-note">
            Conceptual animation · no connection, transaction or cryptographic
            proof runs here.
          </p>
        </div>
        <div
          className="guide-narration"
          aria-live={playing ? "off" : "polite"}
          aria-atomic="true"
        >
          <span className="eyebrow">
            0{chapter + 1} / {current.name.toUpperCase()}
          </span>
          <h3>{current.title}</h3>
          <p>{current.text}</p>
          <p className="guide-detail">{current.detail}</p>
        </div>
        {chapter >= 3 && (
          <div className="guide-experiment">
            <div>
              <strong>Change the verifier’s question.</strong>
              <p>The hidden amount stays the same. The answer changes.</p>
            </div>
            <div className="controls" aria-label="Required coverage">
              <Button
                variant={minimum === 1 ? "secondary" : "ghost"}
                aria-pressed={minimum === 1}
                onClick={() => {
                  setPlaying(false);
                  setMinimum(1);
                }}
              >
                At least $1M
              </Button>
              <Button
                variant={minimum === 3 ? "secondary" : "ghost"}
                aria-pressed={minimum === 3}
                onClick={() => {
                  setPlaying(false);
                  setMinimum(3);
                }}
              >
                At least $3M
              </Button>
            </div>
          </div>
        )}
        <div className="guide-playback">
          <div className="controls">
            <Button
              variant="secondary"
              disabled={reduced}
              onClick={() => {
                if (!playing && chapter === 4) setChapter(0);
                setAnimated(true);
                setMotionPaused(playing);
                setPlaying(!playing);
              }}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
              {playing ? "Pause" : "Play walkthrough"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setAnimated(true);
                setMotionPaused(false);
                setPlaying(false);
                setReplay((value) => value + 1);
              }}
            >
              {" "}
              <ArrowCounterClockwiseIcon />
              Replay chapter
            </Button>
          </div>
          <div className="controls">
            <Button
              variant="ghost"
              disabled={chapter === 0}
              aria-label="Previous chapter"
              onClick={() => select(chapter - 1)}
            >
              <ArrowLeftIcon />
            </Button>
            <Button
              variant="secondary"
              disabled={chapter === 4}
              onClick={() => select(chapter + 1)}
            >
              Next chapter <ArrowRightIcon />
            </Button>
          </div>
        </div>
        <p className="guide-note">
          {reduced
            ? "Reduced motion is on. Use the chapter buttons to explore at your own pace."
            : "Play advances every 10 seconds and stops at the end. Pause holds the animation and explanation."}
        </p>
      </section>

      <section className="guide-basics" aria-labelledby="guide-basics-title">
        <span className="eyebrow">THE EVERYDAY PART</span>
        <h2 id="guide-basics-title">
          Manage it like a private document folder.
        </h2>
        <div className="guide-basics-grid">
          <LayerCard className="guide-basic">
            <WalletIcon size={28} />
            <h3>1. Connect your wallet</h3>
            <p>
              Use an Ethereum-compatible wallet such as MetaMask or Rabby. In
              our guided demos, your address owns the passport and signs
              requests. On mobile, open Attest in your wallet’s browser.
            </p>
            <p>
              Ethereum Sepolia is a test network. Its test ETH has no monetary
              value. Funded institution wallets submit the guided demo
              transactions.
            </p>
          </LayerCard>
          <LayerCard className="guide-basic">
            <LockKeyIcon size={28} />
            <h3>2. Unlock your passport</h3>
            <p>
              Create a passport with its own passphrase, or restore an encrypted
              backup. Collect credentials and review their issuer, subject,
              validity and status.
            </p>
            <p>
              Your wallet connection does not unlock the private passport. Email
              login and automatic passkey recovery are not available in this
              reference implementation.
            </p>
          </LayerCard>
          <LayerCard className="guide-basic">
            <SealCheckIcon size={28} />
            <h3>3. Review before sharing</h3>
            <p>
              Check who is asking, what requirement they need, and which fields
              the presentation reveals. Share only when you are comfortable with
              that request.
            </p>
            <p>
              A private proof can hide values. Your account address, disclosed
              fields and public transaction metadata can still identify or link
              activity.
            </p>
          </LayerCard>
        </div>
      </section>

      <section
        className="guide-recovery"
        aria-labelledby="guide-recovery-title"
      >
        <div>
          <span className="eyebrow">KEEP A WAY BACK IN</span>
          <h2 id="guide-recovery-title">
            Your wallet recovery and your evidence backup are separate.
          </h2>
          <p>
            Save an encrypted passport export after adding credentials. Store it
            somewhere you control, separately from its passphrase. A saved
            browser copy can disappear when browser data is cleared.
          </p>
        </div>
        <div className="guide-recovery-path">
          <div>
            <KeyIcon size={22} />
            <strong>Wallet recovery method</strong>
            <span>Restores access to your Ethereum account</span>
          </div>
          <div>
            <FileTextIcon size={22} />
            <strong>Encrypted export + passport passphrase</strong>
            <span>Restores your private credentials and credential key</span>
          </div>
        </div>
        <p className="guide-recovery-foot">
          Attest cannot reset a lost passport passphrase or rebuild its contents
          from the blockchain. Never enter your wallet seed phrase or private
          account key into Attest. Keep the original account and registry
          context when restoring a demo passport.
        </p>
      </section>

      <section className="guide-next">
        <div>
          <span className="eyebrow">TRY IT AT YOUR PACE</span>
          <h2>Start with a story. Bring a wallet when ready.</h2>
          <p>
            The protocol and POD/GPC proof backend are experimental and not
            audited for production use. The demos use fictional institutions and
            credentials.
          </p>
        </div>
        <div className="controls">
          <LinkButton href="#/explore" variant="primary">
            Try a browser demo <ArrowRightIcon />
          </LinkButton>
          <LinkButton href="#/testnet" variant="secondary">
            Continue with a wallet
          </LinkButton>
          <LinkButton href="#/learn/infrastructure" variant="ghost">
            Explore the technology →
          </LinkButton>
        </div>
      </section>
    </div>
  );
}
