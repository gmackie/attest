import { useState } from "react";
import { Badge, Button, LinkButton } from "@cloudflare/kumo";
import { signingPublicKey } from "@attest/demo";
import {
  CONVERSION_CLAIM_SCHEMA, issueConversionClaim, preparePrivateConversion,
  verifyPrivateConversion, type ConversionClaim, type ConversionIntent,
  type ConversionPolicy,
} from "@attest/demo";
import type { ConversionVoucher, Hex } from "@attest/chain-evm";
import { TokenStory } from "./TokenStory";
import "./economy.css";

const issuerAccount = "0x3333333333333333333333333333333333333333" as const;
const recipient = "0x1111111111111111111111111111111111111111" as const;
const testToken = "0x2222222222222222222222222222222222222222" as const;
const POLICY: ConversionPolicy = {
  id: `0x${"a".repeat(64)}` as Hex,
  schema: CONVERSION_CLAIM_SCHEMA,
  scope: `0x${"b".repeat(64)}` as Hex,
  minimumScore: 700,
  mintAmount: 200n * 10n ** 18n,
  palette: [5000, 2500, 1500, 1000],
};
const colors = ["#3b9dc9", "#9c76d6", "#e5b454", "#51ba95"];
const labels = ["Experience", "Qualifications", "Assurance", "Participation"];
type Mix = { amount: number; colors: [number, number, number, number] };
type LocalClaim = {
  claim: ConversionClaim;
  holderKey: string;
  issuerKey: string;
  intent: ConversionIntent;
};
const initialBob: Mix = { amount: 80, colors: [0, 0, 80, 0] };
const zero: Mix = { amount: 0, colors: [0, 0, 0, 0] };
function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, "0")).join("");
}
function Portrait({ mix, name }: { mix: Mix; name: string }) {
  let x = 14;
  return (
    <svg viewBox="0 0 320 260" role="img" aria-label={`${name}: ${mix.amount} simulated ATTEST with four color channels`}>
      <rect width="320" height="260" rx="12" fill="#142239" />
      <rect x="14" y="14" width="292" height="176" rx="4" fill="#28394d" />
      {mix.amount > 0 && mix.colors.map((channel, i) => {
        const width = i === 3 ? 306 - x : 292 * channel / mix.amount;
        const at = x;
        x += width;
        return <rect key={i} x={at} y="14" width={Math.max(0, width)} height="176" fill={colors[i]} />;
      })}
      <rect x="14" y="14" width="292" height="176" fill="none" stroke="#ffffff" strokeOpacity=".23" />
      <text x="16" y="215" fill="#ffffff" fontSize="17" fontFamily="monospace">{name.toUpperCase()} / ATTEST</text>
      <text x="16" y="243" fill="#b7cadd" fontSize="18" fontFamily="monospace">{mix.amount.toLocaleString("en-US")} simulated tokens</text>
    </svg>
  );
}
export default function EconomyLab() {
  const [score, setScore] = useState(880);
  const [record, setRecord] = useState<LocalClaim | null>(null);
  const [voucher, setVoucher] = useState<ConversionVoucher | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [revoked, setRevoked] = useState(false);
  const [alice, setAlice] = useState<Mix>(zero);
  const [bob, setBob] = useState<Mix>(initialBob);
  const [transfers, setTransfers] = useState(0);
  const issue = () => {
    try {
      setMessage("");
      const issuerKey = randomHex();
      const holderKey = randomHex();
      const expiresAt = Math.floor(Date.now()/1000) + 2700;
      const claim = issueConversionClaim({
        id: `claim:${crypto.randomUUID()}`,
        subject: "fictional:industrial-contractor",
        holderPublicKey: signingPublicKey(holderKey),
        eventCommitment: `0x${randomHex()}` as Hex,
        score,
        validThrough: new Date((expiresAt + 86_400)*1000).toISOString().slice(0,10),
      }, issuerKey);
      const intent: ConversionIntent = {
        kind: "AttestConversionIntent", version: 1, chainId: 11155111,
        token: testToken, recipient, policyId: POLICY.id, id: claim.id,
        contentID: claim.contentID, eventCommitment: claim.eventCommitment,
        subject: claim.subject, holderPublicKey: claim.holderPublicKey,
        issuerAccount, issuerPublicKey: claim.issuerPublicKey, expiresAt,
      };
      setRecord({ claim, issuerKey, holderKey, intent });
      setVoucher(null);
      setRevoked(false);
      setAlice(zero);
      setBob(initialBob);
      setTransfers(0);
      setMessage("Synthetic private claim issued locally. Its signed score is in memory, not on a blockchain.");
    } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
  };

  const prove = async () => {
    if (!record || working) return;
    setWorking(true);
    setMessage("Preparing and verifying the real GPC proof locally...");
    try {
      const { claim, holderKey, intent } = record;
      const presentation = await preparePrivateConversion(claim, intent, POLICY, holderKey);
      const output = await verifyPrivateConversion(presentation, intent, POLICY, {
        nowMs: () => Date.now(),
        resolvePolicy: async (id) => id === POLICY.id ? POLICY : null,
        readCredential: async () => ({
          id: claim.id, contentID: claim.contentID, issuerAccount,
          issuerPublicKey: claim.issuerPublicKey, subject: claim.subject,
          holderPublicKey: claim.holderPublicKey, scope: POLICY.scope,
          active: !revoked, observedAtMs: Date.now(),
          validUntilSeconds: intent.expiresAt + 86_400,
        }),
        acceptedIssuer: async (account, key, scope) =>
          account.toLowerCase() === issuerAccount &&
          key === claim.issuerPublicKey && scope === POLICY.scope,
        isAlreadySpent: async () => voucher !== null,
      });
      setVoucher(output.voucher);
      setAlice({
        amount: 200,
        colors: POLICY.palette.map((p) => 200*p/10_000) as Mix["colors"],
      });
      setMessage("Real private predicate proof verified. The 200 $ATTEST mint below is SIMULATED; there is no signed verifier voucher or chain write in this browser demo.");
    } catch (err) {
      setMessage(err instanceof Error ? `Rejected: ${err.message}` : String(err));
    } finally { setWorking(false); }
  };

  const move = () => {
    const n = Math.min(50, alice.amount);
    if (n <= 0) return;
    const moved = alice.colors.map((p) => p * n / alice.amount) as Mix["colors"];
    setAlice({ amount: alice.amount - n, colors: alice.colors.map((p,i) => p - moved[i]!) as Mix["colors"] });
    setBob({ amount: bob.amount + n, colors: bob.colors.map((p,i) => p + moved[i]!) as Mix["colors"] });
    setTransfers((count) => count + 1);
  };
  return <section className="page-section economy-lab">
    <div className="economy-head">
      <div>
        <span className="eyebrow">EXPERIMENTAL ECONOMIC COMPOSITION</span>
        <h1>Private proof. Public expression.</h1>
        <p>Issue a fictional signed claim, prove its hidden score is sufficient, and explore how its economic provenance could move between wallets.</p>
      </div>
      <Badge variant="outline">Browser simulation · no chain writes</Badge>
    </div>
    <div className="economy-info">
      <p><strong>Claim NFT:</strong> optional, opaque public record. <strong>$ATTEST:</strong> fixed policy-authorized economic units. <strong>Passport NFT:</strong> live artwork derived from wallet balance and provenance mix.</p>
      <p>All issuers and statuses in this page are fictional. The proof is cryptographic; the example issuer registry and token mint are simulated.</p>
    </div>
    <TokenStory compact />
    <div className="economy-step">
      <div className="economy-stephead"><h2>1. Issue a private claim</h2><Badge variant="outline">Signed POD</Badge></div>
      <p>The hidden score is signed by a fictional issuer. Conversion requires at least 700; eligibility releases a fixed 200 test units.</p>
      <div className="economy-picks">
        {([400, 880, 1000] as const).map((n) => <Button key={n} variant={score===n?"primary":"secondary"} onClick={() => setScore(n)} disabled={working}>Score {n}</Button>)}
        <Button onClick={issue} disabled={working}>Issue synthetic claim</Button>
      </div>
      {record && <div className="economy-evidence">
        <strong>Claim {record.claim.id.slice(0,24)}…</strong>
        <span>Private credential signed · score hidden from public output</span>
        <span>Issuer signature and content ID available to the private verifier</span>
      </div>}
    </div>
    <div className="economy-step">
      <div className="economy-stephead"><h2>2. Prove conversion eligibility</h2><Badge variant="outline">Real GPC / synthetic status</Badge></div>
      <p>The browser proves a signed private claim satisfies a fixed score threshold, domain, holder, event and validity rule. A trusted verifier would then sign the mint voucher.</p>
      <div className="economy-picks">
        <Button onClick={() => { void prove(); }} disabled={!record || working || voucher!==null || revoked}>{working?"Computing real proof...":"Generate private proof"}</Button>
        {record && <Button variant="secondary" disabled={working || revoked} onClick={() => {setRevoked(true);setMessage("Synthetic issuer revoked the claim. Existing economic units remain; future authorization must fail.");}}>Revoke claim</Button>}
      </div>
      {message && <p role="status" className="economy-message">{message}</p>}
      {voucher && <div className="economy-evidence">
        <strong>Verified private conversion entitlement</strong>
        <span>Authorized simulated amount: {String(voucher.amount/10n**18n)} ATTEST</span>
        <span>Event nullifier: {voucher.nullifier.slice(0,18)}… · only one real on-chain mint would be permitted</span>
      </div>}
    </div>
    <div className="economy-step">
      <div className="economy-stephead"><h2>3. Living economic passports</h2><Badge variant="outline">Transfer simulation</Badge></div>
      <p>Bob begins with a fictional 80-unit gold position, so incoming provenance visibly combines with an existing mixture. These are mathematical previews, not wallet balances.</p>
      <div className={`economy-portraits ${transfers > 0 ? "economy-portraits--transfer" : ""}`} key={transfers}>
        <Portrait name="Alice" mix={alice}/>
        <span className="economy-portrait-arrow" aria-hidden="true">→</span>
        <Portrait name="Bob" mix={bob}/>
      </div>
      <p className="economy-transfer-note" role="status" aria-live="polite">
        {transfers > 0
          ? `${transfers * 50} simulated units transferred to Bob. The original signed claim never moved.`
          : "Select an eligible private claim, prove it, and watch a 50-unit ERC-20 transfer mix the colors."}
      </p>
      <div className="economy-picks">
        <Button onClick={move} disabled={!voucher || alice.amount===0}>Simulate transfer: 50 ATTEST → Bob</Button>
        <Button variant="secondary" onClick={() => {setAlice(zero);setBob(initialBob);setTransfers(0);setVoucher(null);setRecord(null);setMessage("");setRevoked(false);}}>Reset lab</Button>
      </div>
      <div className="economy-legend">{labels.map((label,i)=><span key={label}><i style={{backgroundColor:colors[i]}}/>{label}</span>)}</div>
    </div>
    <div className="economy-info">
      <strong>Actual system status:</strong> experimental Sepolia contracts, a verifier bridge, and a separate native-ZK test circuit are in merged source. This page does not deploy contracts, issue real tokens or sign mint receipts. Mainnet remains disabled.
      <div style={{marginTop:12}}><LinkButton href="https://github.com/gmackie/attest/blob/main/specs/private-conversion.md" variant="secondary">Read the protocol boundary ↗</LinkButton></div>
    </div>
  </section>;
}
