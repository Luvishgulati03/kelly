import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNotLinkedInAutomation } from "../src/jobs/service.ts";
import { parseAlertPrefLine } from "../src/jobs/alerts.ts";

test("linkedin hard rail: blocks every linkedin host for automation, nothing else", () => {
  assert.throws(() => assertNotLinkedInAutomation("https://www.linkedin.com/jobs/view/123", "submission"), /blocked by design/);
  assert.throws(() => assertNotLinkedInAutomation("https://linkedin.com/jobs/view/123", "form-filling"), /Easy Apply stays human/);
  assert.throws(() => assertNotLinkedInAutomation("https://in.linkedin.com/jobs/view/9", "submission"), /blocked/);

  // Similar-looking hosts must NOT be blocked — greenhouse/lever/naukri stay automatable.
  assert.doesNotThrow(() => assertNotLinkedInAutomation("https://boards.greenhouse.io/x/jobs/1", "submission"));
  assert.doesNotThrow(() => assertNotLinkedInAutomation("https://notlinkedin.com/jobs/1", "submission"));
  assert.doesNotThrow(() => assertNotLinkedInAutomation("https://linkedin.com.evil.example/jobs", "submission"));
  // Hard rails FAIL CLOSED: garbage input is a refusal, not a pass (audit B-M13d).
  assert.throws(() => assertNotLinkedInAutomation("not a url at all", "submission"), /unparseable/);
  assert.throws(() => assertNotLinkedInAutomation("https://lnkd.in/abc123", "submission"), /blocked/);
  assert.throws(() => assertNotLinkedInAutomation("https://www.linkedin.com./jobs/view/1", "submission"), /blocked/, "trailing-dot host must not bypass");
});

test("alert-preference lines parse defensively", () => {
  assert.deepEqual(parseAlertPrefLine("ALERT|AI Product Manager|Bengaluru|linkedin"), {
    title: "AI Product Manager", location: "Bengaluru", source: "linkedin",
  });
  assert.deepEqual(parseAlertPrefLine("ALERT|APM|  |Naukri")?.location, "unknown");
  assert.equal(parseAlertPrefLine("random prose about jobs"), undefined);
  assert.equal(parseAlertPrefLine("ALERT|only-two-parts"), undefined);
  assert.equal(parseAlertPrefLine(`ALERT|${"x".repeat(200)}|Bengaluru|linkedin`), undefined, "absurd titles are model noise, not preferences");
});
