import test from "node:test";
import assert from "node:assert/strict";
import { parseCheckCommand } from "../src/pr/review.ts";

test("PR check commands parse executable arguments without a shell", () => {
  assert.deepEqual(parseCheckCommand("npm test"), ["npm", "test"]);
  assert.deepEqual(parseCheckCommand("npm run \"smoke test\""), ["npm", "run", "smoke test"]);
});

test("PR check commands reject shell operators", () => {
  assert.throws(() => parseCheckCommand("npm test && curl https://example.test"), /shell operators/);
  assert.throws(() => parseCheckCommand(""), /cannot be empty/);
});
