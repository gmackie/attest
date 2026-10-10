import { useEffect, useRef, useState } from "react";
import { Button, LinkButton, InputGroup, Banner } from "@cloudflare/kumo";
import { commitValue } from "@attest/core";
import {
  institutionDirectory,
  industryIds,
  industryWallets,
  industryProfile,
} from "@attest/demo";
import {
  assertContext,
  checkedAddress,
  checkedHash,
  clients,
  fundingNeeded,
  hostOperation,
  sendHostOperation,
  recoverHostOperation,
  validateHostRegistry,
  targetInstitutionBalance,
  type HostProfile,
  type Address,
  type Hex,
  type EIP1193Provider,
  type JourneyArtifact,
} from "@attest/chain-evm";
const directories = {
  contractor: institutionDirectory.institutions,
  ...industryWallets,
};
const ids = ["contractor", ...industryIds] as const;
type Id = (typeof ids)[number];
type Saved = {
  registry?: Address;
  pending?: { value: string; registry?: Address; hash?: Hex };
  transactions?: Hex[];
};
type Journal = Partial<Record<Id, Saved>>;
const prefix = "attest:host:11155111:v1:";
const eth = (n: bigint) => (Number(n) / 1e18).toFixed(6);
type Provider = EIP1193Provider & {
  on?: (event: string, fn: () => void) => void;
  removeListener?: (event: string, fn: () => void) => void;
};
export function HostSetup() {
  const [account, setAccount] = useState<Address>();
  const [journal, setJournal] = useState<Journal>({});
  const [balances, setBalances] = useState<Partial<Record<Id, bigint[]>>>({});
  const [hostBalance, setHostBalance] = useState<bigint>();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(
      "Connect your host wallet to inspect all 22 institution balances.",
    );
  const [recovery, setRecovery] = useState("");
  const provider = useRef<Provider | undefined>(undefined);
  const generation = useRef(0),
    running = useRef(false);
  useEffect(() => {
    const p = (window as unknown as { ethereum?: Provider }).ethereum;
    provider.current = p;
    const changed = () => {
      generation.current++;
      setAccount(undefined);
      setBalances({});
      setHostBalance(undefined);
      setJournal({});
      setMessage("Wallet changed. Reconnect to safely resume setup.");
    };
    p?.on?.("accountsChanged", changed);
    p?.on?.("chainChanged", changed);
    p?.on?.("disconnect", changed);
    return () => {
      generation.current++;
      for (const event of ["accountsChanged", "chainChanged", "disconnect"])
        p?.removeListener?.(event, changed);
    };
  }, []);
  async function spec(id: Id): Promise<HostProfile> {
    const r = await fetch(
      `/contracts/${id === "contractor" ? "InstitutionRegistry" : "IndustryRegistry"}.json`,
    );
    if (!r.ok) throw new Error("Registry build unavailable");
    const artifact = (await r.json()) as JourneyArtifact;
    return {
      id,
      artifact,
      wallets: directories[id].map((w) => checkedAddress(w.address)),
      keys: await Promise.all(
        directories[id]
          .slice(0, -1)
          .map(async (w) =>
            checkedHash(await commitValue(w.credentialPublicKey)),
          ),
      ),
      ...(id === "contractor"
        ? {}
        : { profile: checkedHash(await commitValue(industryProfile(id))) }),
    };
  }
  async function work(
    action: (p: Provider, a: Address, check: () => void) => Promise<void>,
  ) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const token = generation.current;
    try {
      const p = provider.current;
      if (!p || !account) throw new Error("Connect your wallet first");
      const check = () => {
        if (generation.current !== token)
          throw new Error("Wallet context changed; setup paused");
      };
      if (!navigator.locks)
        throw new Error(
          "This browser needs Web Locks support to safely coordinate setup tabs",
        );
      await navigator.locks.request(
        "attest:host-setup:11155111",
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error(
              "Setup is running in another tab. Wait for it to finish.",
            );
          await assertContext(p, "testnet", account);
          check();
          await action(p, account, check);
        },
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const load = (a: Address): Journal =>
    JSON.parse(localStorage.getItem(prefix + a.toLowerCase()) ?? "{}");
  const save = (a: Address, next: Journal) => {
    localStorage.setItem(prefix + a.toLowerCase(), JSON.stringify(next));
    setJournal({ ...next });
  };
  async function inspect(
    p: Provider,
    a: Address,
    check: () => void,
    state: Journal,
  ) {
    const [shared, industries, service, industryService] = await Promise.all(
      [
        fetch("/demo-deployment.json"),
        fetch("/industry-deployments.json"),
        fetch("/api/v2/institutions"),
        fetch("/api/v3/institutions"),
      ].map(async (r) => {
        const response = await r;
        if (!response.ok) throw new Error("Demo configuration unavailable");
        return response.json();
      }),
    );
    if (!service.serviceConfigured || !industryService.serviceConfigured)
      throw new Error("Institution signing service is not configured");
    const reader = clients(p, "testnet").reader;
    const next: Partial<Record<Id, bigint[]>> = {};
    for (const id of ids) {
      const configured =
        id === "contractor" ? shared.registry : industries.registries?.[id];
      const item = state[id] ?? {};
      if (!item.registry && configured && !item.pending)
        item.registry = checkedAddress(configured);
      if (item.registry)
        await validateHostRegistry(
          p,
          a,
          await spec(id),
          checkedAddress(item.registry),
        );
      next[id] = await Promise.all(
        directories[id].map((w) =>
          reader.getBalance({ address: checkedAddress(w.address) }),
        ),
      );
      state[id] = item;
    }
    const balance = await reader.getBalance({ address: a });
    check();
    save(a, state);
    setBalances(next);
    setHostBalance(balance);
    return next;
  }
  async function connect() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const p = provider.current;
      if (!p) throw new Error("Open this page in your MetaMask browser");
      const accounts = await p.request({ method: "eth_requestAccounts" });
      await p.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xaa36a7" }],
      });
      const a = checkedAddress(accounts[0]!);
      await assertContext(p, "testnet", a);
      setAccount(a);
      setJournal(load(a));
      setMessage(
        "Connected to Sepolia. Check readiness, then launch all demos.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const refresh = () =>
    work(async (p, a, check) => {
      await inspect(p, a, check, load(a));
      setMessage(
        "Live balances and registry identities checked. Target: 0.001 test ETH per institution.",
      );
    });
  const launch = () =>
    work(async (p, a, check) => {
      const state = load(a);
      await inspect(p, a, check, state);
      for (const id of ids) {
        check();
        const profile = await spec(id);
        const item = state[id] ?? {};
        if (item.pending) {
          if (!item.pending.hash)
            throw new Error(
              `${id}: a wallet submission was interrupted. Paste its transaction hash below; do not submit again.`,
            );
          setMessage(`${id}: recovering saved transaction…`);
          const operation = hostOperation(
            profile,
            BigInt(item.pending.value),
            item.pending.registry,
          );
          item.registry = await recoverHostOperation(
            p,
            a,
            profile,
            operation,
            checkedHash(item.pending.hash),
          );
          item.transactions = [...(item.transactions ?? []), item.pending.hash];
          delete item.pending;
          state[id] = item;
          save(a, state);
          check();
        }
        if (item.registry)
          await validateHostRegistry(p, a, profile, item.registry);
        const current = await Promise.all(
          profile.wallets.map((address) =>
            clients(p, "testnet").reader.getBalance({ address }),
          ),
        );
        const value = fundingNeeded(current);
        if (item.registry && value === 0n) continue;
        const operation = hostOperation(profile, value, item.registry);
        setMessage(
          `${id}: ${item.registry ? "top up institutions" : "deploy and fund institutions"} · ${eth(value)} Sepolia ETH plus gas. Review MetaMask.`,
        );
        let hash: Hex;
        try {
          hash = await sendHostOperation(p, a, operation, () => {
            check();
            item.pending = {
              value: value.toString(),
              ...(item.registry ? { registry: item.registry } : {}),
            };
            state[id] = item;
            save(a, state);
          });
        } catch (e) {
          // Only an explicit wallet rejection proves no transaction was submitted.
          const rejected = (v: unknown): boolean =>
            !!v &&
            typeof v === "object" &&
            ((v as { code?: number }).code === 4001 ||
              rejected((v as { cause?: unknown }).cause));
          if (rejected(e)) {
            delete item.pending;
            save(a, state);
          }
          throw e;
        }
        item.pending!.hash = hash;
        save(a, state);
        check();
        setMessage(
          `${id}: waiting for two confirmations. You can safely return and resume.`,
        );
        item.registry = await recoverHostOperation(
          p,
          a,
          profile,
          operation,
          hash,
        );
        item.transactions = [...(item.transactions ?? []), hash];
        delete item.pending;
        state[id] = item;
        save(a, state);
        check();
      }
      const finalBalances = await inspect(p, a, check, state);
      if (
        ids.some(
          (id) =>
            !state[id]?.registry || fundingNeeded(finalBalances[id]!) > 0n,
        )
      )
        throw new Error(
          "Setup completed but some balances changed. Refresh and top up before sharing.",
        );
      setMessage(
        "All four registries verified and all 22 wallets funded to the target. Open or share the invitations below.",
      );
    });
  const attach = () =>
    work(async (p, a, check) => {
      const state = load(a);
      const id = ids.find(
        (id) => state[id]?.pending && !state[id]?.pending?.hash,
      );
      if (!id) throw new Error("No interrupted submission to recover");
      const pending = state[id]!.pending!;
      const profile = await spec(id);
      if (pending.registry)
        await validateHostRegistry(p, a, profile, pending.registry);
      const hash = checkedHash(recovery);
      const registry = await recoverHostOperation(
        p,
        a,
        profile,
        hostOperation(profile, BigInt(pending.value), pending.registry),
        hash,
      );
      check();
      state[id] = {
        registry,
        transactions: [...(state[id]?.transactions ?? []), hash],
      };
      save(a, state);
      setRecovery("");
      setMessage("Transaction recovered. Resume setup to continue.");
    });
  function exportSetup() {
    const data = {
      chainId: 11155111,
      host: account,
      registries: Object.fromEntries(
        ids.map((id) => [id, journal[id]?.registry ?? null]),
      ),
      transactions: journal,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "attest-sepolia-setup.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const known = ids.every((id) => balances[id]);
  const total = known
    ? ids.reduce((sum, id) => sum + fundingNeeded(balances[id]!), 0n)
    : undefined;
  return (
    <section className="page-section host-setup">
      <LinkButton href="#/testnet" variant="ghost">
        ← Onchain demos
      </LinkButton>
      <span className="eyebrow">
        ONE HOST · FOUR DEMOS · 22 INSTITUTION WALLETS
      </span>
      <h1>Launch the whole testnet experience.</h1>
      <p>
        Connect once. We check every institution, deploy missing registries, and
        fund issuer and verifier wallets in sequence. Approve each required
        transaction in MetaMask. Visitors then use sponsored issuance.
      </p>
      <div className="testnet-mode-note">
        <div>
          <strong>Target: 0.001 Sepolia ETH per institution</strong>
          <p>
            Starting from empty wallets: 0.022 test ETH plus gas across four
            deployments. Existing registries are reused. Top-ups split equally
            across each registry’s institutions, bringing its lowest balance to
            target. Keys are already provisioned; setup never regenerates them.
          </p>
        </div>
      </div>
      <div className="controls">
        <Button disabled={busy} onClick={() => void connect()}>
          {account ? "Reconnect host" : "Connect MetaMask"}
        </Button>
        <Button disabled={busy || !account} onClick={() => void refresh()}>
          Check readiness
        </Button>
        <Button
          variant="primary"
          disabled={busy || !account}
          onClick={() => void launch()}
        >
          Launch / resume all four demos
        </Button>
        <Button
          variant="ghost"
          disabled={!account || busy}
          onClick={exportSetup}
        >
          Export public setup
        </Button>
      </div>
      <p>
        {account ?? "No host connected"}
        {hostBalance !== undefined
          ? ` · ${eth(hostBalance)} Sepolia ETH available`
          : ""}
        {total !== undefined
          ? ` · ${eth(total)} institution funding needed, plus gas`
          : ""}
      </p>
      <div className="journey-notice" role="status">
        {message}
      </div>
      {ids.some(
        (id) => journal[id]?.pending && !journal[id]?.pending?.hash,
      ) && (
        <div className="infra-card">
          <Banner
            variant="alert"
            title="Interrupted wallet submission"
            description="Check MetaMask activity for this transaction. Paste its hash to verify and recover it. Setup will not silently resubmit."
          />
          <InputGroup label="Transaction hash">
            <InputGroup.Input
              value={recovery}
              onChange={(e) => setRecovery(e.target.value)}
            />
          </InputGroup>
          <Button disabled={busy} onClick={() => void attach()}>
            Verify and recover
          </Button>
        </div>
      )}
      <div className="story-grid">
        {ids.map((id) => (
          <section key={id} className="infra-card">
            <h2>{id.charAt(0).toUpperCase() + id.slice(1)}</h2>
            <p>
              {journal[id]?.pending
                ? "Transaction pending · resume to recover"
                : journal[id]?.registry
                  ? "Registry available · check readiness to verify"
                  : "Registry not yet configured"}
            </p>
            <ul className="host-wallets">
              {directories[id].map((w, index) => (
                <li key={w.address}>
                  <div>
                    <strong>{w.name}</strong>
                    <small>
                      {index === directories[id].length - 1
                        ? "Verifier"
                        : "Issuer"}
                    </small>
                  </div>
                  <a
                    href={`https://sepolia.etherscan.io/address/${w.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {w.address.slice(0, 8)}…{w.address.slice(-4)}
                  </a>
                  <span>
                    {balances[id]?.[index] !== undefined
                      ? `${eth(balances[id]![index]!)} ETH ${balances[id]![index]! >= targetInstitutionBalance ? "✓" : "· Needs funding"}`
                      : "Balance not checked"}
                  </span>
                </li>
              ))}
            </ul>
            {journal[id]?.registry && (
              <>
                <LinkButton
                  href={`#/testnet/${id}?registry=${journal[id]!.registry}`}
                  variant="secondary"
                >
                  Open {id} demo →
                </LinkButton>
                <InputGroup label="Public invitation">
                  <InputGroup.Input
                    readOnly
                    value={`${location.origin}/#/testnet/${id}?registry=${journal[id]!.registry}`}
                  />
                </InputGroup>
              </>
            )}
            {journal[id]?.pending?.hash && (
              <a
                href={`https://sepolia.etherscan.io/tx/${journal[id]!.pending!.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                View pending transaction ↗
              </a>
            )}
          </section>
        ))}
      </div>
      <p className="muted">
        Only public setup progress is saved in this browser. Export the setup
        file to configure shared site defaults after deployment. Keep this
        browser’s storage until pending transactions are resolved.
      </p>
    </section>
  );
}
