import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  InputGroup,
  LayerCard,
  LinkButton,
  Select,
  Textarea,
} from "@cloudflare/kumo";
import { Effect } from "effect";
import { encryptVault, decryptVault } from "@attest/wallet";
import { commitValue } from "@attest/core";
import {
  assertContext,
  checkedAddress,
  checkedHash,
  clients,
  custodyNamespace,
  deployRegistry,
  networks,
  registryAbi,
  submitRegistryAction,
  type Address,
  type EIP1193Provider,
  type Hex,
  type Network,
  type RegistryAction,
} from "@attest/chain-evm";
import {
  connectedCredentialSchema,
  connectedRequestSchema,
  connectedVaultSchema,
  credentialManifest,
  issueConnectedCredential,
  prepareConnectedPresentation,
  signingPublicKey,
  trainingSchema,
  verifyConnectedPresentation,
  type ConnectedCredential,
  type ConnectedPresentation,
  type ConnectedRequest,
  type ConnectedVault,
} from "@attest/demo";
const stringify = (v: unknown) => JSON.stringify(v, null, 2);
const randomKey = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([stringify(data)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type Provider = EIP1193Provider & {
  on?: (event: string, listener: () => void) => void;
  removeListener?: (event: string, listener: () => void) => void;
};
type Verification = {
  requestDigest: string;
  proofCommitment: string;
  checkedBlock: string;
  checks: { name: string; pass: boolean; detail: string }[];
};
export function ConnectedWorkspace() {
  const [network, setNetwork] = useState<Network>("testnet"),
    [account, setAccount] = useState<Address | null>(null),
    [chainId, setChainId] = useState<number | null>(null);
  const [tab, setTab] = useState("personal"),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [registry, setRegistry] = useState(""),
    [administrator, setAdministrator] = useState(""),
    [verifier, setVerifier] = useState(false),
    [issuer, setIssuer] = useState(false);
  const [vault, setVault] = useState<ConnectedVault | null>(null),
    [passphrase, setPassphrase] = useState(""),
    [saveLocal, setSaveLocal] = useState(false);
  const [subject, setSubject] = useState(""),
    [holderKey, setHolderKey] = useState(""),
    [hours, setHours] = useState(36),
    [expiry, setExpiry] = useState(
      new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
    );
  const [grantAccount, setGrantAccount] = useState(""),
    [grantKey, setGrantKey] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [requestText, setRequestText] = useState(""),
    [presentationText, setPresentationText] = useState(""),
    [minimum, setMinimum] = useState(24);
  const [prepared, setPrepared] = useState<{
      request: ConnectedRequest;
      presentation: ConnectedPresentation;
    } | null>(null),
    [consent, setConsent] = useState(false),
    [result, setResult] = useState<Verification | null>(null);
  const [tx, setTx] = useState<{
    hash: Hex;
    state: string;
    contract?: Address;
  } | null>(null);
  const provider = useRef<Provider | null>(null),
    generation = useRef(0),
    locked = useRef(false),
    importRef = useRef<HTMLInputElement>(null),
    vaultRef = useRef<HTMLInputElement>(null);
  const invalidate = () => {
    generation.current++;
    storedVault.current = null;
    locked.current = false;
    setBusy(false);
    setVault(null);
    setPassphrase("");
    setPrepared(null);
    setConsent(false);
    setResult(null);
    setIssuer(false);
    setVerifier(false);
    setAdministrator("");
    setRequestText("");
    setManifestText("");
    setPresentationText("");
    setTx(null);
  };
  useEffect(() => {
    const injected = (window as unknown as { ethereum?: Provider }).ethereum;
    provider.current = injected ?? null;
    const changed = () => {
      invalidate();
      setAccount(null);
      setChainId(null);
      setMessage(
        "Wallet account or network changed. Reconnect and unlock the matching vault.",
      );
    };
    injected?.on?.("accountsChanged", changed);
    injected?.on?.("chainChanged", changed);
    injected?.on?.("disconnect", changed);
    return () => {
      generation.current++;
      injected?.removeListener?.("accountsChanged", changed);
      injected?.removeListener?.("chainChanged", changed);
      injected?.removeListener?.("disconnect", changed);
    };
  }, []);
  const perform = async (
    label: string,
    action: (check: () => void) => Promise<unknown>,
  ) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage(label);
    const token = generation.current;
    const check = () => {
      if (token !== generation.current)
        throw new Error("Context changed; operation discarded");
    };
    try {
      await Effect.runPromise(
        Effect.tryPromise({
          try: () => action(check),
          catch: (c) => (c instanceof Error ? c : new Error(String(c))),
        }),
      );
    } catch (e) {
      if (token === generation.current) {
        setError(e instanceof Error ? e.message : String(e));
        setMessage("");
      }
    } finally {
      if (token === generation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  };
  const context = () => {
    if (!provider.current || !account)
      throw new Error("Connect an EVM account first");
    return {
      provider: provider.current,
      account,
      registry: checkedAddress(registry),
    };
  };
  const storedVault = useRef<string | null>(null);
  const save = async (next: ConnectedVault, check: () => void) => {
    if (!account) throw new Error("No account");
    let encrypted;
    if (saveLocal)
      encrypted = await encryptVault(
        next,
        passphrase,
        custodyNamespace(network, account),
      );
    check();
    if (encrypted) {
      const key = custodyNamespace(network, account);
      if (localStorage.getItem(key) !== storedVault.current)
        throw new Error(
          "Saved vault changed or already exists. Unlock the latest saved vault before writing.",
        );
      const encoded = stringify(encrypted);
      localStorage.setItem(key, encoded);
      storedVault.current = encoded;
    }
    setVault(next);
  };
  const connect = () =>
    void perform("Waiting for wallet connection…", async (check) => {
      if (!provider.current)
        throw new Error(
          "No injected EVM wallet found. Install or open an EIP-1193 compatible wallet, then reload. The local demo works without one.",
        );
      const accounts = await provider.current.request({
        method: "eth_requestAccounts",
      });
      const chain = await provider.current.request({ method: "eth_chainId" });
      check();
      if (!accounts[0]) throw new Error("Wallet returned no account");
      if (
        account &&
        (accounts[0].toLowerCase() !== account.toLowerCase() ||
          Number(chain) !== chainId)
      )
        invalidate();
      setAccount(checkedAddress(accounts[0]));
      setChainId(Number(chain));
      setRegistry(
        localStorage.getItem(
          `attest:registry:${networks[network].id}:${accounts[0].toLowerCase()}`,
        ) ?? "",
      );
      setMessage(
        "Account connected. No login signature or institutional permission has been granted.",
      );
    });
  const refresh = async (check: () => void) => {
    const c = context();
    await assertContext(c.provider, network, c.account);
    const reader = clients(c.provider, network).reader;
    const scope = checkedHash(await commitValue(trainingSchema));
    const [admin, canVerify, grant] = await Promise.all([
      reader.readContract({
        address: c.registry,
        abi: registryAbi,
        functionName: "administrator",
      }),
      reader.readContract({
        address: c.registry,
        abi: registryAbi,
        functionName: "verifiers",
        args: [c.account],
      }),
      reader.readContract({
        address: c.registry,
        abi: registryAbi,
        functionName: "issuers",
        args: [c.account, scope],
      }),
    ]);
    check();
    setAdministrator(admin);
    setVerifier(canVerify);
    setIssuer(grant[0]);
    localStorage.setItem(
      `attest:registry:${networks[network].id}:${c.account.toLowerCase()}`,
      c.registry,
    );
    setMessage(
      "Permissions read from the selected registry. Its administrator defines this test network’s trust; this is not external accreditation.",
    );
  };
  const track = async (hash: Hex, check: () => void) => {
    check();
    setTx({ hash, state: "Submitted · awaiting inclusion" });
    const c = context();
    const reader = clients(c.provider, network).reader;
    const receipt = await reader.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 120000,
      onReplaced: (replacement) => {
        check();
        setTx({
          hash: replacement.transaction.hash,
          state:
            replacement.reason === "cancelled"
              ? "Replaced / cancelled"
              : "Replacement submitted",
        });
      },
    });
    check();
    if (receipt.status !== "success") {
      setTx({ hash: receipt.transactionHash, state: "Reverted" });
      throw new Error("Transaction reverted");
    }
    setTx({
      hash: receipt.transactionHash,
      state: "Included · not yet finalized",
      ...(receipt.contractAddress ? { contract: receipt.contractAddress } : {}),
    });
    setMessage(
      "Transaction included. Check finality before relying on its result.",
    );
    return receipt;
  };
  const transact = (action: RegistryAction) =>
    void perform(
      "Review this transaction and its fee in your wallet…",
      async (check) => {
        const c = context();
        const hash = await submitRegistryAction(
          c.provider,
          network,
          c.account,
          c.registry,
          action,
        );
        await track(hash, check);
        await refresh(check);
      },
    );
  const importFile = (
    event: ChangeEvent<HTMLInputElement>,
    encrypted: boolean,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void perform("Opening local file…", async (check) => {
      if (file.size > 12_000_000) throw new Error("File exceeds 12 MB limit");
      const value = JSON.parse(await file.text());
      check();
      if (encrypted) {
        if (!account) throw new Error("Connect the matching account first");
        const decoded = connectedVaultSchema.parse(
          await decryptVault(
            value,
            passphrase,
            custodyNamespace(network, account),
          ),
        );
        await save(decoded, check);
        setMessage(
          "Encrypted vault restored. The passphrase and contents never left this browser.",
        );
      } else {
        if (!vault) throw new Error("Unlock a vault first");
        const c = connectedCredentialSchema.parse(value);
        if (
          c.chainId !== networks[network].id ||
          c.holderPublicKey !== signingPublicKey(vault.privateKey)
        )
          throw new Error(
            "Credential belongs to a different network or holder key",
          );
        if (vault.credentials.some((x) => x.id === c.id))
          throw new Error("Credential already in vault");
        await save({ ...vault, credentials: [...vault.credentials, c] }, check);
        setMessage(
          "Signed credential imported locally. On-chain recognition and status are checked when verifying.",
        );
      }
    });
  };
  const verify = async (check: () => void) => {
    setResult(null);
    const c = context(),
      request = connectedRequestSchema.parse(JSON.parse(requestText)),
      presentation = JSON.parse(presentationText) as ConnectedPresentation;
    await assertContext(c.provider, network, c.account);
    if (
      request.chainId !== networks[network].id ||
      request.registry.toLowerCase() !== c.registry.toLowerCase()
    )
      throw new Error(
        "Request network or registry differs from selected context",
      );
    const cryptoValid = await verifyConnectedPresentation(
      presentation,
      request,
      c.account,
    );
    check();
    const reader = clients(c.provider, network).reader,
      block = await reader.getBlock({ blockTag: "latest" }),
      scope = checkedHash(await commitValue(trainingSchema));
    const [anchor, grant] = await Promise.all([
      reader.readContract({
        address: c.registry,
        abi: registryAbi,
        functionName: "anchors",
        args: [checkedHash(await commitValue(request.credentialId))],
        blockNumber: block.number,
      }),
      reader.readContract({
        address: c.registry,
        abi: registryAbi,
        functionName: "issuers",
        args: [checkedAddress(request.issuerAccount), scope],
        blockNumber: block.number,
      }),
    ]);
    check();
    const recognized =
      grant[0] &&
      grant[1] === (await commitValue(request.issuerPublicKey)) &&
      anchor[0].toLowerCase() === request.issuerAccount.toLowerCase() &&
      anchor[1] === scope;
    const anchored = anchor[2] === (await commitValue(request.contentID)),
      current =
        !anchor[4] &&
        anchor[3] > block.timestamp &&
        anchor[3] >= BigInt(Math.floor(Date.parse(request.expiresAt) / 1000));
    const digest = await commitValue(request),
      proofCommitment = await commitValue(presentation);
    check();
    const verification = {
      requestDigest: digest,
      proofCommitment,
      checkedBlock: block.number.toString(),
      checks: [
        {
          name: "Authentic & request-bound",
          pass: cryptoValid,
          detail:
            "Real GPC proof and holder signature, exact request digest and intended verifier.",
        },
        {
          name: "Recognized & anchored",
          pass: recognized && anchored,
          detail:
            "Scoped issuer key and the proof’s public POD content ID match the selected registry anchor.",
        },
        {
          name: "Current",
          pass: current,
          detail:
            "Not revoked and valid through request expiry at the displayed block. Latest blocks can be reorganized.",
        },
      ],
    };
    setResult(verification);
    setMessage(
      "Verification completed against the selected registry. Recheck for fresh status before a consequential decision.",
    );
    return verification;
  };
  const disabled = busy || !account,
    production = network === "production",
    correctChain = chainId === networks[network].id;
  return (
    <section className="page-section connected-workspace">
      <div className="section-heading">
        <div>
          <span className="eyebrow">CONNECTED WORKSPACE</span>
          <h1>Your evidence. Your custody.</h1>
        </div>
        <Badge variant="outline">
          {networks[network].name} · {networks[network].id}
        </Badge>
      </div>
      <div className="connection-bar">
        <Select<string>
          label="Environment"
          value={network}
          disabled={busy}
          onValueChange={(value) => {
            if (value) {
              invalidate();
              setAccount(null);
              setChainId(null);
              setRegistry("");
              setNetwork(value as Network);
            }
          }}
        >
          <Select.Option value="testnet">
            Testnet · Ethereum Sepolia
          </Select.Option>
          <Select.Option value="production">
            Production · Ethereum
          </Select.Option>
        </Select>
        <div>
          <strong>
            {account
              ? `${account.slice(0, 8)}…${account.slice(-6)}`
              : "No account connected"}
          </strong>
          <p>
            {account
              ? `Wallet chain: ${chainId}`
              : "Connecting does not grant issuer authority."}
          </p>
        </div>
        <Button disabled={busy} onClick={connect}>
          {account ? "Reconnect account" : "Connect wallet"}
        </Button>
        {account && !correctChain && (
          <Button
            disabled={busy}
            variant="secondary"
            onClick={() =>
              void perform("Switch network in your wallet…", async () => {
                await provider.current!.request({
                  method: "wallet_switchEthereumChain",
                  params: [
                    { chainId: `0x${networks[network].id.toString(16)}` },
                  ],
                });
              })
            }
          >
            Switch to {networks[network].name}
          </Button>
        )}
      </div>
      {production && (
        <Banner
          title="Production writes are locked"
          description="Connect and inspect Ethereum accounts, but do not use experimental credentials for real decisions. Production requires reviewed contracts, custody, proof backend and authority configuration."
        />
      )}
      {!account && (
        <LayerCard className="infra-card">
          <h2>Bring a wallet, keep control.</h2>
          <p>
            Use an EVM browser wallet for account control and transactions.
            Private evidence stays in an encrypted local vault or an encrypted
            file you store with your own provider.
          </p>
          <LinkButton href="#/sandbox" variant="secondary">
            Try without a wallet →
          </LinkButton>
        </LayerCard>
      )}
      {error && (
        <div role="alert">
          <Banner title="Action could not complete" description={error} />
        </div>
      )}
      <p role="status">{message}</p>
      {tx && (
        <LayerCard className="transaction-status">
          <strong>{tx.state}</strong>
          <a
            href={`${networks[network].blockExplorers.default.url}/tx/${tx.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
          {tx.contract && <code>New registry: {tx.contract}</code>}
          <Button
            disabled={busy || !account}
            variant="secondary"
            onClick={() =>
              void perform(
                "Checking canonical receipt and finality…",
                async (check) => {
                  const c = context();
                  await assertContext(c.provider, network, c.account);
                  const reader = clients(c.provider, network).reader;
                  const [receipt, finalized] = await Promise.all([
                    reader.getTransactionReceipt({ hash: tx.hash }),
                    reader.getBlock({ blockTag: "finalized" }),
                  ]);
                  const canonical = await reader.getBlock({
                    blockNumber: receipt.blockNumber,
                  });
                  check();
                  if (canonical.hash !== receipt.blockHash)
                    throw new Error(
                      "Receipt block is no longer canonical; refresh before relying on it",
                    );
                  setTx({
                    ...tx,
                    state:
                      receipt.status !== "success"
                        ? "Reverted"
                        : receipt.blockNumber <= finalized.number
                          ? "Finalized"
                          : "Included · awaiting finality",
                  });
                },
              )
            }
          >
            Check finality
          </Button>
        </LayerCard>
      )}
      <nav
        className="controls workspace-tabs"
        aria-label="Connected workspace views"
      >
        {[
          { id: "personal", name: "Personal" },
          { id: "issuer", name: "Issuer" },
          { id: "verifier", name: "Verifier" },
          { id: "registry", name: "Registry & team" },
          { id: "custody", name: "Custody" },
        ].map((item) => (
          <Button
            key={item.id}
            variant={tab === item.id ? "primary" : "secondary"}
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.name}
          </Button>
        ))}
      </nav>
      {tab === "custody" && (
        <LayerCard className="infra-card task-card">
          <h2>Unlock your private workspace</h2>
          <p>
            No evidence upload to Attest. The passphrase encrypts your local
            credential-signing key and records using AES-GCM with PBKDF2. It is
            separate from your EVM wallet. Losing it without a backup means
            losing this vault.
          </p>
          <InputGroup
            label="Vault passphrase (at least 12 characters)"
            disabled={busy}
          >
            <InputGroup.Input
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </InputGroup>
          <Checkbox
            label="Keep an encrypted copy in this browser"
            checked={saveLocal}
            disabled={busy}
            onCheckedChange={(value) => setSaveLocal(value === true)}
          />
          <p>
            When unchecked, new changes stay only in memory until exported.
            Previously saved encrypted copies remain until removed below.
          </p>
          <div className="controls">
            <Button
              disabled={disabled || production || !!vault}
              onClick={() =>
                void perform(
                  "Creating encrypted custody keys…",
                  async (check) => {
                    if (passphrase.length < 12)
                      throw new Error("Use at least 12 characters");
                    const next: ConnectedVault = {
                      version: 1,
                      privateKey: randomKey(),
                      credentials: [],
                      requests: [],
                      presentations: [],
                    };
                    await save(next, check);
                    setMessage(
                      "Vault created. Export an encrypted backup before leaving.",
                    );
                  },
                )
              }
            >
              Create testnet vault
            </Button>
            <Button
              disabled={disabled || !!vault}
              variant="secondary"
              onClick={() =>
                void perform("Decrypting local vault…", async (check) => {
                  const value = localStorage.getItem(
                    custodyNamespace(network, account!),
                  );
                  if (!value)
                    throw new Error(
                      "No encrypted vault for this account and network",
                    );
                  const next = connectedVaultSchema.parse(
                    await decryptVault(
                      JSON.parse(value),
                      passphrase,
                      custodyNamespace(network, account!),
                    ),
                  );
                  check();
                  storedVault.current = value;
                  setVault(next);
                  setSaveLocal(true);
                  setMessage("Vault unlocked in memory.");
                })
              }
            >
              Unlock saved vault
            </Button>
            <Button
              disabled={disabled}
              variant="secondary"
              onClick={() => vaultRef.current?.click()}
            >
              Restore encrypted file
            </Button>
          </div>
          <input
            ref={vaultRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => importFile(e, true)}
          />
          {vault && (
            <>
              <p>
                <strong>Your credential / holder public key</strong>
              </p>
              <code className="break-code">
                {signingPublicKey(vault.privateKey)}
              </code>
              <div className="controls">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      "Encrypting portable backup…",
                      async (check) => {
                        const encrypted = await encryptVault(
                          vault,
                          passphrase,
                          custodyNamespace(network, account!),
                        );
                        check();
                        download("attest-encrypted-vault.json", encrypted);
                        setMessage(
                          "Encrypted file exported. Keep it with your chosen storage provider; keep its passphrase separately.",
                        );
                      },
                    )
                  }
                >
                  Export encrypted backup
                </Button>
                <Button
                  disabled={busy}
                  variant="secondary"
                  onClick={() => {
                    setVault(null);
                    setPassphrase("");
                    setPrepared(null);
                    setConsent(false);
                    setMessage(
                      "Vault locked. Unsaved in-memory changes are discarded.",
                    );
                  }}
                >
                  Lock vault
                </Button>
              </div>
            </>
          )}
          <details className="quiet-details">
            <summary>Remove this browser’s encrypted copy</summary>
            <Button
              disabled={disabled}
              variant="secondary"
              onClick={() =>
                void perform(
                  "Removing local encrypted copy…",
                  async (check) => {
                    check();
                    localStorage.removeItem(
                      custodyNamespace(network, account!),
                    );
                    storedVault.current = null;
                    setSaveLocal(false);
                    setMessage(
                      "Local encrypted copy removed. Exported backups are unaffected.",
                    );
                  },
                )
              }
            >
              Delete encrypted local copy
            </Button>
            <p>
              This does not revoke credentials or delete copies you exported
              elsewhere.
            </p>
          </details>
        </LayerCard>
      )}
      {tab === "registry" && (
        <LayerCard className="infra-card task-card">
          <h2>Choose the trust registry</h2>
          <p>
            Use a registry whose administrator you independently trust.
            Deploying your own test registry establishes a sandbox, not
            accreditation.
          </p>
          <InputGroup label="WorkspaceRegistry address" disabled={busy}>
            <InputGroup.Input
              value={registry}
              onChange={(e) => {
                setRegistry(e.target.value);
                setAdministrator("");
                setIssuer(false);
                setVerifier(false);
                setPrepared(null);
                setResult(null);
              }}
            />
          </InputGroup>
          <div className="controls">
            <Button
              disabled={disabled || !correctChain}
              onClick={() =>
                void perform("Reading registry permissions…", refresh)
              }
            >
              Load permissions
            </Button>
            <Button
              variant="secondary"
              disabled={disabled || production || !correctChain}
              onClick={() =>
                void perform(
                  "Review registry deployment and gas in your wallet…",
                  async (check) => {
                    const p = provider.current!,
                      a = account!;
                    const response = await fetch(
                      "/contracts/WorkspaceRegistry.json",
                    );
                    if (!response.ok)
                      throw new Error("Registry build artifact unavailable");
                    const artifact = (await response.json()) as {
                      bytecode: string;
                    };
                    check();
                    const hash = await deployRegistry(
                      p,
                      network,
                      a,
                      artifact.bytecode,
                    );
                    check();
                    setTx({ hash, state: "Submitted · registry deployment" });
                    const receipt = await clients(
                      p,
                      network,
                    ).reader.waitForTransactionReceipt({
                      hash,
                      timeout: 120000,
                    });
                    check();
                    if (
                      receipt.status !== "success" ||
                      !receipt.contractAddress
                    )
                      throw new Error("Registry deployment failed");
                    setRegistry(receipt.contractAddress);
                    setAdministrator(a);
                    setTx({
                      hash,
                      state: "Included · not yet finalized",
                      contract: receipt.contractAddress,
                    });
                    localStorage.setItem(
                      `attest:registry:${networks[network].id}:${a.toLowerCase()}`,
                      receipt.contractAddress,
                    );
                    setMessage(
                      "Test registry deployed. Configure issuer and verifier permissions explicitly.",
                    );
                  },
                )
              }
            >
              Deploy my Sepolia registry
            </Button>
          </div>
          {administrator && (
            <>
              <p>
                Administrator: <code>{administrator}</code>
              </p>
              <p>
                Your scope: issuer {issuer ? "enabled" : "not granted"} ·
                verifier {verifier ? "enabled" : "not granted"}
              </p>
            </>
          )}
          {administrator.toLowerCase() === account?.toLowerCase() && (
            <>
              <h3>Scoped team permissions</h3>
              <InputGroup label="Member EVM address" disabled={busy}>
                <InputGroup.Input
                  value={grantAccount}
                  onChange={(e) => setGrantAccount(e.target.value)}
                />
              </InputGroup>
              <InputGroup
                label="Member credential-signing public key (issuer grant)"
                disabled={busy}
              >
                <InputGroup.Input
                  value={grantKey}
                  onChange={(e) => setGrantKey(e.target.value)}
                />
              </InputGroup>
              <p>
                Issuer grants are limited to <code>{trainingSchema}</code>.
                These testnet keys are not production identity credentials.
              </p>
              <div className="controls">
                <Button
                  disabled={disabled || production}
                  onClick={() =>
                    void perform(
                      "Preparing scoped issuer grant…",
                      async (check) => {
                        const c = context();
                        const scope = checkedHash(
                            await commitValue(trainingSchema),
                          ),
                          signer = checkedHash(await commitValue(grantKey));
                        if (grantKey.length < 20)
                          throw new Error(
                            "Enter the issuer’s credential public key",
                          );
                        const hash = await submitRegistryAction(
                          c.provider,
                          network,
                          c.account,
                          c.registry,
                          {
                            functionName: "configureIssuer",
                            args: [
                              checkedAddress(grantAccount),
                              scope,
                              signer,
                              true,
                            ],
                          },
                        );
                        await track(hash, check);
                        await refresh(check);
                      },
                    )
                  }
                >
                  Grant issuer scope
                </Button>
                <Button
                  disabled={disabled || production}
                  variant="secondary"
                  onClick={() => {
                    try {
                      transact({
                        functionName: "configureVerifier",
                        args: [checkedAddress(grantAccount), true],
                      });
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  Grant verifier
                </Button>
                <Button
                  disabled={disabled || production}
                  variant="secondary"
                  onClick={() => {
                    try {
                      transact({
                        functionName: "configureVerifier",
                        args: [checkedAddress(grantAccount), false],
                      });
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  Remove verifier
                </Button>
                <Button
                  disabled={disabled || production}
                  variant="secondary"
                  onClick={() =>
                    void perform("Preparing issuer removal…", async (check) => {
                      const c = context();
                      const scope = checkedHash(
                          await commitValue(trainingSchema),
                        ),
                        signer = checkedHash(await commitValue(grantKey));
                      const hash = await submitRegistryAction(
                        c.provider,
                        network,
                        c.account,
                        c.registry,
                        {
                          functionName: "configureIssuer",
                          args: [
                            checkedAddress(grantAccount),
                            scope,
                            signer,
                            false,
                          ],
                        },
                      );
                      await track(hash, check);
                      await refresh(check);
                    })
                  }
                >
                  Remove issuer scope
                </Button>
              </div>
            </>
          )}
        </LayerCard>
      )}
      {tab === "issuer" && (
        <LayerCard className="infra-card task-card">
          <h2>Issue a training credential</h2>
          <p>
            First unlock a vault and load registry permissions. This testnet
            profile signs a subject, holder key, training hours and validity
            date. It does not verify that the entered training occurred.
          </p>
          <Badge variant="outline">
            {issuer ? "Issuer scope loaded" : "Issuer permission required"}
          </Badge>
          <div className="wallet-form">
            <InputGroup label="Subject identifier" disabled={busy}>
              <InputGroup.Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </InputGroup>
            <InputGroup label="Recipient’s holder public key" disabled={busy}>
              <InputGroup.Input
                value={holderKey}
                onChange={(e) => setHolderKey(e.target.value)}
              />
            </InputGroup>
            <InputGroup label="Completed training hours" disabled={busy}>
              <InputGroup.Input
                type="number"
                min={0}
                max={10000}
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              />
            </InputGroup>
            <InputGroup label="Valid through (UTC date)" disabled={busy}>
              <InputGroup.Input
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </InputGroup>
          </div>
          <Button
            disabled={disabled || production || !vault || !issuer}
            onClick={() =>
              void perform("Signing credential locally…", async (check) => {
                const c = context();
                await assertContext(c.provider, network, c.account, true);
                if (!vault) throw new Error("Unlock vault");
                const scope = checkedHash(await commitValue(trainingSchema));
                const grant = await clients(
                  c.provider,
                  network,
                ).reader.readContract({
                  address: c.registry,
                  abi: registryAbi,
                  functionName: "issuers",
                  args: [c.account, scope],
                });
                if (
                  !grant[0] ||
                  grant[1] !==
                    (await commitValue(signingPublicKey(vault.privateKey)))
                )
                  throw new Error(
                    "Registry does not authorize this credential-signing key",
                  );
                const credential = await issueConnectedCredential(
                  {
                    id: crypto.randomUUID(),
                    chainId: 11155111,
                    registry: c.registry,
                    issuerAccount: c.account,
                    subject,
                    holderPublicKey: holderKey,
                    validThrough: expiry,
                  },
                  hours,
                  vault.privateKey,
                );
                await save(
                  { ...vault, credentials: [...vault.credentials, credential] },
                  check,
                );
                setMessage(
                  "Credential signed and stored locally. Anchor its commitment next; share the signed record only with its holder.",
                );
              })
            }
          >
            Approve & sign credential
          </Button>
          {vault?.credentials
            .filter(
              (c) => c.issuerAccount.toLowerCase() === account?.toLowerCase(),
            )
            .map((c) => (
              <div className="record-row" key={c.id}>
                <div>
                  <strong>{c.subject}</strong>
                  <small>{c.id}</small>
                </div>
                <div className="controls">
                  <Button
                    disabled={busy}
                    variant="secondary"
                    onClick={() => download("issued-credential.json", c)}
                  >
                    Export to holder
                  </Button>
                  <Button
                    disabled={busy || production}
                    onClick={() =>
                      void perform(
                        "Review public commitment anchoring…",
                        async (check) => {
                          const ctx = context();
                          if (
                            c.registry.toLowerCase() !==
                            ctx.registry.toLowerCase()
                          )
                            throw new Error("Select the credential’s registry");
                          const hash = await submitRegistryAction(
                            ctx.provider,
                            network,
                            ctx.account,
                            ctx.registry,
                            {
                              functionName: "anchor",
                              args: [
                                checkedHash(await commitValue(c.id)),
                                checkedHash(await commitValue(trainingSchema)),
                                checkedHash(await commitValue(c.contentID)),
                                BigInt(
                                  Date.parse(c.validThrough) / 1000 + 86399,
                                ),
                              ],
                            },
                          );
                          await track(hash, check);
                        },
                      )
                    }
                  >
                    Anchor commitment
                  </Button>
                  <Button
                    disabled={busy || production}
                    variant="secondary"
                    onClick={() =>
                      void perform(
                        "Review irreversible revocation…",
                        async (check) => {
                          const ctx = context();
                          if (
                            c.registry.toLowerCase() !==
                            ctx.registry.toLowerCase()
                          )
                            throw new Error("Select the credential’s registry");
                          const hash = await submitRegistryAction(
                            ctx.provider,
                            network,
                            ctx.account,
                            ctx.registry,
                            {
                              functionName: "revoke",
                              args: [checkedHash(await commitValue(c.id))],
                            },
                          );
                          await track(hash, check);
                        },
                      )
                    }
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
        </LayerCard>
      )}
      {tab === "personal" && (
        <LayerCard className="infra-card task-card">
          <h2>Your credentials & presentations</h2>
          <p>
            {vault
              ? `${vault.credentials.length} credentials in your unlocked vault.`
              : "Unlock custody to import credentials and prepare proofs."}
          </p>
          <div className="controls">
            <Button
              disabled={disabled || !vault || production}
              variant="secondary"
              onClick={() => importRef.current?.click()}
            >
              Import signed credential
            </Button>
            <Button variant="ghost" onClick={() => setTab("custody")}>
              {vault ? "Manage encrypted backup" : "Open custody"}
            </Button>
          </div>
          <input
            type="file"
            accept="application/json,.json"
            hidden
            ref={importRef}
            onChange={(e) => importFile(e, false)}
          />
          {vault?.credentials
            .filter(
              (c) => c.holderPublicKey === signingPublicKey(vault.privateKey),
            )
            .map((c) => (
              <div className="record-row" key={c.id}>
                <div>
                  <strong>{c.subject}</strong>
                  <small>Valid through {c.validThrough}</small>
                </div>
                <Button
                  variant="secondary"
                  onClick={() =>
                    download(
                      "credential-public-manifest.json",
                      credentialManifest(c),
                    )
                  }
                >
                  Export request metadata
                </Button>
              </div>
            ))}
          <h3>Review a request</h3>
          <label htmlFor="holder-request">
            Verifier’s request document (JSON)
          </label>
          <Textarea
            id="holder-request"
            rows={6}
            disabled={busy}
            value={requestText}
            onChange={(e) => {
              setRequestText(e.target.value);
              setPrepared(null);
              setConsent(false);
            }}
          />
          <p>
            Request documents are unsigned; independently confirm the recipient
            and policy before sharing. Public inputs expose subject, holder and
            issuer keys, credential ID, POD content ID, threshold and required
            date; exact hours stay hidden. Signed expiry is hidden in the proof,
            but registry expiry is public. Content IDs correlate presentations.
          </p>
          <Button
            disabled={disabled || !vault || production}
            onClick={() =>
              void perform(
                "Preparing private proof locally…",
                async (check) => {
                  const ctx = context();
                  await assertContext(ctx.provider, network, ctx.account, true);
                  const request = connectedRequestSchema.parse(
                    JSON.parse(requestText),
                  );
                  if (
                    request.registry.toLowerCase() !==
                    ctx.registry.toLowerCase()
                  )
                    throw new Error(
                      "Request registry differs from selected registry",
                    );
                  const credential = vault!.credentials.find(
                    (c) => c.id === request.credentialId,
                  );
                  if (!credential)
                    throw new Error(
                      "Requested credential is not in this vault",
                    );
                  const presentation = await prepareConnectedPresentation(
                    credential,
                    request,
                    vault!.privateKey,
                  );
                  check();
                  setPrepared({ request, presentation });
                  setMessage(
                    "Proof prepared locally. Review recipient before exporting.",
                  );
                },
              )
            }
          >
            Prepare private proof
          </Button>
          {prepared && (
            <div className="wallet-disclosure">
              <h3>Approve this disclosure</h3>
              <p>
                Recipient: <code>{prepared.request.audience}</code>
              </p>
              <p>
                Subject: {prepared.request.subject} · training ≥{" "}
                {prepared.request.minimumHours} hours · required through{" "}
                {prepared.request.expiresAt.slice(0, 10)}
              </p>
              <Checkbox
                label="I approve sharing this proof and its listed public inputs with this verifier."
                checked={consent}
                disabled={busy}
                onCheckedChange={(v) => setConsent(v === true)}
              />
              <Button
                disabled={busy || !consent}
                onClick={() =>
                  void perform(
                    "Saving presentation history…",
                    async (check) => {
                      if (Date.parse(prepared.request.expiresAt) <= Date.now())
                        throw new Error(
                          "Request expired; obtain a new request",
                        );
                      await save(
                        {
                          ...vault!,
                          presentations: [...vault!.presentations, prepared],
                        },
                        check,
                      );
                      download(
                        "approved-presentation.json",
                        prepared.presentation,
                      );
                      setConsent(false);
                      setPrepared(null);
                      setMessage(
                        "Approved presentation exported. Deliver this file directly to the intended verifier; Attest did not relay or upload it.",
                      );
                    },
                  )
                }
              >
                Approve & export presentation
              </Button>
            </div>
          )}
          {vault && (
            <details className="quiet-details">
              <summary>
                Presentation history ({vault.presentations.length})
              </summary>
              {vault.presentations.map((p, i) => (
                <p key={i}>
                  {p.request.subject} → {p.request.audience}
                  <br />
                  <small>{p.request.id}</small>
                </p>
              ))}
            </details>
          )}
        </LayerCard>
      )}
      {tab === "verifier" && (
        <LayerCard className="infra-card task-card">
          <h2>Request and verify private evidence</h2>
          <p>
            Ask the holder for their public credential manifest, then create
            your own request. Never replace your request with a policy supplied
            alongside a proof.
          </p>
          <label htmlFor="manifest">Public credential manifest (JSON)</label>
          <Textarea
            id="manifest"
            rows={5}
            disabled={busy}
            value={manifestText}
            onChange={(e) => {
              setManifestText(e.target.value);
              setResult(null);
            }}
          />
          <InputGroup label="Required training hours" disabled={busy}>
            <InputGroup.Input
              type="number"
              min={1}
              value={minimum}
              onChange={(e) => setMinimum(Number(e.target.value))}
            />
          </InputGroup>
          <Button
            disabled={disabled || !vault || production}
            onClick={() =>
              void perform(
                "Creating independent verifier request…",
                async (check) => {
                  const ctx = context();
                  await assertContext(ctx.provider, network, ctx.account, true);
                  const manifest = JSON.parse(manifestText);
                  const request = connectedRequestSchema.parse({
                    kind: "ConnectedTrainingRequest",
                    version: 1,
                    id: crypto.randomUUID(),
                    chainId: 11155111,
                    registry: ctx.registry,
                    audience: ctx.account,
                    issuerAccount: manifest.issuerAccount,
                    credentialId: manifest.id,
                    contentID: manifest.contentID,
                    subject: manifest.subject,
                    holderPublicKey: manifest.holderPublicKey,
                    issuerPublicKey: manifest.issuerPublicKey,
                    minimumHours: minimum,
                    expiresAt: new Date(Date.now() + 86400000).toISOString(),
                  });
                  if (
                    manifest.registry?.toLowerCase() !==
                      ctx.registry.toLowerCase() ||
                    manifest.chainId !== 11155111
                  )
                    throw new Error("Manifest network or registry mismatch");
                  await save(
                    { ...vault!, requests: [...vault!.requests, request] },
                    check,
                  );
                  setRequestText(stringify(request));
                  setPresentationText("");
                  download("verification-request.json", request);
                  setResult(null);
                  setMessage(
                    "Request saved in your custody and exported for direct delivery.",
                  );
                },
              )
            }
          >
            Create & export request
          </Button>
          <details className="quiet-details" open={!!requestText}>
            <summary>Evaluate a received presentation</summary>
            {vault?.requests.map((r) => (
              <Button
                key={r.id}
                variant="ghost"
                onClick={() => {
                  setRequestText(stringify(r));
                  setResult(null);
                }}
              >
                Load saved request {r.id.slice(0, 8)}
              </Button>
            ))}
            <label htmlFor="verifier-request">
              Your expected request (JSON)
            </label>
            <Textarea
              id="verifier-request"
              rows={5}
              value={requestText}
              disabled={busy}
              onChange={(e) => {
                setRequestText(e.target.value);
                setResult(null);
              }}
            />
            <label htmlFor="verifier-proof">Holder’s presentation (JSON)</label>
            <Textarea
              id="verifier-proof"
              rows={5}
              value={presentationText}
              disabled={busy}
              onChange={(e) => {
                setPresentationText(e.target.value);
                setResult(null);
              }}
            />
            <Button
              disabled={disabled || !correctChain || production}
              onClick={() =>
                void perform(
                  "Checking proof, issuer scope and chain status…",
                  verify,
                )
              }
            >
              Verify against my request
            </Button>
            {result && (
              <div className="wallet-decision">
                <h3>
                  {result.checks.every((c) => c.pass)
                    ? "Requirements satisfied"
                    : "Rejected"}
                </h3>
                <p>
                  Evaluated at block {result.checkedBlock}. This is an off-chain
                  verification result.
                </p>
                {result.checks.map((c) => (
                  <div className="wallet-check" key={c.name}>
                    <strong>
                      {c.name} · {c.pass ? "Pass" : "Fail"}
                    </strong>
                    <p>{c.detail}</p>
                  </div>
                ))}
                <Button
                  disabled={
                    busy ||
                    production ||
                    !verifier ||
                    !result.checks.every((c) => c.pass)
                  }
                  variant="secondary"
                  onClick={() =>
                    void perform(
                      "Rechecking current status before preparing the receipt…",
                      async (check) => {
                        const ctx = context(),
                          request = connectedRequestSchema.parse(
                            JSON.parse(requestText),
                          );
                        await assertContext(
                          ctx.provider,
                          network,
                          ctx.account,
                          true,
                        );
                        const fresh = await verify(check);
                        if (
                          !fresh.checks.every((item) => item.pass) ||
                          fresh.requestDigest !== result.requestDigest ||
                          fresh.proofCommitment !== result.proofCommitment
                        )
                          throw new Error(
                            "Proof or registry status changed; verification rejected",
                          );
                        const hash = await submitRegistryAction(
                          ctx.provider,
                          network,
                          ctx.account,
                          ctx.registry,
                          {
                            functionName: "recordDecision",
                            args: [
                              checkedHash(result.requestDigest),
                              checkedHash(result.proofCommitment),
                              true,
                            ],
                          },
                        );
                        await track(hash, check);
                      },
                    )
                  }
                >
                  Record verifier attestation
                </Button>
                <p>
                  This records your assertion. The contract does not verify the
                  proof; recipients must trust the authorized verifier or
                  independently verify.
                </p>
              </div>
            )}
          </details>
        </LayerCard>
      )}
      <details className="quiet-details">
        <summary>Security and deployment boundaries</summary>
        <p>
          This is an experimental Sepolia workspace. The new registry enforces
          scoped issuer permissions, original-issuer irreversible revocation and
          per-verifier request uniqueness. It does not prove real-world
          authority or verify GPC on-chain. Private signing keys are generated
          locally, separate from account keys; encrypted exports are portable
          storage, not an automatic recovery service. No SIWE server session is
          used: on-chain operations authorize the actual transaction sender.
          Production, passkey recovery, multisig administration and automated
          remote vault synchronization require reviewed integrations.
        </p>
      </details>
    </section>
  );
}
