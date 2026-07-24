// In-memory virtual-key store for the magpie gateway.
//
// NO database (CTO decision — see PLAN.md §5's "Custom OpenRouter-only proxy"
// note and this package's README). Keys are per-job and ephemeral by design:
// the orchestrator mints one right before a review run and revokes it on
// cleanup, so losing the whole store on a process restart is an accepted,
// expected property, not a bug — every key in flight belongs to a job that
// will simply fail closed (its virtual key stops working) and the job's own
// pipeline-level failure handling takes it from there.
//
// Two maps: `id -> entry` (what the admin plane addresses) and
// `key -> id` (what the proxy plane looks up on every request, keyed by the
// bearer token itself so a hot-path lookup never has to scan). TTL expiry is
// enforced lazily, on lookup, rather than with a background sweep — simplest
// correct option for a small in-memory map that's never expected to hold more
// than a handful of entries (per-job concurrency is single digits, see
// config.ts's `limits.concurrency` in the orchestrator).

import { randomBytes } from "node:crypto";

/** One virtual key's full record. Matches the M4-A task's LOCKED shape exactly. */
export interface KeyEntry {
  id: string;
  key: string;
  budgetUsd: number;
  spentUsd: number;
  model?: string;
  /** Epoch milliseconds. Past this, {@link KeyStore.findByKey} treats the key as gone. */
  expiresAt: number;
}

/** Inputs to {@link KeyStore.mint}. */
export interface MintKeyParams {
  model?: string;
  budgetUsd: number;
  ttlSeconds: number;
}

/** A revoked key's final spend snapshot — see {@link KeyStore.revoke} (M5-D). */
export interface RevokedKeySpend {
  id: string;
  spentUsd: number;
  budgetUsd: number;
}

/** Prefix on every minted virtual key, so one glance at a leaked string identifies it as a magpie gateway key. */
const KEY_PREFIX = "sk-magpie-";

export class KeyStore {
  #entries = new Map<string, KeyEntry>();
  #keyToId = new Map<string, string>();

  /**
   * Mint a fresh, crypto-random virtual key and store it. `budgetUsd` and
   * `ttlSeconds` are the caller's responsibility to validate (see
   * admin-server.ts's zod schema) — this method trusts its params.
   */
  mint(params: MintKeyParams): { id: string; key: string } {
    // Opportunistic cleanup: expired entries are normally evicted lazily on
    // `findByKey` (see below), but a key that is minted and then NEVER looked
    // up or revoked — e.g. the orchestrator is hard-killed after minting, or
    // a review makes zero LLM calls — would otherwise linger in the maps
    // forever. Sweeping on mint keeps this long-running service's store from
    // slowly accumulating dead entries. Cheap: the store never holds more
    // than single-digit live keys (see class doc comment).
    this.#evictExpired();
    const id = randomBytes(8).toString("hex");
    const key = `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
    const entry: KeyEntry = {
      id,
      key,
      budgetUsd: params.budgetUsd,
      spentUsd: 0,
      model: params.model,
      expiresAt: Date.now() + params.ttlSeconds * 1000,
    };
    this.#entries.set(id, entry);
    this.#keyToId.set(key, id);
    return { id, key };
  }

  /**
   * Revoke a key by id. Idempotent by contract (M4-A): revoking an
   * unknown or already-revoked id is a silent no-op, never an error — the
   * orchestrator's cleanup path calls this unconditionally and must never
   * fail a job over a double-revoke race.
   *
   * Returns the entry's final `{ id, spentUsd, budgetUsd }` snapshot (taken
   * BEFORE deletion) so the caller can surface the key's authoritative final
   * spend — see admin-server.ts's `DELETE /admin/keys/:id`, added in M5-D so
   * the orchestrator can log real gateway-tracked cost instead of only Pi's
   * self-reported usage. Returns `undefined` for an unknown/already-revoked
   * id — there is no spend to report for a key this store never held (or no
   * longer holds).
   */
  revoke(id: string): RevokedKeySpend | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    this.#entries.delete(id);
    this.#keyToId.delete(entry.key);
    return { id: entry.id, spentUsd: entry.spentUsd, budgetUsd: entry.budgetUsd };
  }

  /**
   * Look up a live entry by its bearer-token value (the proxy plane's hot
   * path). Returns `undefined` for an unknown key OR one whose TTL has
   * elapsed — expired entries are lazily evicted from both maps here so they
   * don't linger. Callers must treat `undefined` as "reject with 401",
   * exactly as an unknown/revoked key.
   */
  findByKey(key: string): KeyEntry | undefined {
    const id = this.#keyToId.get(key);
    if (!id) return undefined;
    const entry = this.#entries.get(id);
    if (!entry) {
      // Shouldn't happen (the two maps are kept in lockstep by mint/revoke),
      // but don't leave a dangling reverse-map entry if it ever does.
      this.#keyToId.delete(key);
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.#entries.delete(id);
      this.#keyToId.delete(key);
      return undefined;
    }
    return entry;
  }

  /** True once `entry.spentUsd` has reached (or passed) `entry.budgetUsd` — the hard cost cap. */
  isOverBudget(entry: KeyEntry): boolean {
    return entry.spentUsd >= entry.budgetUsd;
  }

  /**
   * Debit `costUsd` (clamped to >= 0 — a negative/NaN cost never reduces
   * spend) from the entry's running total, post-hoc, after a request
   * completes. A no-op if `id` is no longer present (revoked/expired mid
   * request) — the request that was already in flight is not retroactively
   * un-served, and there's nothing left to charge.
   */
  recordSpend(id: string, costUsd: number): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    const safeCost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
    entry.spentUsd += safeCost;
  }

  /** Evict every entry whose TTL has elapsed from both maps. Called opportunistically on {@link mint} so keys that are never looked up or revoked don't linger; {@link findByKey} still evicts individually on the hot path. */
  #evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.#entries) {
      if (now >= entry.expiresAt) {
        this.#entries.delete(id);
        this.#keyToId.delete(entry.key);
      }
    }
  }

  /** Test/introspection helper: number of live (not-yet-expired, per {@link findByKey}'s lazy eviction) entries. Not part of the locked HTTP contract. */
  get size(): number {
    return this.#entries.size;
  }
}

/** Factory, matching the rest of the codebase's `createX()` convention (see server.ts's `createWebhookServer`). */
export function createKeyStore(): KeyStore {
  return new KeyStore();
}
