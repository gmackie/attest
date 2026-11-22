/**
 * One SQLite-backed Durable Object holds the demo PEP's state: pending proof requests, accepted
 * results (until they expire) and the decision ledger. Every request runs in one serial queue,
 * so consume-once and the ledger's append/seal never interleave.
 */
import type { DurableObjectState } from "@cloudflare/workers-types";
import { SerialQueue } from "../../../verifier/src/enrollment";
import type { DemoPepEnv } from "./config";
import type { Store } from "./ledger";
import { createDemoPep } from "./pep";

/** The singleton instance name. */
export const DEMO_PEP_OBJECT = "demo-pep-v1";

export class DemoPepService {
  private readonly queue = new SerialQueue();
  private readonly handle = createDemoPep();
  private readonly store: Store;
  constructor(state: DurableObjectState, private readonly env: DemoPepEnv) {
    const storage = state.storage;
    this.store = {
      get: <T,>(key: string) => storage.get<T>(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
    };
  }
  fetch(request: Request): Promise<Response> {
    return this.queue.run(() => this.handle(request, this.env, this.store));
  }
}
