/**
 * One SQLite-backed Durable Object holds the demo PEP's state: pending proof requests, accepted
 * results (until they expire), quota counters and the decision ledger.
 *
 * It only ever receives small, already-authenticated commands from the Worker front (see
 * pep.ts): no client body is read and no network call is made while holding the queue. Every
 * command and the maintenance alarm run in one serial queue, so consume-once and the ledger's
 * append/seal never interleave.
 */
import type { DurableObjectState } from "@cloudflare/workers-types";
import { SerialQueue } from "../../../verifier/src/enrollment";
import type { DemoPepEnv } from "./config";
import type { Store } from "./ledger";
import { createDemoPepCore, createDemoPepFront, type DemoPepCommand, type DemoPepEnvWithLimits } from "./pep";

/** The singleton instance name. */
export const DEMO_PEP_OBJECT = "demo-pep-v1";
const COMMAND_URL = "https://demo-pep.internal/command";

export class DemoPepService {
  private readonly queue = new SerialQueue();
  private readonly core = createDemoPepCore();
  private readonly store: Store;
  constructor(state: DurableObjectState, private readonly env: DemoPepEnv) {
    const storage = state.storage;
    this.store = {
      get: <T,>(key: string) => storage.get<T>(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      list: <T,>(o: { prefix: string; limit: number }) => storage.list<T>(o) as Promise<Map<string, T>>,
      getAlarm: () => storage.getAlarm(),
      setAlarm: (at) => storage.setAlarm(at),
    };
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).href !== COMMAND_URL)
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
    // Written by the Worker front from parsed values: small and already complete.
    const command = (await request.json()) as DemoPepCommand;
    return this.queue.run(() => this.core.run(command, this.env, this.store));
  }
  async alarm(): Promise<void> {
    await this.queue.run(() => this.core.maintain(this.store));
  }
}

/** The Worker side: front in the Worker isolate, commands to the singleton object. */
export function demoPepWorker() {
  const front = createDemoPepFront();
  return (request: Request, env: DemoPepEnvWithLimits & {
    DEMO_PEP: { idFromName(name: string): unknown; get(id: never): { fetch(url: string, init: RequestInit): Promise<Response> } };
  }) => front(request, env, (command) =>
    env.DEMO_PEP.get(env.DEMO_PEP.idFromName(DEMO_PEP_OBJECT) as never).fetch(COMMAND_URL, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }) as Promise<Response>);
}
