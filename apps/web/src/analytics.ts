// Journey events for observe.gmac.io (DATFLR-9). public/dataflare.js defines window.dataflare;
// every call here is a no-op when it is missing (kill switch off, DNT/GPC, blocked script).
// Attest has no accounts (wallet-only, no server session), so it never calls identify.

export type JourneyEvent =
  | "demo_completed"
  | "wallet_connected"
  | "proofs_generated"
  | "decision_recorded";

export type JourneyProps = Record<string, string | number | boolean>;

type Dataflare = {
  track(event: string, props?: JourneyProps): void;
};

function dataflare(): Dataflare | undefined {
  return (globalThis as { dataflare?: Dataflare }).dataflare;
}

export function track(event: JourneyEvent, props?: JourneyProps): void {
  try {
    dataflare()?.track(event, props);
  } catch {
    // Analytics must never break the app.
  }
}
