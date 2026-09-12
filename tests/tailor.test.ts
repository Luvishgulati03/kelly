import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResume, numberGuard, skillsUnchanged, renderResumeHtml, bulletShapesMatch, linkifyContact, resumeFileName } from "../src/jobs/tailor.ts";

const FIXTURE = `# JANE BUILDER

+00-1234567890 | Sample City | jane@example.com | LinkedIn

## PROFILE

Product-minded engineer who ships.

## EXPERIENCE

### Acme Corp | Sample City — Engineer (Jan 2025 - Present)

- Shipped a platform generating 516 opens and 447 clicks in 30 days.
- Automated 53 of 57 scenarios.

### Beta Ltd | Other City — Analyst (Feb 2024 - Dec 2024)

- Removed 4 hours of manual work daily.

## KEY PROJECTS

### Widget — Open Source

- Built a widget used at 2-3 institutions.

## EDUCATION

B.Tech, CS — Example University (2021 - 2025)

## SKILLS

- **Product:** PRDs, GTM, Roadmapping
- **Engineering:** TypeScript, Python
`;

test("parseResume extracts full structure from the known format", () => {
  const parsed = parseResume(FIXTURE);
  assert.equal(parsed.name, "JANE BUILDER");
  assert.match(parsed.contact, /jane@example\.com/);
  assert.equal(parsed.experience.length, 2);
  assert.deepEqual(
    parsed.experience[0],
    {
      company: "Acme Corp", location: "Sample City", title: "Engineer", dates: "Jan 2025 - Present",
      bullets: ["Shipped a platform generating 516 opens and 447 clicks in 30 days.", "Automated 53 of 57 scenarios."],
    },
  );
  assert.equal(parsed.projects.length, 1);
  assert.equal(parsed.education, "B.Tech, CS — Example University");
  assert.equal(parsed.educationDates, "2021 - 2025");
  assert.deepEqual(parsed.skills.map((s) => s.label), ["Product", "Engineering"]);
});

test("numberGuard flags metrics that do not exist in the base", () => {
  assert.deepEqual(numberGuard(FIXTURE, "Generated 516 opens and 447 clicks"), []);
  assert.deepEqual(numberGuard(FIXTURE, "Improved conversion by 38% across 12 teams"), ["38", "12"]);
  // comma-formatted numbers normalize before matching
  assert.deepEqual(numberGuard("raised 1,000 users", "grew to 1000 users"), []);
});

test("skillsUnchanged allows reorder within a row, rejects edits", () => {
  const base = [{ label: "Product", items: "PRDs, GTM, Roadmapping" }];
  assert.equal(skillsUnchanged(base, [{ label: "Product", items: "GTM, Roadmapping, PRDs" }]), true);
  assert.equal(skillsUnchanged(base, [{ label: "Product", items: "GTM, Roadmapping" }]), false);
  assert.equal(skillsUnchanged(base, [{ label: "Product", items: "GTM, Roadmapping, PRDs, Jira" }]), false);
  assert.equal(skillsUnchanged(base, [{ label: "Tools", items: "PRDs, GTM, Roadmapping" }]), false);
});

test("renderResumeHtml escapes content and keeps template structure", () => {
  const parsed = parseResume(FIXTURE);
  parsed.profile = "Ships <fast> & true.";
  const html = renderResumeHtml(parsed);
  assert.match(html, /Ships &lt;fast&gt; &amp; true\./);
  assert.match(html, /class="name">JANE BUILDER/);
  assert.match(html, /Key Projects/);
  assert.doesNotMatch(html, /<fast>/);
});

test("the contact line is linkified from the RESUME'S data — no address or profile is baked into the framework", () => {
  const html = renderResumeHtml(parseResume(FIXTURE));
  // The fixture's own address becomes the mailto — and it is the ONLY one in the document.
  assert.match(html, /<a href="mailto:jane@example\.com">jane@example\.com<\/a>/);
  assert.deepEqual(html.match(/mailto:[^"]+/g), ["mailto:jane@example.com"]);
  // No linkedin.com/in/... URL in the contact line → the word stays PLAIN TEXT rather than
  // pointing at somebody else's profile.
  assert.doesNotMatch(html, /linkedin\.com/i);
  assert.match(html, /<span class="sep">\|<\/span> LinkedIn/);
});

test("linkifyContact links LinkedIn only to a profile URL the contact line actually carries", () => {
  const withUrl = linkifyContact("jane@example.com | linkedin.com/in/jane-builder | LinkedIn");
  assert.match(withUrl, /<a href="https:\/\/linkedin\.com\/in\/jane-builder">linkedin\.com\/in\/jane-builder<\/a>/);
  assert.match(withUrl, /<a href="https:\/\/linkedin\.com\/in\/jane-builder">LinkedIn<\/a>/);
  const httpsUrl = linkifyContact("https://www.linkedin.com/in/sam-dev-99 | LinkedIn");
  assert.match(httpsUrl, /<a href="https:\/\/www\.linkedin\.com\/in\/sam-dev-99">LinkedIn<\/a>/, "an already-absolute URL is used as-is");
  assert.equal(linkifyContact("Some City | LinkedIn"), "Some City | LinkedIn", "no URL, no link");
  // Escaping still happens before linkification — markup in the contact line can never inject.
  assert.match(linkifyContact("<b>x</b> | jane@example.com"), /^&lt;b&gt;x&lt;\/b&gt; \| <a href="mailto:jane@example\.com">/);
});

test("resumeFileName derives the PDF name from the resume's own name, not a baked-in one", () => {
  assert.equal(resumeFileName("JANE BUILDER", "Acme Corp"), "Jane_Builder_Resume_acme_corp.pdf");
  assert.equal(resumeFileName("Jean-Luc Picard", "Beta Ltd"), "Jean_Luc_Picard_Resume_beta_ltd.pdf");
  assert.equal(resumeFileName("", "Acme Corp"), "Resume_acme_corp.pdf", "a nameless resume still gets a usable filename");
  assert.equal(resumeFileName(parseResume(FIXTURE).name, "the company"), "Jane_Builder_Resume_the_company.pdf");
});

test("every font-size in the template scales with --fit — a fixed-size element would make the shrink ladder under-deliver", () => {
  const html = renderResumeHtml(parseResume(FIXTURE), 0.93);
  const styleBlock = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const fontSizes = styleBlock.match(/font-size:[^;]*/g) ?? [];
  assert.ok(fontSizes.length >= 8, "template should declare several font sizes");
  for (const declaration of fontSizes) {
    assert.match(declaration, /var\(--fit/, `${declaration} must scale with --fit`);
  }
  assert.match(html, /--fit:0\.93/);
});

test("bulletShapesMatch enforces per-entry bullet counts, not just outer array lengths", () => {
  const base = parseResume(FIXTURE);
  const exp = base.experience.map((e) => [...e.bullets]);
  const proj = base.projects.map((p) => [...p.bullets]);
  assert.equal(bulletShapesMatch(base, exp, proj), true);
  assert.equal(bulletShapesMatch(base, undefined, proj), false);
  assert.equal(bulletShapesMatch(base, exp.slice(1), proj), false, "missing outer entry must reject");
  const shrunk = base.experience.map((e) => [...e.bullets]);
  shrunk[0] = shrunk[0].slice(1); // outer lengths still match — entry 0 quietly lost a bullet
  assert.equal(bulletShapesMatch(base, shrunk, proj), false, "a shrunken entry must reject even when outer lengths match");
});
