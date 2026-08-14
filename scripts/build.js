#!/usr/bin/env node
/**
 * Build the static site into dist/.
 *
 * Reads data/library.json (committed by the fetch job) plus the templates in
 * src/, and writes plain HTML. Airtable is never contacted here, and the
 * published pages never contact it either — the research records are baked
 * into dist/assets/research-data.js at build time.
 *
 * Output paths deliberately mirror the old Softr URLs:
 *   /                     landing
 *   /research/            research database
 *   /newsletters/         organisations & newsletters
 *   /suggestedresources/  recommended resources
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const config = readJSON(path.join(SRC, 'site.config.json'));
const library = readJSON(path.join(ROOT, 'data', 'library.json'));

const research = library.research || [];
const newsletters = library.newsletters || [];
const organisations = library.organisations || [];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function readJSON(file) {
  if (!fs.existsSync(file)) {
    console.error(
      `Missing ${path.relative(ROOT, file)}.\n` +
        'Run `node scripts/fetch-airtable.js` first (needs AIRTABLE_TOKEN).'
    );
    process.exit(1);
  }
  // Strip a UTF-8 BOM. Several Windows editors add one on save, and JSON.parse
  // rejects it with an error that points nowhere near the real cause.
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${path.relative(ROOT, file)} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Substitute {{KEY}} placeholders. Uses a replacer function so that `$&`,
 * `$1` and friends inside record text are never interpreted as replacement
 * patterns. Loops because a substituted value can itself contain a
 * placeholder (the landing page's suggest panel introduces one).
 */
function template(text, vars) {
  let out = text;
  for (let pass = 0; pass < 4; pass++) {
    let hit = false;
    out = out.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
      if (!(key in vars)) return match;
      hit = true;
      return String(vars[key]);
    });
    if (!hit) break;
  }
  return out;
}

function write(relPath, contents) {
  const file = path.join(DIST, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
  const kb = (Buffer.byteLength(contents, 'utf8') / 1024).toFixed(1);
  console.log(`  ${relPath.padEnd(34)} ${kb.padStart(8)} KB`);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

/* ------------------------------------------------------------------ *
 * Page rendering
 * ------------------------------------------------------------------ */

const layout = fs.readFileSync(path.join(SRC, 'layout.html'), 'utf8');

/**
 * Sub-path the site is served from, normalised to either '' or '/foo'.
 *
 * A GitHub Pages project site lives at https://<user>.github.io/<repo>/, so
 * every root-absolute URL needs that prefix or it resolves against the wrong
 * origin and 404s. A custom domain serves from the root, so the prefix must be
 * empty there — which is why customDomain wins outright rather than being
 * combined with basePath.
 */
function normaliseBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.startsWith('/') ? raw : '/' + raw;
}

const BASE = config.customDomain
  ? ''
  : normaliseBase(process.env.BASE_PATH || config.basePath);

/**
 * The Google Analytics (gtag.js) snippet, or '' when no ID is configured.
 *
 * The measurement ID is public by design — it ships in the page source — so it
 * lives in site.config.json rather than in a secret. The ID is validated
 * because it is interpolated into both a URL and a JS string literal, and a
 * malformed value would break every page on the site rather than just itself.
 */
function analyticsSnippet(id) {
  if (!id) return '';
  if (!/^G-[A-Z0-9]+$/i.test(id)) {
    console.error(
      `googleAnalyticsId "${id}" in src/site.config.json is not a GA4 measurement ID ` +
        '(expected the form G-XXXXXXXXXX).'
    );
    process.exit(1);
  }
  return (
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n` +
    `<script>\n` +
    `window.dataLayer = window.dataLayer || [];\n` +
    `function gtag(){dataLayer.push(arguments);}\n` +
    `gtag('js', new Date());\n` +
    `gtag('config', '${id}');\n` +
    `</script>\n`
  );
}

const GLOBALS = {
  SITE_NAME: esc(config.siteName),
  DOMAIN: esc(config.domain),
  LITMAPS_URL: esc(config.litmapsUrl),
  YEAR: String(new Date().getFullYear()),
  BASE: BASE,
  ANALYTICS: analyticsSnippet(config.googleAnalyticsId),
};

function renderPage({ out, body, title, description, active, bodyClass, wrapClass, scripts, vars }) {
  const pageBody = fs.readFileSync(path.join(SRC, 'pages', body), 'utf8');

  const html = template(layout, {
    ...GLOBALS,
    ...(vars || {}),
    TITLE: esc(title),
    DESCRIPTION: esc(description),
    BODY: pageBody,
    BODY_CLASS: bodyClass ? ` class="${bodyClass}"` : '',
    WRAP_CLASS: wrapClass ? ` ${wrapClass}` : '',
    SCRIPTS: scripts || '',
    NAV_RESEARCH: active === 'research' ? ' class="active"' : '',
    NAV_RESOURCES: active === 'resources' ? ' class="active"' : '',
    NAV_NEWSLETTERS: active === 'newsletters' ? ' class="active"' : '',
  });

  write(out, html);
}

/* --- Directory cards (rendered at build time, no client JS needed) ------- */

function orgCard(item) {
  const link = item.link
    ? `\n        <a class="visit" href="${esc(item.link)}" target="_blank" rel="noopener">Visit ` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
      `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      `<path d="M7 17L17 7M8 7h9v9"/></svg></a>`
    : '';
  return (
    `      <div class="org-card">\n` +
    `        <h3>${esc(item.name)}</h3>\n` +
    `        <p>${esc(item.description)}</p>${link}\n` +
    `      </div>`
  );
}

/* --- Research cards (server-rendered so the page works without JS) ------- */

function researchCard(d) {
  const link = d.url || (d.doi ? `https://doi.org/${d.doi}` : '');
  const meta = [d.creators, d.publication, d.date].filter(Boolean);
  const title = esc(d.title);

  const tags = (d.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const inst = d.institution ? `<span class="tag">${esc(d.institution)}</span>` : '';

  return (
    `<article class="card">` +
    `<div class="card-top">` +
    `<div class="card-title">` +
    (link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${title}</a>` : title) +
    `</div>` +
    (d.type ? `<span class="type-badge">${esc(d.type)}</span>` : '') +
    `</div>` +
    (meta.length
      ? `<div class="card-meta">${meta.map(esc).join(' <span class="sep">&middot;</span> ')}</div>`
      : '') +
    (d.abstract
      ? `<div class="abstract">${esc(d.abstract)}</div>` +
        `<button type="button" class="abstract-toggle" aria-expanded="false">Read abstract</button>`
      : '') +
    `<div class="card-bottom">` +
    `<div class="tag-list">${tags}${inst}</div>` +
    (link
      ? `<a class="card-link" href="${esc(link)}" target="_blank" rel="noopener">View ` +
        `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
        `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
        `<path d="M7 17L17 7M8 7h9v9"/></svg></a>`
      : '') +
    `</div>` +
    `</article>`
  );
}

function dateVal(d) {
  const t = Date.parse(d.publicationDate || d.date);
  if (!isNaN(t)) return t;
  const y = parseInt(d.year, 10);
  return y ? Date.UTC(y, 0, 1) : 0;
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

console.log(
  `Building from data/library.json: ${research.length} research, ` +
    `${newsletters.length} newsletters, ${organisations.length} organisations\n`
);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// Static assets, including the vendored Fuse.js build.
copyDir(path.join(SRC, 'assets'), path.join(DIST, 'assets'));
console.log('  assets/                            (copied)');

// The research records, baked in. Loaded with a plain <script src>, so there
// is no fetch() and nothing to go wrong if the page is opened from disk.
write(
  'assets/research-data.js',
  'window.RESEARCH_DATA = ' + JSON.stringify(research) + ';\n'
);

// Landing page. The suggest panel only appears once a form URL is configured —
// a dead button is worse than no button.
const suggestPanel = config.suggestFormUrl
  ? `  <section class="suggest">\n` +
    `    <div>\n` +
    `      <h3>Suggest research to add</h3>\n` +
    `      <p>Know a paper, report, or preprint we're missing? Send it our way and we'll review it for the database.</p>\n` +
    `    </div>\n` +
    `    <a class="btn" href="${esc(config.suggestFormUrl)}" target="_blank" rel="noopener">Submit a suggestion</a>\n` +
    `  </section>`
  : '';

if (!config.suggestFormUrl) {
  console.log('\n  NOTE: suggestFormUrl is not set in src/site.config.json —');
  console.log('        the "Suggest research to add" panel is omitted.\n');
}

renderPage({
  out: 'index.html',
  body: 'index.html',
  title: 'AIxBio Research Hub',
  description:
    'A platform for researchers, professionals, and policymakers tracking research on the ' +
    'implications and risks at the intersection of artificial intelligence and biology.',
  bodyClass: 'landing',
  wrapClass: 'narrow',
  vars: { SUGGEST_PANEL: suggestPanel },
});

renderPage({
  out: 'research/index.html',
  body: 'research.html',
  title: 'Research Database — AIxBio Research Hub',
  description:
    `A searchable catalogue of ${research.length} papers, reports, and preprints on the risks ` +
    'and implications at the intersection of AI and biology.',
  active: 'research',
  scripts:
    `<script src="${BASE}/assets/vendor/fuse.min.js"></script>\n` +
    `<script src="${BASE}/assets/research-data.js"></script>\n` +
    `<script src="${BASE}/assets/research.js"></script>`,
  vars: {
    RESEARCH_COUNT: String(research.length),
    // Rendered newest-first to match the page's default ordering, so the
    // markup the crawler (or a no-JS visitor) sees matches what JS produces.
    RESEARCH_FALLBACK:
      config.prerenderResults === false
        ? ''
        : research
            .slice()
            .sort((a, b) => dateVal(b) - dateVal(a))
            .map(researchCard)
            .join(''),
  },
});

renderPage({
  out: 'newsletters/index.html',
  body: 'newsletters.html',
  title: 'Organisations & Newsletters — AIxBio Research Hub',
  description:
    'The labs, institutes, and funders shaping the AI x biology conversation — and the ' +
    'newsletters worth your inbox.',
  active: 'newsletters',
  vars: {
    NEWSLETTER_CARDS: newsletters.map(orgCard).join('\n'),
    ORGANISATION_CARDS: organisations.map(orgCard).join('\n'),
  },
});

renderPage({
  out: 'suggestedresources/index.html',
  body: 'suggestedresources.html',
  title: 'Recommended Resources — AIxBio Research Hub',
  description:
    'Hand-picked primers, explainers, and key readings for people new to the AIxBio field.',
  active: 'resources',
  wrapClass: 'reading',
});

// GitHub Pages serves this for any unmatched path.
renderPage({
  out: '404.html',
  body: '404.html',
  title: 'Page not found — AIxBio Research Hub',
  description: 'That page could not be found.',
  wrapClass: 'reading',
});

/* --- Host files ---------------------------------------------------------- */

// Tells GitHub Pages to serve the output as-is rather than running it through
// Jekyll (which would drop any file or directory beginning with an underscore).
write('.nojekyll', '');

if (config.customDomain) {
  write('CNAME', config.customDomain + '\n');
}

// On a custom domain the origin is that domain. Otherwise fall back to the
// default Pages origin, which CI can tell us from GITHUB_REPOSITORY, so the
// sitemap still points somewhere real before the domain is cut over.
const owner = (process.env.GITHUB_REPOSITORY || '').split('/')[0].toLowerCase();
const origin = config.customDomain
  ? `https://${config.customDomain}`
  : owner
    ? `https://${owner}.github.io`
    : '';

if (origin) {
  const paths = ['/', '/research/', '/newsletters/', '/suggestedresources/'].map(
    (p) => BASE + p
  );
  write(
    'sitemap.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n') +
      '\n</urlset>\n'
  );
  write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${origin}${BASE}/sitemap.xml\n`);
}

console.log(
  `\nBuild complete → dist/  (serving from ${origin || '(unknown origin)'}${BASE || '/'})`
);
