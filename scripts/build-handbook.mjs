import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const handbookDir = path.join(rootDir, 'docs', 'handbook');
const outputPath = path.join(handbookDir, 'index.html');

const sections = [
  { key: 'README.md', id: 'overview', navLabel: 'Overview', eyebrow: 'START HERE', number: '00' },
  { key: '01-open-the-repo.md', id: 'stage-1', navLabel: 'Welcome & setup', eyebrow: 'STAGE 01', number: '01' },
  { key: '02-install-and-verify.md', id: 'stage-2', navLabel: 'IDEATION', eyebrow: 'STAGE 02', number: '02' },
  { key: '03-shape-the-agent.md', id: 'stage-3', navLabel: 'Soul & personality', eyebrow: 'STAGE 03', number: '03' },
  { key: '04-choose-the-provider.md', id: 'stage-4', navLabel: 'BUILDING', eyebrow: 'STAGE 04', number: '04' },
  { key: '05-talk-to-henry.md', id: 'stage-5', navLabel: 'Memory vs knowledge', eyebrow: 'STAGE 05', number: '05' },
  { key: '06-use-memory.md', id: 'stage-6', navLabel: 'Surfaces & approval', eyebrow: 'STAGE 06', number: '06' },
  { key: '07-build-knowledge.md', id: 'stage-7', navLabel: 'Daily demo path', eyebrow: 'STAGE 07', number: '07' },
  { key: '08-automate-carefully.md', id: 'stage-8', navLabel: 'Troubleshooting', eyebrow: 'STAGE 08', number: '08' },
  { key: '09-extend-safely.md', id: 'stage-9', navLabel: 'Extend safely', eyebrow: 'STAGE 09', number: '09' },
  { key: 'IDEATION.md', id: 'ideation-template', navLabel: 'IDEATION template', eyebrow: 'REFERENCE', number: 'I' },
  { key: 'BUILDING.md', id: 'building-template', navLabel: 'BUILDING template', eyebrow: 'REFERENCE', number: 'B' },
];

const sectionByFile = new Map(sections.map((section) => [section.key.toLowerCase(), section]));

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}

function resolveHref(href) {
  const cleanHref = href.trim();
  if (/^(?:javascript|data|vbscript):/i.test(cleanHref)) return '#';
  const [filePart, fragment] = cleanHref.split('#');
  if (!filePart && fragment) return `#${fragment}`;

  const fileName = path.basename(filePart).toLowerCase();
  const target = sectionByFile.get(fileName);
  if (target) return `#${target.id}${fragment ? `-${slugify(fragment)}` : ''}`;
  return cleanHref;
}

function inlineMarkdown(value) {
  const tokens = [];
  const stash = (html) => {
    const token = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return token;
  };

  let output = escapeHtml(value);
  output = output.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${code}</code>`));
  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const resolved = resolveHref(href);
    const external = /^(?:https?:)?\/\//.test(resolved);
    const attributes = external ? ' target="_blank" rel="noreferrer"' : '';
    return stash(`<a href="${escapeHtml(resolved)}"${attributes}>${inlineMarkdown(label)}</a>`);
  });
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  output = output.replace(/_([^_]+)_/g, '<em>$1</em>');
  return output.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'Untitled section';
}

function withoutTitle(markdown) {
  return markdown.replace(/^#\s+.+\n+/, '');
}

function renderMarkdown(markdown, sectionId) {
  const lines = markdown.replaceAll('\r', '').split('\n');
  const output = [];
  let paragraph = [];
  let headingCount = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const content = paragraph.join(' ').trim();
    if (content) output.push(`<p>${inlineMarkdown(content)}</p>`);
    paragraph = [];
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(.*)$/);
    if (fence) {
      flushParagraph();
      const language = fence[1].trim() || 'text';
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(`
        <div class="code-frame" data-language="${escapeHtml(language)}">
          <div class="code-frame__bar">
            <span class="code-frame__language">${escapeHtml(language)}</span>
            <button class="copy-button" type="button" data-copy aria-label="Copy ${escapeHtml(language)} code">Copy</button>
          </div>
          <pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>
        </div>`);
      continue;
    }

    const heading = line.match(/^(#{2,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(6, heading[1].length);
      const text = heading[2].trim();
      headingCount += 1;
      const headingId = `${sectionId}-${slugify(text)}-${headingCount}`;
      output.push(`<h${level} id="${headingId}">${inlineMarkdown(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      flushParagraph();
      output.push('<hr>');
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      output.push(`<blockquote><p>${inlineMarkdown(quoteLines.join(' '))}</p></blockquote>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      const items = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${inlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      output.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      const items = [];
      while (index < lines.length) {
        const item = lines[index].trim().match(/^\d+\.\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${inlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      output.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph();
  return output.join('\n');
}

function renderNav() {
  return sections.map((section) => `
    <li>
      <a class="nav-link${section.id === 'overview' ? ' is-active' : ''}" href="#${section.id}" data-nav-link="${section.id}"${section.id === 'overview' ? ' aria-current="page"' : ''}>
        <span class="nav-link__number">${section.number}</span>
        <span class="nav-link__label">${escapeHtml(section.navLabel)}</span>
        <span class="nav-link__marker" aria-hidden="true"></span>
      </a>
    </li>`).join('');
}

function renderSection(section, title, body, index) {
  const previous = sections[index - 1];
  const next = sections[index + 1];
  const previousLink = previous
    ? `<a class="section-nav__link section-nav__link--previous" href="#${previous.id}"><span class="section-nav__direction">Previous</span><span>${escapeHtml(previous.navLabel)}</span></a>`
    : '<span class="section-nav__empty" aria-hidden="true"></span>';
  const nextLink = next
    ? `<a class="section-nav__link section-nav__link--next" href="#${next.id}"><span class="section-nav__direction">Next</span><span>${escapeHtml(next.navLabel)}</span></a>`
    : '<span class="section-nav__empty" aria-hidden="true"></span>';

  return `
    <section class="handbook-section" id="${section.id}" data-section="${section.id}" data-title="${escapeHtml(title)}" data-index="${index}" tabindex="-1">
      <div class="section-heading">
        <div class="section-heading__meta"><span>${section.eyebrow}</span><span>${String(index + 1).padStart(2, '0')} / ${String(sections.length).padStart(2, '0')}</span></div>
        <h1>${inlineMarkdown(title)}</h1>
      </div>
      <div class="section-body">${body}</div>
      <nav class="section-nav" aria-label="Section navigation">
        ${previousLink}
        ${nextLink}
      </nav>
    </section>`;
}

async function build() {
  await mkdir(handbookDir, { recursive: true });
  const renderedSections = [];
  for (const [index, section] of sections.entries()) {
    const source = await readFile(path.join(handbookDir, section.key), 'utf8');
    renderedSections.push(renderSection(
      section,
      extractTitle(source),
      renderMarkdown(withoutTitle(source), section.id),
      index,
    ));
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#080b08">
    <meta name="description" content="The public, user-neutral Henry handbook: a verified path from laptop setup to safe extension.">
    <title>Henry Handbook — A field guide for building safely</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    <div class="app-shell">
      <header class="mobile-header">
        <a class="brand brand--mobile" href="#overview" aria-label="Henry Handbook home"><span class="brand__mark">H</span><span>HENRY / HANDBOOK</span></a>
        <button class="icon-button" id="menu-toggle" type="button" aria-controls="site-nav" aria-expanded="false" aria-label="Open handbook navigation">
          <span></span><span></span><span></span>
        </button>
      </header>

      <div class="drawer-backdrop" id="drawer-backdrop" hidden></div>
      <aside class="site-nav" id="site-nav" aria-label="Handbook navigation">
        <div class="site-nav__inner">
          <div class="site-nav__topline">
            <a class="brand" href="#overview" aria-label="Henry Handbook home"><span class="brand__mark">H</span><span>HENRY / HANDBOOK</span></a>
            <button class="icon-button icon-button--close" id="menu-close" type="button" aria-label="Close handbook navigation">×</button>
          </div>
          <p class="site-nav__intro">A field guide for turning a local checkout into a careful, capable agent.</p>
          <div class="nav-progress" aria-label="Reading progress">
            <div class="nav-progress__row"><span>READING PATH</span><span id="progress-label">01 / ${String(sections.length).padStart(2, '0')}</span></div>
            <div class="nav-progress__track"><span id="progress-fill"></span></div>
          </div>
          <nav class="site-nav__links" aria-label="Handbook sections">
            <ul>${renderNav()}</ul>
          </nav>
          <div class="site-nav__footer"><span class="status-dot" aria-hidden="true"></span><span>LOCAL-FIRST / VERIFIED</span></div>
        </div>
      </aside>

      <main class="content-main" id="main-content">
        <div class="content-toolbar">
          <div class="content-toolbar__crumb"><span class="status-dot" aria-hidden="true"></span><span>HENRY OPERATING HANDBOOK</span></div>
          <form class="search-form" role="search">
            <label class="sr-only" for="handbook-search">Search handbook</label>
            <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path d="m20 20-4.5-4.5m2-5.25a7.25 7.25 0 1 1-14.5 0 7.25 7.25 0 0 1 14.5 0Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            <input id="handbook-search" type="search" placeholder="Search the handbook" autocomplete="off" spellcheck="false">
            <kbd>/</kbd>
          </form>
        </div>
        <div class="search-results" id="search-results" hidden>
          <p class="search-results__summary" id="search-results-summary" aria-live="polite"></p>
          <div class="search-results__list" id="search-results-list"></div>
        </div>
        <div class="reading-column">
          ${renderedSections.join('\n')}
          <footer class="site-footer"><span>HENRY HANDBOOK</span><span>Generated ${generatedAt} from Markdown sources</span></footer>
        </div>
      </main>
    </div>
    <script src="app.js" defer></script>
  </body>
</html>
`;

  await writeFile(outputPath, html);
  process.stdout.write(`Built ${path.relative(rootDir, outputPath)} from ${sections.length} Markdown sources.\n`);
}

build().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
