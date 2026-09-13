(() => {
  const sections = [...document.querySelectorAll('[data-section]')];
  const navLinks = [...document.querySelectorAll('[data-nav-link]')];
  const searchInput = document.querySelector('#handbook-search');
  const searchResults = document.querySelector('#search-results');
  const searchResultsSummary = document.querySelector('#search-results-summary');
  const searchResultsList = document.querySelector('#search-results-list');
  const progressLabel = document.querySelector('#progress-label');
  const progressFill = document.querySelector('#progress-fill');
  const menuToggle = document.querySelector('#menu-toggle');
  const menuClose = document.querySelector('#menu-close');
  const siteNav = document.querySelector('#site-nav');
  const drawerBackdrop = document.querySelector('#drawer-backdrop');
  const totalSections = sections.length;

  const escapeHtml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  function setActiveSection(sectionId) {
    const activeSection = document.querySelector(`[data-section="${sectionId}"]`);
    if (!activeSection) return;
    const index = Number(activeSection.dataset.index || 0);
    navLinks.forEach((link) => {
      const isActive = link.dataset.navLink === sectionId;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (progressLabel) progressLabel.textContent = `${String(index + 1).padStart(2, '0')} / ${String(totalSections).padStart(2, '0')}`;
    if (progressFill) progressFill.style.width = `${((index + 1) / totalSections) * 100}%`;
  }

  function closeDrawer() {
    siteNav?.setAttribute('data-open', 'false');
    menuToggle?.setAttribute('aria-expanded', 'false');
    if (drawerBackdrop) drawerBackdrop.hidden = true;
    document.body.classList.remove('drawer-open');
  }

  function openDrawer() {
    siteNav?.setAttribute('data-open', 'true');
    menuToggle?.setAttribute('aria-expanded', 'true');
    if (drawerBackdrop) drawerBackdrop.hidden = false;
    document.body.classList.add('drawer-open');
    siteNav?.querySelector('[data-nav-link]')?.focus();
  }

  function snippetFor(section, query) {
    const text = section.textContent.replace(/\s+/g, ' ').trim();
    const start = Math.max(0, text.toLowerCase().indexOf(query.toLowerCase()) - 48);
    const snippet = text.slice(start, start + 140);
    return `${start > 0 ? '…' : ''}${snippet}${start + 140 < text.length ? '…' : ''}`;
  }

  function clearSearch() {
    if (!searchInput?.value) return;
    searchInput.value = '';
    filterSections('');
  }

  function filterSections(rawQuery) {
    const query = rawQuery.trim().toLowerCase();
    if (!query) {
      sections.forEach((section) => { section.hidden = false; });
      navLinks.forEach((link) => { link.hidden = false; });
      if (searchResults) searchResults.hidden = true;
      return;
    }

    const matches = sections.filter((section) => {
      const searchable = `${section.dataset.title} ${section.textContent}`.toLowerCase();
      return searchable.includes(query);
    });
    const matchIds = new Set(matches.map((section) => section.dataset.section));
    sections.forEach((section) => { section.hidden = !matchIds.has(section.dataset.section); });
    navLinks.forEach((link) => { link.hidden = !matchIds.has(link.dataset.navLink); });
    if (searchResults) searchResults.hidden = false;
    if (searchResultsSummary) searchResultsSummary.textContent = `${matches.length} section${matches.length === 1 ? '' : 's'} found`;
    if (searchResultsList) {
      searchResultsList.innerHTML = matches.length
        ? matches.map((section) => `<a class="search-result" href="#${section.dataset.section}" data-search-result="${section.dataset.section}"><span class="search-result__title">${escapeHtml(section.dataset.title)}</span><span class="search-result__snippet">${escapeHtml(snippetFor(section, query))}</span></a>`).join('')
        : '<p class="search-results__summary">No matching sections. Try a broader term.</p>';
    }
  }

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const code = button.closest('.code-frame')?.querySelector('code')?.textContent || '';
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        const helper = document.createElement('textarea');
        helper.value = code;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.append(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      const originalLabel = button.textContent;
      button.textContent = 'Copied';
      window.setTimeout(() => { button.textContent = originalLabel; }, 1400);
    });
  });

  searchInput?.addEventListener('input', (event) => filterSections(event.target.value));
  searchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      clearSearch();
      searchInput.blur();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== searchInput && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      searchInput?.focus();
    }
    if (event.key === 'Escape' && siteNav?.dataset.open === 'true') closeDrawer();
  });
  searchResultsList?.addEventListener('click', (event) => {
    if (event.target.closest('[data-search-result]')) clearSearch();
  });
  navLinks.forEach((link) => link.addEventListener('click', closeDrawer));
  menuToggle?.addEventListener('click', openDrawer);
  menuClose?.addEventListener('click', closeDrawer);
  drawerBackdrop?.addEventListener('click', closeDrawer);

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActiveSection(visible[0].target.dataset.section);
    }, { rootMargin: '-18% 0px -68% 0px', threshold: [0, 0.1, 0.5] });
    sections.forEach((section) => observer.observe(section));
  }

  setActiveSection(sections[0]?.dataset.section || 'overview');
})();
