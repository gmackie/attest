import { WalletIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  InputGroup,
  LayerCard,
  LinkButton,
} from "@cloudflare/kumo";
import { Effect } from "effect";
import type { Address, EIP1193Provider, Hex } from "@attest/chain-evm";
import { commitValue } from "@attest/core";
import { encryptVault, decryptVault } from "@attest/wallet";
import {
  clients,
  assertContext,
  checkedAddress,
  checkedHash,
  deployIndustryRegistry,
  validateIndustryRegistry,
  readIndustryRecords,
  type JourneyArtifact,
} from "@attest/chain-evm";
import {
  industryIds,
  industryDefinition,
  industryWallets,
  industryProfile,
  industryNamespace,
  newIndustryVault,
  parseIndustryVault,
  industryCommandSchema,
  industryCommandMessage,
  requestIndustry,
  prepareIndustry,
  verifyIndustry,
  type ConnectedIndustry,
  type IndustryVault,
  type IndustryRequest,
  type IndustryPresentation,
} from "@attest/demo";
import {
  contractDocument,
  contractLevels,
  type ContractLevel,
} from "../../../packages/demo/src/contracts";
import type { FieldValue } from "../../../packages/demo/src/industries";
type Provider = EIP1193Provider & {
  on?: (name: string, fn: () => void) => void;
  removeListener?: (name: string, fn: () => void) => void;
};
const json = (v: unknown) => JSON.stringify(v, null, 2);
const short = (v: string) => `${v.slice(0, 8)}…${v.slice(-6)}`;
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([json(data)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function DemoChooser() {
  return (
    <section className="page-section">
      <span className="eyebrow">REAL WALLETS · FICTIONAL INSTITUTIONS</span>
      <h1>Take the journey onchain.</h1>
      <p>
        Collect signed credentials from independent institution wallets. Prove
        the required facts privately, then ask a verifier to record its decision
        on Sepolia.
      </p>
      <div className="testnet-mode-note">
        <WalletIcon size={24} />
        <div>
          <strong>Connect your own EVM wallet · Ethereum Sepolia</strong>
          <p>
            Fictional institutions use real issuer wallets. Your wallet signs
            requests; funded institution wallets submit transactions. Private
            evidence stays in your encrypted passport.
          </p>
        </div>
      </div>
      <div className="controls">
        <LinkButton href="#/testnet/setup" variant="primary">
          Host: set up and fund all four demos →
        </LinkButton>
        <LinkButton href="#/app" variant="secondary">
          Manage wallet, issuer & verifier tools →
        </LinkButton>
        <LinkButton href="#/explore" variant="ghost">
          Try without a wallet →
        </LinkButton>
      </div>
      <div className="story-grid">
        <LayerCard className="infra-card">
          <Badge variant="outline">3 issuers · 1 verifier</Badge>
          <h2>Contractor passport</h2>
          <p>Training, experience and insurance for Northstar’s Project 817.</p>
          <LinkButton href="#/testnet/contractor" variant="primary">
            Build a contractor passport →
          </LinkButton>
        </LayerCard>
        {industryIds.map((id) => {
          const d = industryDefinition(id);
          return (
            <LayerCard key={id} className={`infra-card industry-${id}`}>
              <Badge variant="outline">
                5 issuers · {d.rules.length} clauses
              </Badge>
              <h2>{d.name}</h2>
              <p>{d.description}</p>
              <LinkButton href={`#/testnet/${id}`} variant="primary">
                {d.purpose} →
              </LinkButton>
              <LinkButton href={`#/explore/${id}`} variant="ghost">
                Explore the local story
              </LinkButton>
            </LayerCard>
          );
        })}
      </div>
      <p className="muted">
        Each demo uses a separate shared registry. The host deploys and funds
        its institution wallets once; visitors sign requests without paying
        transaction gas. Experimental and unaudited. Synthetic inputs only.
      </p>
    </section>
  );
}
export function IndustryJourney({ industry }: { industry: ConnectedIndustry }) {
  const [level, setLevel] = useState<ContractLevel>("standard"),
    definition = industryDefinition(industry, level),
    directory = industryWallets[industry];
  const [account, setAccount] = useState<Address | null>(null),
    [registry, setRegistry] = useState(
      () =>
        new URLSearchParams(location.hash.split("?")[1] ?? "").get(
          "registry",
        ) ?? "",
    ),
    [ready, setReady] = useState(false),
    [step, setStep] = useState(0),
    [vault, setVault] = useState<IndustryVault | null>(null),
    [passphrase, setPassphrase] = useState(""),
    [keepLocal, setKeepLocal] = useState(true),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [funding, setFunding] = useState("0.006"),
    [consent, setConsent] = useState(false),
    [request, setRequest] = useState<IndustryRequest | null>(null),
    [presentation, setPresentation] = useState<IndustryPresentation | null>(
      null,
    ),
    [checks, setChecks] = useState<Awaited<ReturnType<typeof verifyIndustry>>>(
      [],
    ),
    [chain, setChain] = useState<Awaited<
      ReturnType<typeof readIndustryRecords>
    > | null>(null),
    [transaction, setTransaction] = useState<Hex | null>(null),
    [approved, setApproved] = useState(false),
    [progress, setProgress] = useState(0);
  const [inputs, setInputs] = useState(() =>
    definition.sources.map((s) =>
      Object.fromEntries(s.fields.map((f) => [f.id, f.value])),
    ),
  );
  const provider = useRef<Provider | null>(null),
    generation = useRef(0),
    lock = useRef(false),
    stored = useRef<string | null>(null),
    artifact = useRef<JourneyArtifact | null>(null),
    file = useRef<HTMLInputElement>(null);
  const clearProof = () => {
    setRequest(null);
    setPresentation(null);
    setChecks([]);
    setConsent(false);
    setApproved(false);
    setProgress(0);
  };
  const resetContext = () => {
    generation.current++;
    lock.current = false;
    setBusy(false);
    setAccount(null);
    setVault(null);
    setPassphrase("");
    setReady(false);
    setStep(0);
    setChain(null);
    setTransaction(null);
    stored.current = null;
    clearProof();
  };
  useEffect(() => {
    provider.current =
      (window as unknown as { ethereum?: Provider }).ethereum ?? null;
    const p = provider.current;
    const changed = () => {
      resetContext();
      setMessage("Wallet changed. Reconnect to unlock the matching passport.");
    };
    for (const event of ["accountsChanged", "chainChanged", "disconnect"])
      p?.on?.(event, changed);
    return () => {
      generation.current++;
      for (const event of ["accountsChanged", "chainChanged", "disconnect"])
        p?.removeListener?.(event, changed);
    };
  }, []);
  useEffect(() => {
    let active = true;
    void Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const r = await fetch("/industry-deployments.json");
          if (r.ok) {
            const config = await r.json();
            if (
              active &&
              config.chainId === 11155111 &&
              config.registries?.[industry]
            )
              setRegistry((current) => current || config.registries[industry]);
          }
        },
        catch: () => new Error("Configuration unavailable"),
      }),
    ).catch(() => {});
    return () => {
      active = false;
    };
  }, [industry]);
  const run = (
    label: string,
    action: (check: () => void) => Promise<unknown>,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage(label);
    const token = generation.current;
    const check = () => {
      if (token !== generation.current)
        throw new Error("Wallet context changed; discarded result");
    };
    void Effect.runPromise(
      Effect.tryPromise({
        try: () => action(check),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
    )
      .catch((e) => {
        if (token === generation.current) {
          setError(e.message);
          setMessage("");
        }
      })
      .finally(() => {
        if (token === generation.current) {
          lock.current = false;
          setBusy(false);
        }
      });
  };
  const context = () => {
    if (!account || !provider.current)
      throw new Error("Connect your Sepolia wallet");
    return {
      account,
      registry: checkedAddress(registry),
      provider: provider.current,
    };
  };
  const build = async () => {
    if (!artifact.current) {
      const r = await fetch("/contracts/IndustryRegistry.json");
      if (!r.ok) throw new Error("Deployment artifact unavailable");
      artifact.current = (await r.json()) as JourneyArtifact;
    }
    return artifact.current;
  };
  const validate = async () => {
    const c = context();
    await validateIndustryRegistry(
      c.provider,
      c.account,
      c.registry,
      await build(),
      checkedHash(await commitValue(industryProfile(industry))),
      directory.map((i) => i.address),
      await Promise.all(
        directory.slice(0, 5).map((i) => commitValue(i.credentialPublicKey)),
      ),
    );
  };
  const save = async (next: IndustryVault, check: () => void) => {
    const parsed = parseIndustryVault(next),
      key = industryNamespace(industry, parsed.account, parsed.registry);
    const encoded = keepLocal
      ? json(await encryptVault(parsed, passphrase, key))
      : null;
    check();
    if (encoded) {
      if (localStorage.getItem(key) !== stored.current)
        throw new Error(
          "Passport changed in another tab. Unlock before saving.",
        );
      localStorage.setItem(key, encoded);
      stored.current = encoded;
    }
    setVault(parsed);
  };
  const refresh = async (v: IndustryVault, check: () => void) => {
    await validate();
    const c = context(),
      state = await readIndustryRecords(
        c.provider,
        c.account,
        c.registry,
        checkedHash(await commitValue(v.journey)),
      );
    check();
    setChain(state);
    return state;
  };
  const api = async (path: string, body: unknown) => {
    const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json(body),
      }),
      data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "Institution request failed");
    return data;
  };
  const wait = async (hash: Hex, check: () => void) => {
    check();
    setTransaction(hash);
    const c = context(),
      receipt = await clients(
        c.provider,
        "testnet",
      ).reader.waitForTransactionReceipt({ hash, timeout: 120000 });
    check();
    if (receipt.status !== "success") throw new Error("Transaction reverted");
    return receipt;
  };
  const connect = () =>
    run("Connecting to Ethereum Sepolia…", async (check) => {
      const p = provider.current;
      if (!p)
        throw new Error(
          "Open this site in an EVM wallet browser or install an injected wallet",
        );
      const accounts = (await p.request({
        method: "eth_requestAccounts",
      })) as string[];
      check();
      const a = checkedAddress(accounts[0]!);
      await assertContext(p, "testnet", a, true);
      check();
      setAccount(a);
      setMessage("Connected. Join or launch the registry for this industry.");
    });
  const join = () =>
    run("Checking industry and institution authority…", async (check) => {
      await validate();
      check();
      const c = context();
      stored.current = localStorage.getItem(
        industryNamespace(industry, c.account, c.registry),
      );
      setReady(true);
      setMessage("Registry and all six institution wallets verified.");
    });
  const deploy = () =>
    run(
      "Review deployment and institution funding in your wallet…",
      async (check) => {
        if (!account || !provider.current) throw new Error("Connect first");
        if (
          !/^\d+(\.\d{1,6})?$/.test(funding) ||
          Number(funding) < 0 ||
          Number(funding) > 0.1
        )
          throw new Error("Choose 0–0.1 Sepolia ETH");
        const p = provider.current,
          a = account,
          hash = await deployIndustryRegistry(
            p,
            a,
            await build(),
            checkedHash(await commitValue(industryProfile(industry))),
            directory.map((i) => checkedAddress(i.address)) as [
              Address,
              Address,
              Address,
              Address,
              Address,
              Address,
            ],
            (
              await Promise.all(
                directory
                  .slice(0, 5)
                  .map((i) => commitValue(i.credentialPublicKey)),
              )
            ).map(checkedHash) as [Hex, Hex, Hex, Hex, Hex],
            BigInt(Math.round(Number(funding) * 1e6)) * 1000000000000n,
          );
        check();
        setTransaction(hash);
        const receipt = await clients(
          p,
          "testnet",
        ).reader.waitForTransactionReceipt({ hash, timeout: 120000 });
        check();
        if (receipt.status !== "success" || !receipt.contractAddress)
          throw new Error("Deployment failed");
        setRegistry(receipt.contractAddress);
        history.replaceState(
          null,
          "",
          `#/demo/${industry}?registry=${receipt.contractAddress}`,
        );
        stored.current = null;
        setReady(true);
        setMessage(
          "Registry deployed and institution wallets funded. Share the public invitation. Transaction included; finality is pending.",
        );
      },
    );
  const restore = async (
    data: unknown,
    check: () => void,
    persisted: string | null,
  ) => {
    const c = context(),
      key = industryNamespace(industry, c.account, c.registry),
      next = parseIndustryVault(await decryptVault(data, passphrase, key));
    if (
      next.industry !== industry ||
      next.account !== c.account.toLowerCase() ||
      next.registry !== c.registry.toLowerCase()
    )
      throw new Error(
        "Passport belongs to another wallet, registry or industry",
      );
    await refresh(next, check);
    check();
    setVault(next);
    setKeepLocal(!!persisted);
    stored.current = persisted;
    setStep(1);
    setMessage("Passport unlocked and current chain status checked.");
  };
  const authorize = async (
    v: IndustryVault,
    id: number,
    action: "issue" | "revoke",
    values: Record<string, FieldValue>,
    validThrough: string,
    check: () => void,
  ) => {
    await validate();
    const c = context(),
      command = industryCommandSchema.parse({
        version: 1,
        chainId: 11155111,
        domain: "attest.gmac.io",
        industry,
        account: c.account,
        registry: c.registry,
        journey: v.journey,
        holderPublicKey: v.holderPublicKey,
        institution: id,
        action,
        fields: values,
        validThrough,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        nonce: crypto.randomUUID(),
        demoConsent: true,
      }),
      signature = await clients(c.provider, "testnet").wallet.signMessage({
        account: c.account,
        message: industryCommandMessage(command),
      });
    check();
    await assertContext(c.provider, "testnet", c.account);
    return api("/api/v3/credentials", { command, signature });
  };
  const issue = (id: number) =>
    run(
      "Authorize synthetic issuance; the institution pays registration gas…",
      async (check) => {
        if (!vault) throw new Error("Create a passport");
        let v = vault;
        let plan = v.plans.find((p) => p.institution === id);
        if (!plan) {
          plan = {
            institution: id,
            fields: inputs[id]!,
            validThrough: new Date(Date.now() + 180 * 86400000)
              .toISOString()
              .slice(0, 10),
          };
          v = { ...v, plans: [...v.plans, plan] };
          await save(v, check);
        }
        const data = await authorize(
          v,
          id,
          "issue",
          plan.fields,
          plan.validThrough,
          check,
        );
        check();
        await save(
          {
            ...v,
            credentials: [
              ...v.credentials.filter((c) => c.institution !== id),
              data.credential,
            ],
          },
          check,
        );
        await wait(data.transactionHash, check);
        await refresh(v, check);
        clearProof();
        setMessage(
          `${definition.sources[id]!.name} signed all fields and registered the commitment from its own wallet.`,
        );
      },
    );
  const revoke = (id: number) =>
    run(
      "Authorize permanent revocation by this institution…",
      async (check) => {
        if (!vault) throw new Error("Passport missing");
        const c = vault.credentials.find((c) => c.institution === id);
        if (!c) throw new Error("Credential missing");
        const data = await authorize(
          vault,
          id,
          "revoke",
          c.fields,
          c.validThrough,
          check,
        );
        await wait(data.transactionHash, check);
        await refresh(vault, check);
        setApproved(false);
        setChecks([]);
        setMessage(
          "Issuer revoked this credential. Existing proofs will fail a fresh status check.",
        );
      },
    );
  const evaluate = async (check: () => void) => {
    if (!vault || !request || !presentation)
      throw new Error("Generate proofs first");
    const state = await refresh(vault, check),
      result = await verifyIndustry(
        presentation,
        request,
        state.records,
        state.timestamp,
      );
    check();
    setChecks(result);
    setApproved(false);
    return result;
  };
  const id = step - 1,
    source = definition.sources[id],
    credential = vault?.credentials.find((c) => c.institution === id),
    plan = vault?.plans.find((p) => p.institution === id),
    record = chain?.records[id],
    invitation = registry
      ? `${location.origin}/#/demo/${industry}?registry=${registry}`
      : "";
  return (
    <section className={`page-section testnet-journey industry-${industry}`}>
      <LinkButton href="#/demo" variant="ghost">
        ← All testnet journeys
      </LinkButton>
      <div className="journey-intro">
        <div>
          <span className="eyebrow">
            {definition.name.toUpperCase()} · REAL WALLETS
          </span>
          <h1>
            {definition.purpose}.<br />
            <span>Proven privately.</span>
          </h1>
          <p>{definition.description}</p>
        </div>
        <div className="journey-network">
          <Badge variant="outline">Ethereum Sepolia · fictional claims</Badge>
          <strong>
            {account ? short(account) : "Your wallet. Your evidence."}
          </strong>
          <small>5 issuer wallets · 1 verifier wallet</small>
          <Button disabled={busy} onClick={connect}>
            {account ? "Reconnect wallet" : "Connect wallet"}
          </Button>
        </div>
      </div>
      <nav className="journey-progress" aria-label="Industry passport steps">
        {[
          "Your wallet",
          ...definition.sources.map((s) => s.role),
          "Verify",
        ].map((label, i) => (
          <Button
            key={i}
            variant={step === i ? "primary" : "secondary"}
            disabled={busy || (i > 0 && !vault)}
            aria-current={step === i ? "step" : undefined}
            onClick={() => setStep(i)}
          >
            {i + 1} {label}
            {i > 0 &&
            i < 6 &&
            vault?.credentials.some((c) => c.institution === i - 1)
              ? " ✓"
              : ""}
          </Button>
        ))}
      </nav>
      {error && (
        <Banner
          variant="error"
          title="This step needs attention"
          description={error}
        />
      )}{" "}
      {message && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
      {transaction && (
        <p>
          <a
            href={`https://sepolia.etherscan.io/tx/${transaction}`}
            target="_blank"
            rel="noreferrer"
          >
            View institution or deployment transaction ↗
          </a>{" "}
          · Included transactions may not be finalized.
        </p>
      )}
      <details className="quiet-details">
        <summary>Meet the six institution wallets</summary>
        <div className="story-grid">
          {directory.map((i, index) => (
            <div key={i.id}>
              <strong>{i.name}</strong>
              <p>
                {index === 5 ? "Verifier" : definition.sources[index]!.role}
              </p>
              <a
                href={`https://sepolia.etherscan.io/address/${i.address}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(i.address)} ↗
              </a>
              <details>
                <summary>Credential public key</summary>
                <code className="industry-wrap">{i.credentialPublicKey}</code>
              </details>
            </div>
          ))}
        </div>
        <p>
          Institution private keys stay in server secrets. Synthetic evidence is
          processed transiently; public transaction metadata and sponsorship
          counters are retained.
        </p>
      </details>
      {step === 0 && (
        <div className="journey-columns">
          <LayerCard className="infra-card">
            <span className="eyebrow">01 / YOUR PRIVATE PASSPORT</span>
            <h2>Connect. Collect. Prove.</h2>
            <p>
              Your EVM account authorizes requests. A separate credential key,
              stored in your encrypted passport, signs proof presentations. Each
              institution pays for its own chain transactions.
            </p>
            <InputGroup
              label="Industry registry address"
              disabled={busy || !!vault}
            >
              <InputGroup.Input
                aria-label="Industry registry address"
                value={registry}
                onChange={(e) => {
                  setRegistry(e.target.value);
                  setReady(false);
                  clearProof();
                }}
                placeholder="0x…"
              />
            </InputGroup>
            <Button
              disabled={busy || !account || !registry || !!vault}
              onClick={join}
            >
              Join this industry registry
            </Button>
            {ready && (
              <>
                <InputGroup
                  label="Passport passphrase (12+ characters)"
                  disabled={busy}
                >
                  <InputGroup.Input
                    aria-label="Passport passphrase (12+ characters)"
                    type="password"
                    autoComplete="new-password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                </InputGroup>
                <Checkbox
                  label="Save an encrypted passport in this browser"
                  checked={keepLocal}
                  disabled={busy}
                  onCheckedChange={(v) => setKeepLocal(v === true)}
                />
                <div className="controls">
                  <Button
                    disabled={busy || !!vault}
                    onClick={() =>
                      run("Creating encrypted passport…", async (check) => {
                        const c = context();
                        await validate();
                        await save(
                          newIndustryVault(industry, c.account, c.registry),
                          check,
                        );
                        setStep(1);
                        setMessage(
                          "Passport ready. Visit your first institution.",
                        );
                      })
                    }
                  >
                    Create passport
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || !!vault}
                    onClick={() =>
                      run("Unlocking passport…", async (check) => {
                        const c = context(),
                          saved = localStorage.getItem(
                            industryNamespace(industry, c.account, c.registry),
                          );
                        if (!saved)
                          throw new Error(
                            "No saved passport; create or restore one",
                          );
                        await restore(JSON.parse(saved), check, saved);
                      })
                    }
                  >
                    Unlock saved passport
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => file.current?.click()}
                  >
                    Restore encrypted backup
                  </Button>
                  <input
                    hidden
                    ref={file}
                    type="file"
                    accept="application/json"
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f)
                        run("Restoring passport…", async (check) => {
                          if (f.size > 12000000)
                            throw new Error("Backup too large");
                          await restore(
                            JSON.parse(await f.text()),
                            check,
                            null,
                          );
                        });
                    }}
                  />
                </div>
                {vault && (
                  <div className="controls">
                    <Button disabled={busy} onClick={() => setStep(1)}>
                      Continue collecting →
                    </Button>
                    <Button
                      disabled={busy}
                      variant="secondary"
                      onClick={() =>
                        run("Encrypting backup…", async (check) => {
                          const data = await encryptVault(
                            vault,
                            passphrase,
                            industryNamespace(
                              industry,
                              vault.account,
                              vault.registry,
                            ),
                          );
                          check();
                          download(`attest-${industry}.encrypted.json`, data);
                          setMessage(
                            "Encrypted backup exported. Keep its passphrase separately.",
                          );
                        })
                      }
                    >
                      Export encrypted passport
                    </Button>
                    <Button
                      disabled={busy}
                      variant="ghost"
                      onClick={() => {
                        setVault(null);
                        setPassphrase("");
                        clearProof();
                        setMessage(
                          "Passport locked. Saved encrypted copy remains.",
                        );
                      }}
                    >
                      Lock passport
                    </Button>
                  </div>
                )}
                <p className="muted">
                  Losing your passport or passphrase loses access to private
                  evidence. Chain commitments cannot restore it. Export after
                  collecting credentials.
                </p>
                <InputGroup label="Public invitation">
                  <InputGroup.Input
                    aria-label="Public invitation"
                    readOnly
                    value={invitation}
                  />
                </InputGroup>
                <Button
                  variant="secondary"
                  onClick={() =>
                    run("Copying invitation…", async () => {
                      await navigator.clipboard.writeText(invitation);
                      setMessage("Public invitation copied.");
                    })
                  }
                >
                  Copy invitation
                </Button>
              </>
            )}
          </LayerCard>
          <aside>
            <LayerCard className="infra-card">
              <h3>Host: launch this industry demo</h3>
              <p>
                One transaction deploys this profile’s registry and divides your
                chosen Sepolia test ETH among its six wallets. Default: 0.001
                ETH each, plus deployment gas.
              </p>
              <InputGroup label="Total Sepolia ETH funding" disabled={busy}>
                <InputGroup.Input
                  aria-label="Total Sepolia ETH funding"
                  type="number"
                  min={0}
                  max={0.1}
                  step={0.001}
                  value={funding}
                  onChange={(e) => setFunding(e.target.value)}
                />
              </InputGroup>
              <Button disabled={busy || !account || !!vault} onClick={deploy}>
                Launch {definition.name} demo
              </Button>
              <p>
                After deployment, share the public invitation. No wallet private
                key is shared.
              </p>
            </LayerCard>
            <LayerCard className="infra-card">
              <h3>Fictional, but cryptographically real</h3>
              <p>
                Use synthetic values only. These signatures prove which demo
                institution issued the record; they do not establish real
                qualifications, funding, sensor truth or legal eligibility.
              </p>
            </LayerCard>
          </aside>
        </div>
      )}
      {source && vault && (
        <div className="journey-columns">
          <LayerCard className="infra-card">
            <div className="institution-heading">
              <span className="institution-mark">{source.short}</span>
              <div>
                <span className="eyebrow">
                  ISSUER {step} OF 5 · {source.role}
                </span>
                <h2>{source.name}</h2>
              </div>
            </div>
            <p>
              Enter the synthetic record held in its{" "}
              <strong>{source.system.toLowerCase()}</strong>. The institution
              signs these fields together in one credential.
            </p>
            <div className="industry-fields">
              {source.fields.map((f) => {
                const value =
                  plan?.fields[f.id] ??
                  credential?.fields[f.id] ??
                  inputs[id]![f.id]!;
                return f.type === "boolean" ? (
                  <Checkbox
                    key={f.id}
                    label={f.label}
                    checked={value === true}
                    disabled={busy || !!plan || !!credential}
                    onCheckedChange={(v) =>
                      setInputs((old) =>
                        old.map((row, i) =>
                          i === id ? { ...row, [f.id]: v === true } : row,
                        ),
                      )
                    }
                  />
                ) : (
                  <InputGroup
                    key={f.id}
                    disabled={busy || !!plan || !!credential}
                    label={`${f.label}${f.unit ? ` (${f.unit})` : ""}`}
                  >
                    <InputGroup.Input
                      aria-label={f.label}
                      type={
                        f.type === "number"
                          ? "number"
                          : f.type === "date"
                            ? "date"
                            : "text"
                      }
                      step={f.type === "number" ? 0.001 : undefined}
                      value={String(value)}
                      onChange={(e) =>
                        setInputs((old) =>
                          old.map((row, i) =>
                            i === id
                              ? {
                                  ...row,
                                  [f.id]:
                                    f.type === "number"
                                      ? Number(e.target.value)
                                      : e.target.value,
                                }
                              : row,
                          ),
                        )
                      }
                    />
                  </InputGroup>
                );
              })}
            </div>
            <details className="quiet-details" open>
              <summary>Clauses this institution must satisfy</summary>
              {definition.rules
                .filter((r) => r.source === source.id)
                .map((r) => (
                  <p key={r.field}>
                    <strong>{r.label}</strong>
                    <br />
                    {r.field}{" "}
                    {r.operator === "eq"
                      ? "="
                      : r.operator === "gte"
                        ? "≥"
                        : "≤"}{" "}
                    {String(r.value)}
                  </p>
                ))}
            </details>
            {!credential ? (
              <Button disabled={busy} onClick={() => issue(id)}>
                {plan
                  ? "Retry this institution request"
                  : "Authorize & receive credential"}
              </Button>
            ) : (
              <>
                <Banner
                  variant={record?.revoked ? "error" : "secondary"}
                  title={
                    record?.revoked
                      ? "Revoked by issuer"
                      : "Signed credential received"
                  }
                  description={
                    record?.revoked
                      ? "Start a new journey to obtain new evidence."
                      : "Exact values stay in your private passport. A salted commitment and status are public on Sepolia."
                  }
                />
                <Button
                  disabled={busy || !!record?.revoked}
                  onClick={() => setStep(step + 1)}
                >
                  {step === 5
                    ? `Meet ${definition.verifier} →`
                    : "Next institution →"}
                </Button>
                <details className="quiet-details">
                  <summary>Inspect signed statement & storage</summary>
                  <pre>
                    {json({
                      issuer: source.name,
                      system: source.system,
                      schema: source.schema,
                      subject: short(vault.account),
                      journey: vault.journey,
                      fields: credential.fields,
                      validThrough: credential.validThrough,
                      contentID: credential.contentID,
                      pod: credential.pod,
                    })}
                  </pre>
                </details>
                <details className="quiet-details">
                  <summary>Try permanent revocation</summary>
                  <p>
                    The issuer submits a real revocation. Any existing proof
                    must fail a fresh status check.
                  </p>
                  <Button
                    variant="secondary"
                    disabled={busy || !!record?.revoked}
                    onClick={() => revoke(id)}
                  >
                    Ask issuer to revoke
                  </Button>
                </details>
              </>
            )}
          </LayerCard>
          <aside>
            <LayerCard className="infra-card">
              <h3>Follow this record</h3>
              <ol className="industry-data-flow">
                <li>
                  <strong>Institution input</strong>
                  <p>
                    {source.system}: the synthetic fields shown here are
                    processed transiently by {source.name}.
                  </p>
                </li>
                <li>
                  <strong>Private passport</strong>
                  <p>
                    A signed POD binds every field to your wallet, this
                    industry, registry, journey and private holder key.
                  </p>
                </li>
                <li>
                  <strong>Sepolia</strong>
                  <p>
                    The issuer wallet registers a salted content commitment,
                    holder-key commitment, expiry and status. Addresses and
                    activity are public and linkable.
                  </p>
                </li>
                <li>
                  <strong>{definition.verifier}</strong>
                  <p>
                    Receives a proof of each clause and its public inputs. The
                    raw record and exact numeric values stay private. An
                    equality clause necessarily reveals the expected value.
                  </p>
                </li>
              </ol>
            </LayerCard>
            <LinkButton href={`#/explore/${industry}`} variant="ghost">
              Explore the source systems →
            </LinkButton>
          </aside>
        </div>
      )}
      {step === 6 && vault && (
        <div className="journey-columns">
          <LayerCard className="infra-card">
            <span className="eyebrow">INDEPENDENT VERIFIER</span>
            <h2>{definition.verifier}</h2>
            <p>
              {definition.purpose}: all {definition.rules.length} clauses must
              pass. Evidence remains within its original institution and
              subject.
            </p>
            <div className="controls">
              {contractLevels.map((l) => (
                <Button
                  key={l.value}
                  variant={level === l.value ? "primary" : "secondary"}
                  disabled={busy}
                  onClick={() => {
                    setLevel(l.value);
                    clearProof();
                  }}
                >
                  {l.label}
                </Button>
              ))}
            </div>
            <details className="quiet-details">
              <summary>Read the detailed agreement and statements</summary>
              <h3>{contractDocument(definition).title}</h3>
              <p>{contractDocument(definition).scope}</p>
              <p>{contractDocument(definition).logic}</p>
              {contractDocument(definition).clauses.map((c) => (
                <p key={c.id}>
                  <strong>
                    {c.id} · {c.issuer}
                  </strong>
                  <br />
                  {c.statement}
                </p>
              ))}
              <p>{contractDocument(definition).event}</p>
              <p>{contractDocument(definition).exclusion}</p>
            </details>
            <Button
              disabled={busy || vault.credentials.length !== 5}
              onClick={() =>
                run("Creating a contract-bound request…", async (check) => {
                  const r = await requestIndustry(vault, level);
                  check();
                  clearProof();
                  setRequest(r);
                  setMessage("Review disclosure before proving.");
                })
              }
            >
              {request ? "Create a fresh request" : "Request eligibility check"}
            </Button>
            {request && (
              <>
                <h3>You control disclosure</h3>
                <p>
                  Shared: your wallet, journey/content IDs, holder and issuer
                  public keys, agreement level, all thresholds and equality
                  requirements, expiry and request challenge. These inputs can
                  correlate your activity.
                </p>
                <p>
                  Private: raw credentials, hidden numeric values, record
                  signatures, salt and holder secret. Proof generation runs in
                  this browser.
                </p>
                <Checkbox
                  label={`Share this proof package with fictional ${definition.verifier}`}
                  checked={consent}
                  disabled={busy}
                  onCheckedChange={(v) => {
                    setConsent(v === true);
                    setApproved(false);
                  }}
                />
                <p>
                  Request expires{" "}
                  {new Date(request.expiresAt).toLocaleTimeString()}.
                </p>
                <Button
                  disabled={busy || !consent}
                  onClick={() =>
                    run("Generating five private proofs…", async (check) => {
                      setChecks([]);
                      setApproved(false);
                      const p = await prepareIndustry(
                        vault,
                        request,
                        undefined,
                        (n) => {
                          check();
                          setProgress(n);
                          setMessage(`Proof ${n} of 5 generated`);
                        },
                      );
                      check();
                      setPresentation(p);
                      setMessage(
                        "Five private proofs ready. Check locally or submit to the verifier.",
                      );
                    })
                  }
                >
                  Generate private proofs
                </Button>
                <progress
                  aria-label="Private proof generation"
                  max={5}
                  value={progress}
                />
                {presentation && (
                  <>
                    <div className="controls">
                      <Button
                        disabled={busy || !consent}
                        variant="secondary"
                        onClick={() =>
                          run(
                            "Checking proofs against current chain status…",
                            async (check) => {
                              await evaluate(check);
                              setMessage(
                                "Local checks complete. The verifier makes its own decision.",
                              );
                            },
                          )
                        }
                      >
                        Check locally
                      </Button>
                      <Button
                        disabled={busy || !consent}
                        onClick={() =>
                          run(
                            "Verifier independently checks every proof and current status…",
                            async (check) => {
                              const result = await evaluate(check);
                              if (result.some((c) => !c.pass))
                                throw new Error(
                                  "Local checks failed; inspect results",
                                );
                              await validate();
                              const data = await api("/api/v3/decisions", {
                                request,
                                presentation,
                              });
                              check();
                              await wait(data.transactionHash, check);
                              setChecks(data.checks);
                              setApproved(true);
                              setMessage(
                                `${definition.verifier} verified your proofs and recorded approval from its own wallet at checked block ${data.checkedBlock}.`,
                              );
                            },
                          )
                        }
                      >
                        Verify & record decision
                      </Button>
                      <Button
                        disabled={busy || !consent}
                        variant="ghost"
                        onClick={() =>
                          download(`attest-${industry}-proofs.json`, {
                            request,
                            presentation,
                          })
                        }
                      >
                        Export public proofs
                      </Button>
                    </div>
                    <details className="quiet-details">
                      <summary>Inspect the request & proof package</summary>
                      <pre>{json({ request, presentation })}</pre>
                    </details>
                  </>
                )}
              </>
            )}
            {checks.length > 0 && (
              <div className="journey-result">
                <h3>
                  {approved
                    ? "Verifier approval recorded"
                    : checks.every((c) => c.pass)
                      ? "Local checks passed"
                      : "Requirements not satisfied"}
                </h3>
                {checks.map((c) => (
                  <div className="wallet-check" key={c.name}>
                    <strong>
                      {c.pass ? "✓" : "×"} {c.name}
                    </strong>
                    <p>{c.detail}</p>
                  </div>
                ))}
                <p>
                  Off-chain verification at a recent Sepolia block. The EVM
                  authenticates the verifier transaction; it does not execute
                  GPC verification. Revocation or expiry can change eligibility
                  after approval.
                </p>
              </div>
            )}
          </LayerCard>
          <aside>
            <LayerCard className="infra-card">
              <h3>One coherent credential per source</h3>
              <p>
                All constraints from one institution are proven against one
                signed record. A good result from another issuer, wallet,
                journey or industry cannot substitute for a missing fact.
              </p>
              <h3>Try a stricter contract</h3>
              <p>
                Enhanced and critical levels change the required thresholds. You
                can reuse the same credentials to discover which clauses they
                cannot satisfy.
              </p>
              <h3>Keep your evidence</h3>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setStep(0)}
              >
                Back up passport
              </Button>
            </LayerCard>
          </aside>
        </div>
      )}
      {vault && (
        <details className="quiet-details">
          <summary>Start a new journey</summary>
          <p>
            This removes only this browser’s encrypted passport. Export a backup
            first. Public chain records remain.
          </p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              localStorage.removeItem(
                industryNamespace(industry, vault.account, vault.registry),
              );
              stored.current = null;
              setVault(null);
              setChain(null);
              setStep(0);
              clearProof();
              setInputs(
                definition.sources.map((s) =>
                  Object.fromEntries(s.fields.map((f) => [f.id, f.value])),
                ),
              );
              setMessage("Local passport removed. Create a new journey.");
            }}
          >
            Remove local passport & start over
          </Button>
        </details>
      )}
      <p className="muted">
        Experimental POD/GPC backend, beta and unaudited. Testnet only. Attest
        stores no private evidence.{" "}
        <LinkButton href="#/learn/infrastructure" variant="ghost">
          EVM & clearinghouses →
        </LinkButton>
      </p>
    </section>
  );
}
