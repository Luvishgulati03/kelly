import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Kelly understands Hindi, Hinglish and Roman Hindi but always answers public visitors in English,
// in every mode (typed chat as well as spoken Talk/Counter).
test("public prompt: Kelly always answers in English, whatever language the visitor types in", () => {
  const source = fs.readFileSync(new URL("../src/public/prompt.ts", import.meta.url), "utf8");
  assert.match(source, /Always reply in clear English, even when the visitor writes in Hindi, Hinglish or Roman Hindi/);
  assert.doesNotMatch(source, /visitor's own language style/);
});
