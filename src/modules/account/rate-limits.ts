import { AccountError, messages } from "./validation.ts";

export const accountLimits = {
  registrationsPerIp: 5, registrationsPerPhone: 3, sendsPerPhone: 5,
  windowMs: 60 * 60 * 1000, failedLogins: 5, lockMs: 15 * 60 * 1000,
};
export class AccountLimits {
  private windows = new Map<string, { count: number; until: number }>();
  private failures = new Map<string, { count: number; lockedUntil: number }>();
  private take(keys: [string, number][], time: number) {
    for (const [key, entry] of this.windows) if (entry.until <= time) this.windows.delete(key);
    for (const [key, max] of keys) {
      if ((this.windows.get(key)?.count ?? 0) >= max) throw new AccountError(429, "محاولات كثيرة. حاول مجدداً لاحقاً.");
    }
    for (const [key] of keys) {
      const entry = this.windows.get(key) ?? { count: 0, until: time + accountLimits.windowMs };
      entry.count++;
      this.windows.set(key, entry);
    }
  }
  registration(phone: string, ip: string, time: number) {
    this.take([["register:ip:" + ip, accountLimits.registrationsPerIp],
      ["register:phone:" + phone, accountLimits.registrationsPerPhone]], time);
  }
  send(phone: string, time: number) { this.take([["send:" + phone, accountLimits.sendsPerPhone]], time); }
  loginKey(phone: string, ip: string) { return phone + ":" + ip; }
  checkLogin(key: string, time: number) {
    const entry = this.failures.get(key);
    if (entry?.lockedUntil && entry.lockedUntil <= time) this.failures.delete(key);
    else if (entry?.lockedUntil) throw new AccountError(429, messages.locked);
  }
  failLogin(key: string, time: number) {
    const entry = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
    entry.count++;
    if (entry.count >= accountLimits.failedLogins) entry.lockedUntil = time + accountLimits.lockMs;
    this.failures.set(key, entry);
    if (entry.lockedUntil) throw new AccountError(429, messages.locked);
  }
  successfulLogin(key: string) { this.failures.delete(key); }
}
const global = globalThis as typeof globalThis & { syriacarAccountLimits?: AccountLimits };
export function getAccountLimits() { return global.syriacarAccountLimits ??= new AccountLimits(); }