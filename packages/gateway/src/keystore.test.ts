import { describe, expect, it, vi } from "vitest";
import { createKeyStore } from "./keystore.js";

describe("KeyStore", () => {
  it("mints a key with the sk-magpie- prefix and a fresh id, and it's immediately findable", () => {
    const store = createKeyStore();
    const { id, key } = store.mint({ budgetUsd: 1, ttlSeconds: 60 });

    expect(key.startsWith("sk-magpie-")).toBe(true);
    expect(id).toBeTruthy();

    const entry = store.findByKey(key);
    expect(entry).toBeDefined();
    expect(entry?.id).toBe(id);
    expect(entry?.budgetUsd).toBe(1);
    expect(entry?.spentUsd).toBe(0);
    expect(entry?.model).toBeUndefined();
  });

  it("mints two keys with distinct ids and key values", () => {
    const store = createKeyStore();
    const a = store.mint({ budgetUsd: 1, ttlSeconds: 60 });
    const b = store.mint({ budgetUsd: 1, ttlSeconds: 60 });
    expect(a.id).not.toBe(b.id);
    expect(a.key).not.toBe(b.key);
  });

  it("carries the optional model scope through to the entry", () => {
    const store = createKeyStore();
    const { key } = store.mint({ budgetUsd: 1, ttlSeconds: 60, model: "anthropic/claude-sonnet-4.5" });
    expect(store.findByKey(key)?.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("findByKey returns undefined for an unknown key", () => {
    const store = createKeyStore();
    expect(store.findByKey("sk-magpie-does-not-exist")).toBeUndefined();
  });

  it("revoke is idempotent: revoking an unknown id never throws, and revoking twice is a no-op the second time", () => {
    const store = createKeyStore();
    expect(() => store.revoke("does-not-exist")).not.toThrow();

    const { id, key } = store.mint({ budgetUsd: 1, ttlSeconds: 60 });
    store.revoke(id);
    expect(store.findByKey(key)).toBeUndefined();
    expect(() => store.revoke(id)).not.toThrow(); // second revoke, same id
  });

  it("mint -> use (spend within budget) -> spend crosses budget -> isOverBudget flips true", () => {
    const store = createKeyStore();
    const { id, key } = store.mint({ budgetUsd: 0.05, ttlSeconds: 60 });
    const entry = store.findByKey(key)!;
    expect(store.isOverBudget(entry)).toBe(false);

    store.recordSpend(id, 0.03);
    expect(store.isOverBudget(store.findByKey(key)!)).toBe(false);

    store.recordSpend(id, 0.03); // total 0.06 >= 0.05 budget
    expect(store.isOverBudget(store.findByKey(key)!)).toBe(true);
  });

  it("recordSpend clamps negative/NaN costs to zero rather than reducing spend", () => {
    const store = createKeyStore();
    const { id, key } = store.mint({ budgetUsd: 1, ttlSeconds: 60 });
    store.recordSpend(id, 0.5);
    store.recordSpend(id, -10);
    store.recordSpend(id, NaN);
    expect(store.findByKey(key)?.spentUsd).toBe(0.5);
  });

  it("recordSpend on a revoked/unknown id is a silent no-op", () => {
    const store = createKeyStore();
    expect(() => store.recordSpend("nope", 1)).not.toThrow();
  });

  it("expires a key once its TTL elapses, and findByKey stops returning it", () => {
    vi.useFakeTimers();
    try {
      const store = createKeyStore();
      const { key } = store.mint({ budgetUsd: 1, ttlSeconds: 10 });
      expect(store.findByKey(key)).toBeDefined();

      vi.advanceTimersByTime(10_001);
      expect(store.findByKey(key)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
