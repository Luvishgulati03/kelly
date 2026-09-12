import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { FillIncompleteError, PlaywrightJobBrowser, SiteShapeError, SubmissionOutcomeUnknownError } from "../src/jobs/browser.ts";
import { ActivityLog } from "../src/activity.ts";
import { loadConfig } from "../src/config.ts";
import type { JobApplicationDraft, JobQuestion } from "../src/jobs/types.ts";

const url = "https://fixture.invalid/application";
const q = (id: string, label: string, kind: JobQuestion["kind"] = "text"): JobQuestion => ({ id, label, kind, required: false });
const draft = (questions: JobQuestion[], answers: Record<string, string>): JobApplicationDraft => ({
  id: "fixture", posting: { id: "job", url, source: "generic", title: "Engineer", company: "Fixture", description: "", descriptionHash: "", questions, discoveredAt: "" },
  answers, coverLetter: "", rationale: {}, missingFacts: [], memoryIds: [], status: "drafted", createdAt: "", updatedAt: "",
});

async function fixture(html: string, run: (henry: PlaywrightJobBrowser, root: string, state: () => Record<string, unknown>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-job-fill-"));
  const browser = await chromium.launch({ headless: true });
  let captured: Record<string, unknown> = {};
  try {
    const config = { ...loadConfig(root), dataDir: root, activityPath: path.join(root, "activity.jsonl"), browserProfileDir: path.join(root, "must-not-exist") };
    const activity = new ActivityLog(config.activityPath);
    await activity.init();
    const henry = new PlaywrightJobBrowser(config, activity, async () => {
      const context = await browser.newContext({ serviceWorkers: "block" });
      await context.route("**/*", async (route) => {
        assert.equal(route.request().url(), url, "fixture must never request a live resource");
        assert.equal(route.request().method(), "GET");
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
      });
      const close = context.close.bind(context);
      context.close = async () => {
        const page: Page | undefined = context.pages()[0];
        if (page) captured = await page.evaluate(() => ({
          values: Object.fromEntries(Array.from(document.querySelectorAll("input,select,textarea")).map((node) => {
            const input = node as HTMLInputElement;
            return [input.id, input.type === "file" ? Array.from(input.files || []).map((file) => file.name) : input.type === "checkbox" ? input.checked : input.value];
          })),
          submits: document.body.dataset.submits || "0",
          selected: document.querySelector('[class*="singleValue"]')?.textContent,
        }));
        await close();
      };
      return context;
    });
    await run(henry, root, () => captured);
    await assert.rejects(fs.access(config.browserProfileDir));
  } finally {
    await browser.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const formStart = `<form onsubmit="event.preventDefault();document.body.dataset.submits=String(Number(document.body.dataset.submits||0)+1)">`;

test("Glean snapshot uses rendered text, required markers, custom combos, and excludes Attach files", async () => {
  await fixture(`<title>Job Application for Engineer at Glean</title><h1>Engineer</h1><main>Build useful tools<script>BOOTSTRAP_SECRET=${"x".repeat(4000)}</script><style>.unused{color:red}</style></main>
    <label for="first">First Name*</label><input id="first">
    <label for="last">Last Name</label><input id="last" aria-required="true">
    <label for="country">Country*</label><input id="country" role="combobox">
    <span id="heard-label">How did you hear about us?</span><input id="heard" role="combobox" aria-labelledby="heard-label">
    <label for="resume">Attach</label><input id="resume" type="file">
    <label for="cover">Attach</label><input id="cover" type="file">`, async (henry) => {
    const snapshot = await henry.inspect(url);
    assert.equal(snapshot.company, "Glean");
    assert.doesNotMatch(snapshot.description, /BOOTSTRAP_SECRET|unused/);
    assert.match(snapshot.description, /Build useful tools/);
    assert.deepEqual(snapshot.questions.map(({ id, required, kind }) => ({ id, required, kind })), [
      { id: "first", required: true, kind: "text" }, { id: "last", required: true, kind: "text" },
      { id: "country", required: true, kind: "single" }, { id: "heard", required: false, kind: "single" },
    ]);
  });
});

test("fill verifies native values, skips unsafe/unknown answers, and never implicitly submits", async () => {
  await fixture(`${formStart}
    <label for="first">Name</label><input id="first"><label for="second">Name</label><input id="second">
    <label for="unknown">Unknown</label><input id="unknown"><label for="placeholder">Placeholder</label><input id="placeholder">
    <label for="gender">Gender</label><input id="gender"><label for="race">Race</label><select id="race"><option value="">Select...</option><option>Asian</option></select>
    <label for="check">Confirm</label><input id="check" type="checkbox" checked>
    <label for="badcheck">Bad confirm</label><input id="badcheck" type="checkbox" checked>
    <label for="country">Country</label><select id="country"><option value="">Select...</option><option>India</option></select>
    <label for="badselect">Choice</label><select id="badselect"><option>Existing</option></select>
    <label for="locked">Locked</label><input id="locked" disabled>
    <label for="file">Attach</label><input id="file" type="file">
    <button id="submit">Submit application</button></form>`, async (henry, _root, state) => {
    const questions = [q("second", "Name"), q("unknown", "Unknown"), q("placeholder", "Placeholder"), q("gender", "Gender"), q("race", "Race", "single"), q("check", "Confirm", "boolean"), q("badcheck", "Bad confirm", "boolean"), q("country", "Country", "single"), q("badselect", "Choice", "single"), q("locked", "Locked"), q("file", "Attach"), q("absent", "Missing"), q("submit", "Submit application")];
    const result = await henry.fill(url, draft(questions, { second: "Luvish", unknown: "unknown", placeholder: "[Your answer]", gender: "Male", race: "Asian", check: "no", badcheck: "yesterday", country: "India", badselect: "Imaginary", locked: "x", file: "resume.pdf", absent: "x", submit: "x" }));
    assert.deepEqual(result.filled, ["Name", "Confirm", "Country"]);
    assert.deepEqual(result.skipped, ["Unknown", "Placeholder", "Gender", "Race", "Bad confirm", "Choice", "Locked", "Attach", "Missing", "Submit application"]);
    assert.deepEqual(result.verifiedValues, { Name: "Luvish", Confirm: "false", Country: "India" });
    assert.deepEqual(state().values, { first: "", second: "Luvish", unknown: "", placeholder: "", gender: "", race: "", check: false, badcheck: true, country: "India", badselect: "Existing", locked: "", file: [] });
    assert.equal(state().submits, "0");
    assert.ok(result.screenshotPath);
  });
});

test("Greenhouse React Select commits an exact option and reports an unmatched option as skipped", async () => {
  await fixture(`${formStart}<label for="country">Country*</label>
    <div class="select__control"><span class="select__singleValue"></span><input id="country" role="combobox" aria-controls="countries" onclick="document.getElementById('countries').hidden=false"></div>
    <div id="countries" role="listbox" hidden><div role="option" onclick="document.querySelector('.select__singleValue').textContent=this.textContent;document.getElementById('countries').hidden=true">India</div><div role="option">Indiana</div></div>
    <label for="heard">How heard?</label><input id="heard" role="combobox" aria-controls="sources" onclick="document.getElementById('sources').hidden=false">
    <div id="sources" role="listbox" hidden><div role="option">Friend</div></div><button>Submit application</button></form>`, async (henry, _root, state) => {
    const result = await henry.fill(url, draft([q("country", "Country*", "single"), q("heard", "How heard?", "single")], { country: "India", heard: "Unknown source" }));
    assert.deepEqual(result.filled, ["Country*"]);
    assert.deepEqual(result.skipped, ["How heard?"]);
    assert.equal(state().selected, "India");
    assert.equal(state().submits, "0");
  });
});

test("resume upload requires a unique resume descriptor even with duplicate Attach labels", async () => {
  for (const inputs of [
    '<label for="resume">Attach</label><input id="resume" type="file"><label for="cover">Attach</label><input id="cover" type="file">',
    '<label for="cover">Cover letter</label><input id="cover" type="file">',
    '<label for="generic">Attach</label><input id="generic" type="file">',
    '<label for="a">Resume</label><input id="a" type="file"><label for="b">CV</label><input id="b" type="file">',
    '<label for="upload">Résumé</label><input id="upload" type="file" hidden>',
  ]) {
    await fixture(`${formStart}${inputs}<button>Submit application</button></form>`, async (henry, root, state) => {
      const application = draft([], {});
      application.resumePdfPath = path.join(root, "resume.pdf");
      await fs.writeFile(application.resumePdfPath, "%PDF-1.4 fixture");
      const result = await henry.fill(url, application);
      const expected = inputs.includes('id="resume"') || inputs.includes("Résumé");
      assert.deepEqual(result.filled, expected ? ["resume upload"] : [], inputs);
      assert.deepEqual(result.skipped, expected ? [] : ["resume upload"], inputs);
      assert.deepEqual(result.verifiedValues, expected ? { "resume upload": "resume.pdf" } : {}, inputs);
      const values = state().values as Record<string, string[]>;
      assert.equal(Object.values(values).flat().length, expected ? 1 : 0);
      if (values.cover) assert.deepEqual(values.cover, []);
      assert.equal(state().submits, "0");
    });
  }
});

test("submit refuses when a required field was not filled", async () => {
  await fixture(`${formStart}
    <label for="name">Name*</label><input id="name">
    <button>Submit application</button></form>`, async (henry, _root, state) => {
    const application = draft([{ ...q("name", "Name*"), required: true }], {});
    // No answer was supplied for this required field, so this is the "needs a person"
    // case rather than the "try again" one — and either way nothing may be clicked.
    await assert.rejects(henry.submit(url, application), (error: unknown) => {
      assert.ok(error instanceof FillIncompleteError);
      assert.equal(error.retryable, false, "Henry has no answer to place; retrying cannot help");
      return true;
    });
    assert.equal(state().submits, "0");
  });
});

test("submit does not report success without a clear confirmation", async () => {
  await fixture(`${formStart}
    <label for="name">Name*</label><input id="name">
    <button>Submit application</button></form>`, async (henry, _root, state) => {
    const application = draft([{ ...q("name", "Name*"), required: true }], { name: "Luvish" });
    await assert.rejects(henry.submit(url, application), SubmissionOutcomeUnknownError, "clicked-but-unconfirmed must surface as an UNKNOWN outcome, never as success");
    assert.equal(state().submits, "1");
  });
});

test("submit rejects negative confirmation text", async () => {
  await fixture(`<form onsubmit="event.preventDefault();document.body.dataset.submits=String(Number(document.body.dataset.submits||0)+1);document.querySelector('main').textContent='Application was NOT submitted. Please complete required fields.'">
    <main><label for="name">Name*</label><input id="name"></main>
    <button>Submit application</button></form>`, async (henry, _root, state) => {
    const application = draft([{ ...q("name", "Name*"), required: true }], { name: "Luvish" });
    await assert.rejects(henry.submit(url, application), SubmissionOutcomeUnknownError, "clicked-but-unconfirmed must surface as an UNKNOWN outcome, never as success");
    assert.equal(state().submits, "1");
  });
});

test("submit ignores preexisting footer confirmation copy unless a new positive confirmation appears", async () => {
  await fixture(`${formStart}
    <main><label for="name">Name*</label><input id="name"><p>Saved draft.</p></main>
    <footer>Thank you for applying.</footer>
    <button>Submit application</button></form>`, async (henry, _root, state) => {
    const application = draft([{ ...q("name", "Name*"), required: true }], { name: "Luvish" });
    await assert.rejects(henry.submit(url, application), SubmissionOutcomeUnknownError, "clicked-but-unconfirmed must surface as an UNKNOWN outcome, never as success");
    assert.equal(state().submits, "1");
  });
});

test("submit accepts a new positive confirmation even when footer copy was already present", async () => {
  await fixture(`<form onsubmit="event.preventDefault();document.body.dataset.submits=String(Number(document.body.dataset.submits||0)+1);document.querySelector('main').textContent='Application submitted.'">
    <main><label for="name">Name*</label><input id="name"></main>
    <footer>Thank you for applying.</footer>
    <button>Submit application</button></form>`, async (henry, _root, state) => {
    const application = draft([{ ...q("name", "Name*"), required: true }], { name: "Luvish" });
    const result = await henry.submit(url, application);
    assert.match(result.confirmationText, /Application submitted/);
    assert.equal(state().submits, "1");
  });
});

test("submit does not treat Apply now as the final submit button", async () => {
  await fixture(`${formStart}
    <label for="name">Name*</label><input id="name">
    <button>Apply now</button></form>`, async (henry, _root, state) => {
    const application = draft([{ ...q("name", "Name*"), required: true }], { name: "Luvish" });
    await assert.rejects(henry.submit(url, application), /Could not identify exactly one final application button/);
    assert.equal(state().submits, "0");
  });
});

test("submit requires supplied resume upload to verify before clicking", async () => {
  await fixture(`${formStart}
    <label for="name">Name*</label><input id="name">
    <label for="generic">Attach</label><input id="generic" type="file">
    <button>Submit application</button></form>`, async (henry, root, state) => {
    const application = draft([{ ...q("name", "Name*"), required: true }], { name: "Luvish" });
    application.resumePdfPath = path.join(root, "resume.pdf");
    await fs.writeFile(application.resumePdfPath, "%PDF-1.4 fixture");
    await assert.rejects(henry.submit(url, application), /Resume upload was not verified/);
    assert.equal(state().submits, "0");
  });
});

test("submit returns success only after a clear confirmation", async () => {
  await fixture(`<form onsubmit="event.preventDefault();document.body.dataset.submits=String(Number(document.body.dataset.submits||0)+1);document.querySelector('main').textContent='Application submitted. Thank you for applying.'">
    <main><label for="name">Name*</label><input id="name"></main>
    <button>Submit application</button></form>`, async (henry, _root, state) => {
    const application = draft([{ ...q("name", "Name*"), required: true }], { name: "Luvish" });
    const result = await henry.submit(url, application);
    assert.match(result.confirmationText, /Application submitted/);
    assert.equal(state().submits, "1");
  });
});

/**
 * A click that produced no confirmation is NOT the same failure as the refusals that
 * happen before the click. The application may already be with the employer, so the
 * error carries that fact — the service records uncertainty and refuses to retry rather
 * than marking it failed and inviting a second submission.
 */
test("a submit click with no confirmation reports an UNKNOWN outcome, not a plain failure", async () => {
  await fixture(`<h1>Engineer</h1><form><button type="button">Submit application</button></form>`, async (henry) => {
    const applied = draft([], {});
    await assert.rejects(
      () => henry.submit(url, applied),
      (error: unknown) => {
        assert.ok(error instanceof SubmissionOutcomeUnknownError, `post-click failure must be distinguishable, got ${String(error)}`);
        assert.equal((error as SubmissionOutcomeUnknownError).clicked, true, "the caller has to know the click happened");
        assert.match(String((error as Error).message), /may or may not|verify by hand/i);
        return true;
      },
    );
  });
});

test("an ambiguous submit control is refused BEFORE clicking, and stays an ordinary error", async () => {
  await fixture(`<h1>Engineer</h1><form><button type="button">Submit</button><button type="button">Submit application</button></form>`, async (henry) => {
    await assert.rejects(
      () => henry.submit(url, draft([], {})),
      (error: unknown) => {
        assert.ok(!(error instanceof SubmissionOutcomeUnknownError), "nothing was clicked, so this must NOT be an unknown outcome");
        assert.match(String((error as Error).message), /exactly one final application button/i);
        return true;
      },
    );
  });
});

/**
 * A required field Henry HAS an answer for is a placement failure — the form probably
 * hydrated late — so it is worth another pass. A required field Henry has NO answer for
 * never will be: another pass cannot invent the fact, and saying so is the point.
 */
test("an unfilled required field is retryable only when Henry actually holds the answer", async () => {
  await fixture(`${formStart}<label for="answered">Answered*</label><input id="answered" disabled>`, async (henry) => {
    const questions = [{ id: "answered", label: "Answered*", kind: "text" as const, required: true }];
    await assert.rejects(
      () => henry.submit(url, draft(questions, { answered: "we have this" })),
      (error: unknown) => {
        assert.ok(error instanceof FillIncompleteError);
        assert.equal(error.retryable, true, "Henry had the answer — another pass is worth trying");
        assert.deepEqual(error.withoutAnswers, [], "nothing is missing; this was a placement failure");
        return true;
      },
    );
  });

  await fixture(`${formStart}<label for="unanswered">Unanswered*</label><input id="unanswered" disabled>`, async (henry) => {
    const questions = [{ id: "unanswered", label: "Unanswered*", kind: "text" as const, required: true }];
    await assert.rejects(
      () => henry.submit(url, draft(questions, {})),
      (error: unknown) => {
        assert.ok(error instanceof FillIncompleteError);
        assert.equal(error.retryable, false, "no answer exists, so retrying can only fail again");
        assert.deepEqual(error.withoutAnswers, ["Unanswered*"]);
        assert.match(String((error as Error).message), /will not guess|supply the fact/i);
        return true;
      },
    );
  });
});

test("a page shaped wrong is the employer's problem, not something to retry", async () => {
  await fixture(`<h1>Engineer</h1><form><button type="button">Submit</button><button type="button">Submit application</button></form>`, async (henry) => {
    await assert.rejects(
      () => henry.submit(url, draft([], {})),
      (error: unknown) => {
        assert.ok(error instanceof SiteShapeError, "an ambiguous page must be distinguishable from a fill miss");
        assert.equal(error.retryable, false, "retrying an unchanged page changes nothing");
        assert.equal(error.clicked, false, "and nothing was sent");
        return true;
      },
    );
  });
});
