import "server-only";

/**
 * Failed attempts per key (an email address, a user, an IP) over the last 15 minutes.
 * Sign-in and password checks run as server actions, which call the auth library directly and so
 * skip its HTTP rate limits; this puts a limit back. It lives in memory: production runs one web container.
 */
const WINDOW_MS = 15 * 60_000;
const failures = new Map<string, number[]>();

function recent(key: string, now = Date.now()): number[] {
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** True once a key has failed `max` times in the window. */
export function limited(key: string, max: number): boolean {
  return recent(key).length >= max;
}

export function recordFailure(...keys: string[]): void {
  const now = Date.now();
  if (failures.size > 10_000) for (const k of [...failures.keys()]) recent(k, now);
  for (const k of keys) failures.set(k, [...recent(k, now), now]);
}

export function clearFailures(...keys: string[]): void {
  for (const k of keys) failures.delete(k);
}

export const TOO_MANY = "Too many wrong attempts. Wait 15 minutes, then try again.";
