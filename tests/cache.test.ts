import test from "node:test";
import assert from "node:assert/strict";
import { HotCache, MemoryCache } from "../src/cache.ts";

test("memory cache expires values and evicts least recently used entries", () => {
  let now = 0;
  const cache = new MemoryCache({ maxEntries: 2, now: () => now });
  cache.set("a", 1, 100);
  cache.set("b", 2, 100);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3, 100);
  assert.equal(cache.get("b"), undefined);
  now = 101;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), undefined);
});

test("hot cache coalesces concurrent identical loads", async () => {
  const cache = new HotCache(new MemoryCache());
  let loads = 0;
  const load = async () => { loads += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return "ready"; };
  const values = await Promise.all([cache.getOrSet("same", 1000, load), cache.getOrSet("same", 1000, load)]);
  assert.deepEqual(values, ["ready", "ready"]);
  assert.equal(loads, 1);
  assert.equal(await cache.getOrSet("same", 1000, load), "ready");
  assert.equal(loads, 1);
});
