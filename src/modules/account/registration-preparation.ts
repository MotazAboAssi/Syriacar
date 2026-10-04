import "server-only";
import { performance } from "node:perf_hooks";
import { registrationTransactionClient, guardRegistrationRelease } from "../../server/db/client.ts";
import type { InspectionConnection as Connection } from "../guest-inspection/service.ts";
import { accountTransaction, unavailable } from "./rate-limits.ts";
import { hashPassword, type AccountRuntime } from "./security.ts";

// Generous safety ceilings, not expected hashing latency. Native Argon2's
// parameters are unchanged. A timer rejecting a Promise is NOT CPU cancellation.
export const registrationPreparationPolicy = {
  concurrency: 2, queueSize: 8, queueMs: 15_000, hashMs: 10_000, transactionMs: 20_000,
} as const;
type Policy = { [K in keyof typeof registrationPreparationPolicy]: number };
interface Waiter {
  expires: number;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface RegistrationWork {
  checkpoint(): void;
  hash(password: string): Promise<string>;
}

/** One process-wide bounded gate, including native jobs that outlive a timeout. */
export class RegistrationPreparation {
  private active = 0;
  private queue: Waiter[] = [];
  readonly policy: Policy;
  constructor(policy: Partial<Policy> = {}) {
    this.policy = { ...registrationPreparationPolicy, ...policy };
    for (const [name, value] of Object.entries(this.policy)) {
      if (!Number.isSafeInteger(value) || value < (name === "queueSize" ? 0 : 1)) {
        throw new Error("Invalid registration preparation policy");
      }
    }
  }
  get state() { return { active: this.active, queued: this.queue.length }; }
  private releaseSlot() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.queue.length && this.active < this.policy.concurrency) {
        const waiter = this.queue.shift()!;
        clearTimeout(waiter.timer);
        if (performance.now() >= waiter.expires) { waiter.reject(unavailable()); continue; }
        this.active++;
        waiter.resolve(this.releaseSlot());
      }
    };
  }
  private async acquire(): Promise<() => void> {
    if (this.active < this.policy.concurrency && !this.queue.length) {
      this.active++;
      return this.releaseSlot();
    }
    if (this.queue.length >= this.policy.queueSize) throw unavailable();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        expires: performance.now() + this.policy.queueMs, resolve, reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(unavailable());
        }, this.policy.queueMs),
      };
      this.queue.push(waiter);
    });
  }

  async run<T>(db: Connection, runtime: AccountRuntime,
    action: (tx: Connection, work: RegistrationWork) => Promise<T>): Promise<T> {
    const release = await this.acquire(); // No connection held by queued requests.
    let nativeSettled = true;
    let transactionSettled = false;
    const releaseIfSettled = () => { if (nativeSettled && transactionSettled) release(); };
    let client: ReturnType<typeof registrationTransactionClient> | undefined;
    let closing: Promise<void> | undefined;
    let aborted = false;
    let deadline = Infinity;
    let transactionTimer: ReturnType<typeof setTimeout> | undefined;
    let restoreRelease = () => {};
    let fail!: (reason: unknown) => void;
    const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
    // The deadline can fire between SQL awaits, not just during a hash race.
    void failure.catch(() => {});
    const abort = () => {
      if (aborted) return;
      aborted = true;
      fail(unavailable());
      // Do not call release() here: Drizzle owns the checkout and releases once.
      // end() makes pg-pool discard the client, including during a stalled query.
      if (client) closing = client.end().catch(() => {});
    };
    const onError = () => abort();
    const checkpoint = () => {
      if (performance.now() >= deadline) abort();
      if (aborted) throw unavailable();
    };
    const work: RegistrationWork = {
      checkpoint,
      hash: async (password) => {
        checkpoint();
        if (!nativeSettled) throw new Error("Registration hash already running");
        nativeSettled = false;
        // Keep the ORIGINAL, non-cancelled native Promise to track real capacity.
        const native = Promise.resolve().then(() => {
          checkpoint();
          return (runtime.registrationHash ?? hashPassword)(password);
        });
        const settled = () => { nativeSettled = true; releaseIfSettled(); };
        void native.then(settled, settled);
        const hashTimer = setTimeout(abort, this.policy.hashMs);
        try {
          const result = await Promise.race([native, failure]);
          checkpoint();
          return result;
        } finally { clearTimeout(hashTimer); }
      },
    };
    try {
      const result = await accountTransaction(db, async tx => {
        client = registrationTransactionClient(tx);
        client.on("error", onError); // Checked-out pg clients need an error listener.
        restoreRelease = guardRegistrationRelease(client, abort);
        deadline = performance.now() + this.policy.transactionMs;
        transactionTimer = setTimeout(abort, this.policy.transactionMs);
        const result = await action(tx, work);
        checkpoint(); // No commit after a failed/timed-out preparation.
        return result;
      });
      // The release guard can mark uncertainty even if the driver resolved.
      // Do not re-abort by clock after release: a different caller may own it.
      if (aborted) throw unavailable();
      return result;
    } catch (error) {
      // Teardown can replace the original timeout with a driver rollback error.
      if (aborted) throw unavailable();
      throw error;
    } finally {
      clearTimeout(transactionTimer);
      restoreRelease();
      transactionSettled = true;
      releaseIfSettled();
      // Keep the listener through COMMIT/ROLLBACK and socket teardown.
      if (closing) void closing.then(() => client?.removeListener("error", onError));
      else client?.removeListener("error", onError);
    }
  }
}

const processRuntime = globalThis as typeof globalThis & {
  syriacarRegistrationPreparation?: RegistrationPreparation;
};
export function prepareRegistration<T>(db: Connection, runtime: AccountRuntime,
  action: (tx: Connection, work: RegistrationWork) => Promise<T>) {
  const gate = runtime.registrationPreparation ??
    (processRuntime.syriacarRegistrationPreparation ??= new RegistrationPreparation());
  return gate.run(db, runtime, action);
}