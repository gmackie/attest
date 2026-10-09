import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  InputGroup,
  LayerCard,
  LinkButton,
  Textarea,
} from "@cloudflare/kumo";
import { Effect } from "effect";
import { commitValue } from "@attest/core";
import { encryptVault, decryptVault } from "@attest/wallet";
import {
  checkedAddress,
  checkedHash,
  clients,
  assertContext,
  institutionAbi,
  deployInstitutions,
  validateInstitutions,
  journeyDeploy,
  journeyWrite,
  journeyRecords,
  validateJourneyRegistry,
  type Address,
  type EIP1193Provider,
  type Hex,
  type JourneyArtifact,
} from "@attest/chain-evm";
import {
  fictionalInstitutions,
  createJourneyVault,
  institutionDirectory,
  institutionSigningKeys,
  institutionCommandSchema,
  commandMessage,
  type InstitutionCommand,
  journeyVaultSchema,
  journeyHolderKey,
  journeyNamespace,
  requestJourney,
  prepareJourney,
  verifyJourney,
  type JourneyVault,
  type JourneyRequest,
  type JourneyPresentation,
} from "@attest/demo";
type Provider = EIP1193Provider & {
  on?: (event: string, fn: () => void) => void;
  removeListener?: (event: string, fn: () => void) => void;
};
type Chain = Awaited<ReturnType<typeof journeyRecords>>;
const json = (value: unknown) => JSON.stringify(value, null, 2);
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([json(value)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TestnetJourney() {
  const [account, setAccount] = useState<Address | null>(null),
    [registry, setRegistry] = useState(
      () =>
        new URLSearchParams(location.hash.split("?")[1] ?? "").get(
          "registry",
        ) ?? "",
    ),
    [ready, setReady] = useState(false);
  const [funding, setFunding] = useState("0.004");
  const [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [vault, setVault] = useState<JourneyVault | null>(null),
    [passphrase, setPassphrase] = useState(""),
    [keepLocal, setKeepLocal] = useState(true);
  const [values, setValues] = useState<number[]>(
      fictionalInstitutions.map((i) => i.value),
    ),
    [chain, setChain] = useState<Chain | null>(null);
  const [request, setRequest] = useState<JourneyRequest | null>(null),
    [presentation, setPresentation] = useState<JourneyPresentation | null>(
      null,
    ),
    [consent, setConsent] = useState(false),
    [checks, setChecks] = useState<Awaited<
      ReturnType<typeof verifyJourney>
    > | null>(null),
    [progress, setProgress] = useState(0);
  const [transaction, setTransaction] = useState<{
      hash: Hex;
      label: string;
      block?: bigint;
    } | null>(null),
    [exportText, setExportText] = useState("");
  const provider = useRef<Provider | null>(null),
    artifact = useRef<JourneyArtifact | null>(null),
    generation = useRef(0),
    lock = useRef(false),
    stored = useRef<string | null>(null),
    file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step > 0)
      document.querySelector(".journey-progress")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
  }, [step]);
  const clearResult = () => {
    setRequest(null);
    setPresentation(null);
    setChecks(null);
    setConsent(false);
    setProgress(0);
  };
  const invalidate = () => {
    generation.current++;
    lock.current = false;
    setBusy(false);
    setAccount(null);
    setVault(null);
    setPassphrase("");
    setReady(false);
    setChain(null);
    setTransaction(null);
    stored.current = null;
    clearResult();
    setStep(0);
  };
  useEffect(() => {
    provider.current =
      (window as unknown as { ethereum?: Provider }).ethereum ?? null;
    const p = provider.current;
    const changed = () => {
      invalidate();
      setMessage(
        "Wallet account or network changed. Reconnect to unlock the matching passport.",
      );
    };
    p?.on?.("accountsChanged", changed);
    p?.on?.("chainChanged", changed);
    p?.on?.("disconnect", changed);
    return () => {
      generation.current++;
      p?.removeListener?.("accountsChanged", changed);
      p?.removeListener?.("chainChanged", changed);
      p?.removeListener?.("disconnect", changed);
    };
  }, []);
  useEffect(() => {
    let active = true;
    void Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const r = await fetch("/demo-deployment.json");
          if (!r.ok) return;
          const config = await r.json();
          if (
            active &&
            config.chainId === 11155111 &&
            config.registry &&
            !registry
          )
            setRegistry(
              (current) => current || checkedAddress(config.registry),
            );
        },
        catch: () => new Error("Demo configuration unavailable"),
      }),
    ).catch(() => {});
    return () => {
      active = false;
    };
  }, []);
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
        throw new Error("Wallet context changed; operation discarded");
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
  const build = async () => {
    if (!artifact.current) {
      const r = await fetch("/contracts/InstitutionRegistry.json");
      if (!r.ok) throw new Error("Demo deployment artifact unavailable");
      artifact.current = (await r.json()) as JourneyArtifact;
    }
    return artifact.current;
  };
  const context = () => {
    if (!account || !provider.current)
      throw new Error("Connect your Sepolia wallet first");
    return {
      account,
      provider: provider.current,
      registry: checkedAddress(registry),
    };
  };
  const save = async (next: JourneyVault, check: () => void) => {
    const parsed = journeyVaultSchema.parse(next);
    const key = journeyNamespace(parsed.account, parsed.registry);
    let encoded: string | undefined;
    if (keepLocal) encoded = json(await encryptVault(parsed, passphrase, key));
    check();
    if (encoded) {
      if (localStorage.getItem(key) !== stored.current)
        throw new Error(
          "A saved passport already exists or changed in another tab. Unlock it before saving.",
        );
      localStorage.setItem(key, encoded);
      stored.current = encoded;
    }
    setVault(parsed);
  };
  const validate = async () => {
    const c = context();
    await validateInstitutions(
      c.provider,
      c.account,
      c.registry,
      await build(),
      institutionDirectory.institutions.map((i) => i.address),
      await Promise.all(institutionSigningKeys.map(commitValue)),
    );
  };
  const api = async (path: string, body: unknown) => {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "Institution request failed");
    return data;
  };
  const authorize = async (
    id: 0 | 1 | 2,
    action: "issue" | "revoke",
    v: JourneyVault,
    value: number,
    validThrough: string,
    check: () => void,
  ) => {
    const c = context();
    await validate();
    const command = institutionCommandSchema.parse({
      version: 2,
      chainId: 11155111,
      profile: v.profile,
      domain: "attest.gmac.io",
      action,
      account: c.account,
      registry: c.registry,
      journey: v.id,
      holderPublicKey: journeyHolderKey(v),
      institution: id,
      value,
      validThrough,
      expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
      nonce: crypto.randomUUID(),
      demoConsent: true,
    });
    const signature = await clients(c.provider, "testnet").wallet.signMessage({
      account: c.account,
      message: commandMessage(command),
    });
    check();
    await assertContext(c.provider, "testnet", c.account);
    return api("/api/v2/credentials", { command, signature });
  };
  const refresh = async (v: JourneyVault, check: () => void) => {
    const c = context();
    await validate();
    const state = await journeyRecords(
      c.provider,
      c.account,
      c.registry,
      await build(),
      checkedHash(await commitValue(v.id)),
    );
    check();
    setChain(state);
    return state;
  };
  const wait = async (hash: Hex, label: string, check: () => void) => {
    check();
    setTransaction({
      hash,
      label: "Submitted · waiting for Sepolia inclusion",
    });
    const c = context();
    const receipt = await clients(
      c.provider,
      "testnet",
    ).reader.waitForTransactionReceipt({
      hash,
      timeout: 120000,
      onReplaced: (r) => {
        check();
        setTransaction({
          hash: r.transaction.hash,
          label: `Transaction ${r.reason}`,
        });
      },
    });
    check();
    if (receipt.status !== "success")
      throw new Error(
        "Transaction reverted. Your local credential is preserved for inspection.",
      );
    setTransaction({
      hash: receipt.transactionHash,
      label: `${label} · included, not finalized`,
      block: receipt.blockNumber,
    });
    return receipt;
  };
  const connect = () =>
    run("Connect your wallet to Ethereum Sepolia…", async (check) => {
      if (!provider.current)
        throw new Error(
          "Open this page in a browser with an EIP-1193 wallet such as MetaMask or Rabby. On mobile, use your wallet’s built-in browser.",
        );
      const p = provider.current;
      const accounts = await p.request({ method: "eth_requestAccounts" });
      check();
      if (!accounts[0]) throw new Error("No wallet account selected");
      const address = checkedAddress(accounts[0]);
      if (Number(await p.request({ method: "eth_chainId" })) !== 11155111) {
        await p.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0xaa36a7" }],
        });
        check();
      }
      await assertContext(p, "testnet", address);
      check();
      if (account && account.toLowerCase() !== address.toLowerCase()) {
        invalidate();
      }
      setAccount(address);
      setMessage(
        "Sepolia wallet connected. Only test ETH is used. Continue with the shared registry.",
      );
    });
  const join = () =>
    run("Checking the demo contract on Sepolia…", async (check) => {
      const c = context();
      await validate();
      check();
      setReady(true);
      stored.current = localStorage.getItem(
        journeyNamespace(c.account, c.registry),
      );
      setMessage(
        "Demo registry verified against this app’s compiled contract. Create or unlock your private passport.",
      );
    });
  const deploy = () =>
    run(
      "Review the one-time Sepolia deployment fee in your wallet…",
      async (check) => {
        if (!provider.current || !account)
          throw new Error("Connect wallet first");
        const p = provider.current,
          a = account;
        const amount = Number(funding);
        if (
          !Number.isFinite(amount) ||
          amount < 0 ||
          amount > 0.1 ||
          !/^\d+(\.\d{1,6})?$/.test(funding)
        )
          throw new Error("Choose 0–0.1 Sepolia ETH (up to 6 decimals)");
        const wallets = institutionDirectory.institutions.map((i) =>
          checkedAddress(i.address),
        ) as [Address, Address, Address, Address];
        const keys = (
          await Promise.all(institutionSigningKeys.map(commitValue))
        ).map(checkedHash) as [Hex, Hex, Hex];
        const hash = await deployInstitutions(
          p,
          a,
          await build(),
          wallets,
          keys,
          BigInt(Math.round(amount * 1e6)) * 1000000000000n,
        );
        check();
        setTransaction({
          hash,
          label: "Deploying fictional institution registry",
        });
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
          `#/demo?registry=${receipt.contractAddress}`,
        );
        setReady(true);
        setTransaction({
          hash: receipt.transactionHash,
          label: "Registry deployed · included, not finalized",
          block: receipt.blockNumber,
        });
        stored.current = localStorage.getItem(
          journeyNamespace(a, receipt.contractAddress),
        );
        setMessage(
          "Demo launched. Copy the invitation below for other visitors. Send this public contract address to configure the site’s default registry.",
        );
      },
    );
  const create = () =>
    run("Creating your private credential wallet…", async (check) => {
      const c = context();
      await assertContext(c.provider, "testnet", c.account);
      if (passphrase.length < 12)
        throw new Error(
          "Choose a backup passphrase with at least 12 characters",
        );
      const key = journeyNamespace(c.account, c.registry);
      if (localStorage.getItem(key))
        throw new Error(
          "A saved passport exists. Unlock or restore it instead of overwriting it.",
        );
      stored.current = null;
      const next = createJourneyVault(c.account, c.registry);
      await save(next, check);
      await refresh(next, check);
      setStep(1);
      setMessage(
        "Passport ready. Visit Cedar Skills Academy to earn your first fictional credential.",
      );
    });
  const unlock = () =>
    run("Decrypting your saved passport…", async (check) => {
      const c = context(),
        key = journeyNamespace(c.account, c.registry),
        encoded = localStorage.getItem(key);
      if (!encoded)
        throw new Error(
          "No saved passport. Create one or restore an encrypted backup.",
        );
      const next = journeyVaultSchema.parse(
        await decryptVault(JSON.parse(encoded), passphrase, key),
      );
      if (
        next.account !== c.account.toLowerCase() ||
        next.registry !== c.registry.toLowerCase()
      )
        throw new Error("Backup belongs to another account or registry");
      check();
      stored.current = encoded;
      setVault(next);
      setKeepLocal(true);
      await refresh(next, check);
      setStep(1);
      setMessage(
        "Passport unlocked; current credential status read from Sepolia.",
      );
    });
  const restore = (event: ChangeEvent<HTMLInputElement>) => {
    const f = event.target.files?.[0];
    event.target.value = "";
    if (!f) return;
    run("Restoring encrypted passport…", async (check) => {
      if (f.size > 12000000) throw new Error("Backup too large");
      const c = context(),
        key = journeyNamespace(c.account, c.registry);
      const next = journeyVaultSchema.parse(
        await decryptVault(JSON.parse(await f.text()), passphrase, key),
      );
      if (
        next.account !== c.account.toLowerCase() ||
        next.registry !== c.registry.toLowerCase()
      )
        throw new Error("Backup belongs to another account or registry");
      check();
      setVault(next);
      setKeepLocal(false);
      await refresh(next, check);
      setStep(1);
      setMessage(
        "Restored into memory. Existing saved copies are unchanged. Export a new backup after new credentials.",
      );
    });
  };
  const issue = (id: 0 | 1 | 2) =>
    run(
      `Authorize ${fictionalInstitutions[id].name} to issue and register your credential…`,
      async (check) => {
        if (!vault) throw new Error("Unlock passport");
        const plan = vault.plans.find((p) => p.institution === id) ?? {
          institution: id,
          value: values[id]!,
          validThrough: new Date(Date.now() + 180 * 86400000)
            .toISOString()
            .slice(0, 10),
        };
        const pending = {
          ...vault,
          plans: [...vault.plans.filter((p) => p.institution !== id), plan],
        };
        await save(pending, check);
        const data = await authorize(
          id,
          "issue",
          pending,
          plan.value,
          plan.validThrough,
          check,
        );
        check();
        const next = journeyVaultSchema.parse({
          ...pending,
          credentials: [
            ...pending.credentials.filter((c) => c.institution !== id),
            data.credential,
          ],
        });
        await save(next, check);
        await wait(
          data.transactionHash,
          "Institution credential registered",
          check,
        );
        await refresh(next, check);
        clearResult();
        setMessage(
          `${fictionalInstitutions[id].name} signed the credential and paid for its Sepolia registration from its own wallet.`,
        );
      },
    );
  const anchor = issue;
  const evaluate = async (check: () => void) => {
    if (!request || !presentation || !vault || !consent)
      throw new Error("Prepare a proof first");
    const state = await refresh(vault, check);
    const result = await verifyJourney(
      presentation,
      request,
      state.records,
      state.timestamp,
    );
    check();
    setChecks(result);
    return result;
  };
  const active = fictionalInstitutions[Math.max(0, Math.min(2, step - 1))]!;
  const credential = vault?.credentials.find(
      (c) => c.institution === active.id,
    ),
    record = chain?.records[active.id];
  const anchored = !!record && record.content !== `0x${"0".repeat(64)}`;
  const invitation = registry
    ? `${location.origin}${location.pathname}#/demo?registry=${registry}`
    : "";
  return (
    <section className="page-section testnet-journey">
      <div className="journey-intro">
        <div>
          <span className="eyebrow">REAL WALLET · FICTIONAL INSTITUTIONS</span>
          <h1>
            Your next opportunity.
            <br />
            <span>Proven privately.</span>
          </h1>
          <p>
            Build a contractor passport. Collect training, experience and
            insurance credentials, then qualify for Northstar’s Project 817
            without revealing your exact figures.
          </p>
        </div>
        <div className="journey-network">
          <Badge variant="outline">Ethereum Sepolia · testnet</Badge>
          <strong>
            {account
              ? `${account.slice(0, 8)}…${account.slice(-6)}`
              : "Bring your own wallet"}
          </strong>
          <small>Fictional claims. Separate real institution wallets.</small>
          <Button disabled={busy} variant="secondary" onClick={connect}>
            {account ? "Reconnect wallet" : "Connect wallet"}
          </Button>
        </div>
      </div>
      <nav className="journey-progress" aria-label="Passport steps">
        {[
          "Your wallet",
          "Training",
          "Experience",
          "Assurance",
          "Prove eligibility",
        ].map((label, i) => (
          <Button
            key={label}
            variant={step === i ? "primary" : "secondary"}
            aria-current={step === i ? "step" : undefined}
            disabled={busy || (i > 0 && !vault)}
            onClick={() => setStep(i)}
          >
            <span>{i + 1}</span>
            {label}
            {i > 0 &&
            i < 4 &&
            chain?.records[i - 1]?.content !== `0x${"0".repeat(64)}` &&
            chain?.records[i - 1] &&
            !chain.records[i - 1]!.revoked
              ? " ✓"
              : ""}
          </Button>
        ))}
      </nav>
      <div aria-live="polite">
        {message && <p className="journey-notice">{message}</p>}
        {error && (
          <Banner
            variant="error"
            title="This step needs attention"
            description={error}
          />
        )}
      </div>
      {transaction && (
        <div className="journey-transaction">
          <Badge variant="outline">{transaction.label}</Badge>
          <a
            href={`https://sepolia.etherscan.io/tx/${transaction.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            View real transaction ↗
          </a>
          {transaction.block !== undefined && (
            <Button
              disabled={busy}
              variant="ghost"
              onClick={() =>
                run("Checking Ethereum finality…", async (check) => {
                  const c = context(),
                    reader = clients(c.provider, "testnet").reader;
                  await assertContext(c.provider, "testnet", c.account);
                  const receipt = await reader.getTransactionReceipt({
                      hash: transaction.hash,
                    }),
                    block = await reader.getBlock({
                      blockNumber: receipt.blockNumber,
                    }),
                    finalized = await reader.getBlock({
                      blockTag: "finalized",
                    });
                  check();
                  if (
                    receipt.status !== "success" ||
                    block.hash !== receipt.blockHash
                  )
                    throw new Error(
                      "Transaction is no longer canonically included",
                    );
                  setTransaction({
                    ...transaction,
                    label:
                      finalized.number >= receipt.blockNumber
                        ? "Finalized on Sepolia"
                        : "Included · waiting for finality",
                  });
                })
              }
            >
              Check finality
            </Button>
          )}
        </div>
      )}
      <details className="quiet-details">
        <summary>Meet the institution wallets</summary>
        <div className="story-grid">
          {institutionDirectory.institutions.map((i) => (
            <LayerCard className="infra-card" key={i.id}>
              <h3>{i.name}</h3>
              <p>
                {i.id === 3
                  ? "Verifier wallet"
                  : "Issuer wallet + private credential signer"}
              </p>
              <a
                href={`https://sepolia.etherscan.io/address/${i.address}`}
                target="_blank"
                rel="noreferrer"
              >
                {i.address}
              </a>
              <p className="muted">
                Sepolia test ETH only. This account pays for its institution’s
                transactions.
              </p>
            </LayerCard>
          ))}
        </div>
      </details>
      {step === 0 && (
        <div className="guided-columns">
          <LayerCard className="infra-card guided-main">
            <span className="eyebrow">01 / START HERE</span>
            <h2>
              A wallet for transactions.
              <br />A passport for private evidence.
            </h2>
            <p>
              Your EVM wallet authorizes requests and owns the passport. The
              institutions pay test gas for their transactions. A separate
              private credential key signs presentations. Its encrypted backup
              stays under your control.
            </p>
            <div className="guided-checklist">
              <p>
                <strong>1. Connect on Sepolia</strong>
                <br />
                Use MetaMask, Rabby or another injected EVM wallet. On mobile,
                open this page inside your wallet browser.
              </p>
              <p>
                <strong>2. Institutions sponsor your transactions</strong>
                <br />
                Visitors sign requests without paying gas. The host funds
                institution wallets with Sepolia test ETH, which has no monetary
                value.{" "}
                <a
                  href="https://ethereum.org/en/developers/docs/networks/#sepolia"
                  target="_blank"
                  rel="noreferrer"
                >
                  Find Sepolia faucets ↗
                </a>
              </p>
              <p>
                <strong>3. Join the demo registry</strong>
                <br />
                {ready
                  ? "Connected registry verified."
                  : registry
                    ? "Your invitation includes the registry. Join below."
                    : "The shared registry is awaiting its launch transaction. The host can deploy it below."}
              </p>
            </div>
            <InputGroup
              label="Demo registry address"
              disabled={busy || !!vault}
            >
              <InputGroup.Input
                aria-label="Demo registry address"
                value={registry}
                placeholder="0x…"
                onChange={(e) => {
                  setRegistry(e.target.value);
                  setReady(false);
                  setChain(null);
                  clearResult();
                }}
              />
            </InputGroup>
            <Button
              disabled={busy || !account || !registry || !!vault}
              onClick={join}
            >
              {ready ? "Recheck demo registry" : "Join this demo"}
            </Button>
            {ready && (
              <details className="quiet-details">
                <summary>Invite someone to this testnet demo</summary>
                <InputGroup label="Public invitation link">
                  <InputGroup.Input
                    aria-label="Public invitation link"
                    readOnly
                    value={invitation}
                  />
                </InputGroup>
                <Button
                  variant="secondary"
                  onClick={() =>
                    run("Copying invitation…", async () => {
                      await navigator.clipboard.writeText(invitation);
                      setMessage(
                        "Invitation copied. This link contains only the public registry address.",
                      );
                    })
                  }
                >
                  Copy invitation
                </Button>
                <p>
                  Registry:{" "}
                  <a
                    href={`https://sepolia.etherscan.io/address/${registry}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {registry}
                  </a>
                </p>
              </details>
            )}
            {ready && (
              <>
                <h3>
                  {vault
                    ? "Protect your passport"
                    : "Create or unlock your passport"}
                </h3>
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
                  label="Keep an encrypted passport in this browser"
                  checked={keepLocal}
                  disabled={busy}
                  onCheckedChange={(v) => setKeepLocal(v === true)}
                />
                <p className="muted">
                  Leaving or locking discards memory-only changes. Export a
                  backup after collecting credentials. Previously saved
                  encrypted copies remain until removed.
                </p>
                <div className="controls">
                  {!vault && (
                    <>
                      <Button disabled={busy || !account} onClick={create}>
                        Create my passport
                      </Button>
                      <Button
                        disabled={busy || !account}
                        variant="secondary"
                        onClick={unlock}
                      >
                        Unlock saved passport
                      </Button>
                      <Button
                        disabled={busy || !account}
                        variant="ghost"
                        onClick={() => file.current?.click()}
                      >
                        Restore encrypted backup
                      </Button>
                    </>
                  )}
                  {vault && (
                    <>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          run("Encrypting passport backup…", async (check) => {
                            const data = await encryptVault(
                              vault,
                              passphrase,
                              journeyNamespace(vault.account, vault.registry),
                            );
                            check();
                            download(
                              "attest-contractor-passport.encrypted.json",
                              data,
                            );
                            setMessage(
                              "Encrypted backup downloaded. Store it wherever you choose, separately from its passphrase.",
                            );
                          })
                        }
                      >
                        Export encrypted backup
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => setStep(1)}
                      >
                        Visit the academy →
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setVault(null);
                          setPassphrase("");
                          setChain(null);
                          clearResult();
                          setMessage(
                            "Passport locked. Unlock the saved copy or restore a backup to continue.",
                          );
                        }}
                      >
                        Lock passport
                      </Button>
                    </>
                  )}
                </div>
                <input
                  hidden
                  ref={file}
                  type="file"
                  accept="application/json,.json"
                  onChange={restore}
                />
              </>
            )}
          </LayerCard>
          <aside>
            <LayerCard className="infra-card">
              <h3>What makes this a demo?</h3>
              <p>
                The institutions are fictional, but each has its own private
                credential key and Sepolia wallet. Their service processes
                synthetic inputs without retaining private evidence. Each
                credential type can only be registered by its designated
                institution wallet. This does not imply real accreditation.
              </p>
              <p>
                The cryptographic operations and Sepolia transactions are real.
                Never submit real employment, policy or identity data.
              </p>
              <LinkButton href="#/learn/standards" variant="ghost">
                Understand the standards →
              </LinkButton>
            </LayerCard>
            <details className="quiet-details">
              <summary>Host: launch the shared demo</summary>
              <p>
                One Sepolia transaction deploys the institution-authorized
                registry and distributes the chosen test ETH equally to all four
                institution wallets. Your wallet key is never shared.
                Institution keys stay in server secrets.
              </p>
              <InputGroup
                label="Sepolia ETH to fund institution wallets"
                disabled={busy}
              >
                <InputGroup.Input
                  aria-label="Sepolia ETH to fund institution wallets"
                  type="number"
                  min={0}
                  max={0.1}
                  step={0.001}
                  value={funding}
                  onChange={(e) => setFunding(e.target.value)}
                />
              </InputGroup>
              <Button disabled={busy || !account || !!vault} onClick={deploy}>
                Launch shared demo
              </Button>
              <p>
                Once included, share the public invitation link above. The site
                operator can set this address as the default for everyone.
              </p>
            </details>
          </aside>
        </div>
      )}
      {step > 0 && step < 4 && vault && (
        <div className="guided-columns">
          <LayerCard className="infra-card guided-main">
            <div className="institution-heading">
              <span
                className="institution-monogram"
                style={{ background: active.color }}
              >
                {active.initials}
              </span>
              <div>
                <span className="eyebrow">
                  FICTIONAL INSTITUTION / {step} OF 3
                </span>
                <h2>{active.name}</h2>
              </div>
            </div>
            <h3>{active.title}</h3>
            <p>{active.description}</p>
            <InputGroup
              label={`Synthetic ${active.field} (${active.unit})`}
              disabled={
                busy ||
                !!credential ||
                !!vault.plans.find((p) => p.institution === active.id)
              }
            >
              <InputGroup.Input
                aria-label={`Synthetic ${active.field} (${active.unit})`}
                type="number"
                min={0}
                max={active.maximum}
                value={
                  vault.plans.find((p) => p.institution === active.id)?.value ??
                  values[active.id]
                }
                onChange={(e) =>
                  setValues((v) =>
                    v.map((x, i) =>
                      i === active.id ? Number(e.target.value) : x,
                    ),
                  )
                }
              />
            </InputGroup>
            <p className="muted">
              Northstar requires at least {active.minimum.toLocaleString()}{" "}
              {active.unit}. You can enter a lower fictional value to see a real
              proof refusal later.
            </p>
            {!credential ? (
              <Button disabled={busy} onClick={() => issue(active.id)}>
                {vault.plans.some((p) => p.institution === active.id)
                  ? "Retry institution issuance"
                  : `${active.verb} & receive credential`}
              </Button>
            ) : (
              <>
                <div className="credential-ticket">
                  <Badge variant="outline">{active.document} · signed</Badge>
                  <strong>
                    {credential.value.toLocaleString()} {active.unit}
                  </strong>
                  <span>Valid through {credential.validThrough}</span>
                  <small>
                    Owned by {vault.account.slice(0, 8)}…
                    {vault.account.slice(-6)}
                  </small>
                </div>
                {record?.revoked ? (
                  <Banner
                    variant="error"
                    title="This credential was revoked"
                    description="The private signature still exists, but this journey cannot qualify with a revoked registry record."
                  />
                ) : anchored ? (
                  <Banner
                    variant="secondary"
                    title="Commitment registered on Sepolia"
                    description="Northstar can match your private proof to this exact signed credential and check current status."
                  />
                ) : (
                  <>
                    <p>
                      Your statement is in your private wallet. Retry the
                      institution’s sponsored registration with a wallet
                      signature.
                    </p>
                    <Button disabled={busy} onClick={() => anchor(active.id)}>
                      Retry institution registration
                    </Button>
                  </>
                )}
                <Button
                  variant="secondary"
                  disabled={busy || !anchored}
                  onClick={() => setStep(step + 1)}
                >
                  {step === 3
                    ? "Meet Northstar →"
                    : `Visit ${fictionalInstitutions[step]!.name} →`}
                </Button>
                <details className="quiet-details">
                  <summary>Inspect the signed credential</summary>
                  <p>
                    These exact fields and the POD signature remain in your
                    custody. Institution credential signing secrets stay on the
                    server.
                  </p>
                  <pre>{json(credential.pod)}</pre>
                </details>
              </>
            )}
          </LayerCard>
          <aside>
            <LayerCard className="infra-card">
              <h3>Follow this data</h3>
              <ol className="storage-steps">
                <li>
                  <strong>Institution input</strong>
                  <p>
                    {active.source}. The institution service processes this
                    synthetic input, signs it, and discards it.
                  </p>
                </li>
                <li>
                  <strong>Your private passport</strong>
                  <p>
                    Exact value, validity, holder key and signed POD. Encrypted
                    locally if you opted in.
                  </p>
                </li>
                <li>
                  <strong>Sepolia registry</strong>
                  <p>
                    Wallet address, journey commitment, institution number,
                    content commitment, holder-key commitment, expiry and
                    status. These are public and can correlate activity.
                  </p>
                </li>
                <li>
                  <strong>Northstar</strong>
                  <p>
                    A proof that your value meets the threshold, bound to your
                    wallet, registry and request. Exact values stay hidden.
                  </p>
                </li>
              </ol>
            </LayerCard>
            <details className="quiet-details">
              <summary>Try revoking this credential</summary>
              <p>
                This sends a real, irreversible testnet revocation for this
                journey. You can start a new passport journey afterwards.
              </p>
              <Button
                disabled={busy || !anchored || !!record?.revoked}
                variant="secondary"
                onClick={() =>
                  run("Review revocation in your wallet…", async (check) => {
                    const c = context();
                    const data = await authorize(
                      active.id,
                      "revoke",
                      vault,
                      0,
                      new Date(Date.now() + 86400000)
                        .toISOString()
                        .slice(0, 10),
                      check,
                    );
                    await wait(
                      data.transactionHash,
                      "Institution revoked credential",
                      check,
                    );
                    await refresh(vault, check);
                    setChecks(null);
                    setMessage(
                      "Revocation included. Existing proof signatures do not override fresh chain status.",
                    );
                  })
                }
              >
                Revoke test credential
              </Button>
            </details>
          </aside>
        </div>
      )}
      {step === 4 && vault && (
        <div className="guided-columns">
          <LayerCard className="infra-card guided-main">
            <span className="eyebrow">
              FICTIONAL VERIFIER / NORTHSTAR PROCUREMENT
            </span>
            <h2>Are you ready for Project 817?</h2>
            <p>
              Northstar asks for three facts. Your private wallet proves them
              without sending the signed source records.
            </p>
            <div className="eligibility-criteria">
              {fictionalInstitutions.map((i) => (
                <div key={i.id}>
                  <strong>{i.title}</strong>
                  <span>
                    At least {i.minimum.toLocaleString()} {i.unit}
                  </span>
                  <small>{i.name}</small>
                </div>
              ))}
            </div>
            <Button
              disabled={busy || vault.credentials.length !== 3}
              onClick={() =>
                run(
                  "Northstar is creating a fresh, scoped request…",
                  async (check) => {
                    const c = context();
                    await assertContext(c.provider, "testnet", c.account);
                    await refresh(vault, check);
                    const next = requestJourney(vault);
                    check();
                    setRequest(next);
                    setPresentation(null);
                    setChecks(null);
                    setConsent(false);
                    setProgress(0);
                    setMessage(
                      "Request ready. Review what Northstar will receive before generating and sharing proofs.",
                    );
                  },
                )
              }
            >
              {request ? "Create a fresh request" : "Request eligibility check"}
            </Button>
            {request && (
              <>
                <div className="disclosure-review">
                  <h3>You control the disclosure</h3>
                  <p>
                    <strong>Shared:</strong> wallet address, journey and content
                    IDs, holder/issuer public keys, the three thresholds,
                    required validity date, and fresh request challenge. These
                    identify and correlate this journey.
                  </p>
                  <p>
                    <strong>Kept private:</strong> exact training hours,
                    employment duration, coverage amount, raw credentials and
                    their signatures. Registry expiry is already public.
                  </p>
                  <p>
                    <strong>Recipient:</strong> Northstar Procurement
                    (fictional) · Project 817. Request expires{" "}
                    {new Date(request.expiresAt).toLocaleTimeString()}.
                  </p>
                  <Checkbox
                    label="Share these proofs and listed public inputs with fictional Northstar."
                    checked={consent}
                    disabled={busy}
                    onCheckedChange={(v) => setConsent(v === true)}
                  />
                </div>
                <Button
                  disabled={busy || !consent}
                  onClick={() =>
                    run(
                      "Generating real private proofs in your wallet…",
                      async (check) => {
                        setChecks(null);
                        setPresentation(null);
                        setProgress(0);
                        const c = context();
                        await assertContext(c.provider, "testnet", c.account);
                        const p = await prepareJourney(
                          vault,
                          request,
                          undefined,
                          (n) => {
                            check();
                            setProgress(n);
                          },
                        );
                        check();
                        setPresentation(p);
                        setMessage(
                          "Three private proofs prepared. Northstar can now check them against its request and live Sepolia status.",
                        );
                      },
                    )
                  }
                >
                  Generate private proofs
                  {busy && progress > 0 ? ` · ${progress}/3` : ""}
                </Button>
                {presentation && (
                  <>
                    <Button
                      disabled={busy || !consent}
                      onClick={() =>
                        run(
                          "Checking proofs and current Sepolia status locally…",
                          async (check) => {
                            const result = await evaluate(check);
                            setMessage(
                              result.every((c) => c.pass)
                                ? "Local checks passed. Submit to Northstar for its independent verification and approval."
                                : "Local checks failed. Inspect each check below.",
                            );
                          },
                        )
                      }
                    >
                      Check proofs locally
                    </Button>
                    <Button
                      disabled={busy || !consent}
                      variant="ghost"
                      onClick={() =>
                        download("northstar-demo-presentation.json", {
                          request,
                          presentation,
                        })
                      }
                    >
                      Export public proof package
                    </Button>
                  </>
                )}
              </>
            )}
            {checks && (
              <div className="journey-result">
                <h3>
                  {checks.every((c) => c.pass)
                    ? "Local eligibility checks passed"
                    : "Requirements not satisfied"}
                </h3>
                <p>
                  Evaluated at Sepolia block {chain?.block}. Off-chain
                  verification; recent chain state may reorganize.
                </p>
                {checks.map((c) => (
                  <div className="wallet-check" key={c.name}>
                    <strong>
                      {c.pass ? "✓" : "×"} {c.name}
                    </strong>
                    <p>{c.detail}</p>
                  </div>
                ))}
                <Button
                  disabled={busy || !consent || !checks.every((c) => c.pass)}
                  onClick={() =>
                    run(
                      "Asking Northstar to verify and record its decision…",
                      async (check) => {
                        const result = await evaluate(check);
                        if (!result.every((c) => c.pass))
                          throw new Error(
                            "Status changed; receipt not submitted",
                          );
                        const c = context();
                        const data = await api("/api/v2/decisions", {
                          request,
                          presentation,
                        });
                        check();
                        await wait(
                          data.transactionHash,
                          "Northstar verification recorded",
                          check,
                        );
                        setMessage(
                          "Northstar independently verified your proofs and sent its decision transaction from its own wallet. The contract authenticates Northstar, but does not verify GPC itself.",
                        );
                      },
                    )
                  }
                >
                  Ask Northstar to verify & record approval
                </Button>
                <p className="muted">
                  Northstar verifies the proofs on its server and pays for its
                  own decision transaction. The contract authenticates the
                  verifier wallet; proof verification remains off-chain.
                </p>
              </div>
            )}
          </LayerCard>
          <aside>
            <LayerCard className="infra-card">
              <h3>What is actually verified?</h3>
              <p>
                Three real GPC proofs, the holder’s signature, expected
                fictional issuer keys and schemas, wallet and registry binding,
                exact anchored POD content, expiry and revocation.
              </p>
              <p>
                This does not prove the fictional source facts occurred in the
                real world. Private institution keys authenticate the fictional
                issuer; they do not make its synthetic claims real.
              </p>
              <details className="quiet-details">
                <summary>Inspect the request and proof package</summary>
                <pre>{json({ request, presentation })}</pre>
              </details>
              <LinkButton href="#/learn/infrastructure" variant="ghost">
                How the EVM fits →
              </LinkButton>
            </LayerCard>
            <LayerCard className="infra-card">
              <h3>Keep your work</h3>
              <p>
                Return to Your wallet and export an encrypted backup after
                collecting credentials. You need both the file and its
                passphrase to restore on another device.
              </p>
              <Button variant="secondary" onClick={() => setStep(0)}>
                Back up my passport
              </Button>
            </LayerCard>
          </aside>
        </div>
      )}
      {vault && (
        <details className="quiet-details">
          <summary>
            Start a new journey or remove the saved browser copy
          </summary>
          <p>
            Export a backup first. This clears the unlocked passport and
            encrypted browser copy for this account and registry. On-chain
            records and exported files remain. A new journey gets a fresh key
            and ID.
          </p>
          <Checkbox
            label="I have backed up anything I want to keep and want to start over."
            checked={exportText === "reset"}
            disabled={busy}
            onCheckedChange={(v) => setExportText(v === true ? "reset" : "")}
          />
          <Button
            variant="secondary"
            disabled={busy || exportText !== "reset"}
            onClick={() =>
              run("Clearing this local passport…", async (check) => {
                check();
                localStorage.removeItem(
                  journeyNamespace(vault.account, vault.registry),
                );
                stored.current = null;
                setVault(null);
                setPassphrase("");
                setChain(null);
                clearResult();
                setStep(0);
                setExportText("");
                setMessage(
                  "Local passport cleared. Create a new journey when ready.",
                );
              })
            }
          >
            Clear local passport & start over
          </Button>
        </details>
      )}
      <p className="journey-footnote">
        Experimental POD/GPC backend, beta and unaudited. Testnet only. Attest
        stores no private evidence.{" "}
        <a href="#/app">Advanced issuer / verifier workspace →</a>
      </p>
    </section>
  );
}
