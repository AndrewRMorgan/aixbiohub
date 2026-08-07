# AIxBio Research Hub

The static site behind **aixbiohub.com**, published on GitHub Pages.

Four pages, no runtime backend:

| URL | Page | Content source |
|---|---|---|
| `/` | Landing | Hand-authored (`src/pages/index.html`) |
| `/research/` | Research Database | Airtable → `data/library.json` |
| `/newsletters/` | Organisations & Newsletters | Airtable → `data/library.json` |
| `/suggestedresources/` | Recommended Resources | Hand-authored (`src/pages/suggestedresources.html`) |

These paths deliberately match the old Softr URLs so existing links keep working.

**The published site makes zero Airtable requests.** Airtable is contacted only by
`scripts/fetch-airtable.js`, which runs in GitHub Actions. Visitors get static HTML
plus a baked-in `research-data.js`; all searching and filtering happens in their browser.

---

## How it works

```
Airtable  ──(daily cron)──►  fetch-airtable.yml
                                    │  scripts/fetch-airtable.js
                                    ▼
                             data/library.json
                                    │  committed ONLY if the content changed
                                    ▼
                              push to main
                                    │
                                    ▼
                             deploy-pages.yml
                                    │  scripts/build.js
                                    ▼
                                  dist/  ──►  GitHub Pages
```

Two separate workflows, on purpose:

- **[`fetch-airtable.yml`](.github/workflows/fetch-airtable.yml)** — daily cron. Fetches every
  record (following Airtable's `offset` cursor, so nothing is truncated at 100), writes
  `data/library.json`, and commits it **only if `git diff` shows a real change**. No empty commits.
- **[`deploy-pages.yml`](.github/workflows/deploy-pages.yml)** — runs on push to `main`. Builds
  `dist/` and deploys. Because the fetch job's commit *is* a push, a data change is what
  triggers the redeploy — there is no independent build timer.

`data/library.json` is written deterministically (sorted keys, stable record order, no
timestamps) so a diff on that file only ever reflects genuine content changes.

---

## One-time setup

### 1. Add the secret

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `AIRTABLE_TOKEN` | An Airtable personal access token with the `data.records:read` scope and access to base `appAHRsnSatd4AJpf` |

That's the only secret the website pipeline needs. (The separate Zotero sync uses its own
secrets — see [docs/zotero-airtable-sync.md](docs/zotero-airtable-sync.md).)

The base ID is hardcoded as a default in the script; override it with an optional
`AIRTABLE_BASE_ID` secret if it ever changes.

### 2. Turn on GitHub Pages

**Settings → Pages → Build and deployment → Source: `GitHub Actions`**

That is the *entire* dashboard configuration. Do **not** pick "Deploy from a branch" —
there is no build command or output directory to fill in, because the workflow builds the
site itself and uploads `dist/` as a Pages artifact.

### 3. Point the domain (optional)

The site currently publishes at **<https://andrewrmorgan.github.io/aixbiohub/>**, a project
Pages URL served from the `/aixbiohub` sub-path. `basePath` in `src/site.config.json` carries
that prefix into every link and asset URL. Get it wrong and the pages render as unstyled HTML,
because `/assets/site.css` resolves against the wrong origin.

To go live on `aixbiohub.com`, set these DNS records at your registrar:

| Type | Name | Value |
|---|---|---|
| `A` | `@` | `185.199.108.153` |
| `A` | `@` | `185.199.109.153` |
| `A` | `@` | `185.199.110.153` |
| `A` | `@` | `185.199.111.153` |
| `CNAME` | `www` | `andrewrmorgan.github.io` |

Wait for DNS to propagate, then **Settings → Pages → Custom domain**, enter `aixbiohub.com`,
and tick **Enforce HTTPS** once the certificate is issued (usually within an hour).

Only then set `"customDomain": "aixbiohub.com"` in `src/site.config.json`. That is the whole
cutover — a custom domain serves from the root, so the build ignores `basePath` and emits
root-relative URLs automatically. Don't set both by hand.

Setting `customDomain` before the DNS records resolve does nothing useful: GitHub silently
ignores a `CNAME` file it can't verify, and the site keeps serving from the sub-path with
root-relative links that 404.

### 4. Wire up the "Suggest research" panel

`suggestFormUrl` in `src/site.config.json` is `null`, so the panel is currently **omitted from
the landing page** — a dead button is worse than no button. To enable it:

1. In Airtable, create a form view on the **User submitted** table and copy its share URL.
2. Paste it into `src/site.config.json` as `"suggestFormUrl"`.
3. Commit. The panel appears on the next deploy.

---

## Running it locally

Requires [Node.js](https://nodejs.org) 18 or newer. No `npm install` — the pipeline has zero
dependencies, and Fuse.js is vendored at `src/assets/vendor/fuse.min.js`.

**Build the site from the data already in the repo:**

```bash
node scripts/build.js
```

**Preview it** (opening the files directly gives broken navigation — the pages use absolute
URLs). The server mounts `dist/` under the same `basePath` production uses, so a wrong base
path shows up locally instead of after deploying:

```bash
node scripts/serve.js
```

It prints the URL to open, currently <http://localhost:4173/aixbiohub/>.

**Refresh the data from Airtable first** (optional — only needed if you want the very latest):

```bash
AIRTABLE_TOKEN=pat... node scripts/fetch-airtable.js
```

On PowerShell:

```bash
$env:AIRTABLE_TOKEN="pat..."; node scripts/fetch-airtable.js
```

The fetch script leaves `data/library.json` untouched when the content is identical, so you can
run it freely without creating spurious diffs.

---

## Changing the schedule

Edit the `cron` line in [`.github/workflows/fetch-airtable.yml`](.github/workflows/fetch-airtable.yml):

```yaml
schedule:
  - cron: '15 5 * * *'      # daily at 05:15 UTC  (current)
  - cron: '15 5 * * 1'      # weekly, Mondays
  - cron: '15 5,17 * * *'   # twice daily
  - cron: '15 */6 * * *'    # every 6 hours
```

Times are UTC and GitHub does not adjust for BST. Keep the minute off `:00` — scheduled runs
that land on the hour are the most likely to be delayed. You can also trigger a fetch any time
from **Actions → Fetch Airtable data → Run workflow**.

---

## Repository layout

```
data/library.json          Committed Airtable snapshot. Generated — don't hand-edit.
scripts/fetch-airtable.js  Airtable → data/library.json (pagination, deterministic output)
scripts/build.js           data/library.json + src/ → dist/
scripts/serve.js           Local preview server for dist/
src/site.config.json       Domain, Litmaps URL, suggest-form URL
src/layout.html            Shared shell: head, header, nav, footer
src/pages/*.html           Per-page body content
src/assets/site.css        All styling for all four pages
src/assets/research.js     Search, faceting and sorting for the database page
src/assets/vendor/         Fuse.js 7.0.0 (vendored, not fetched from a CDN)
dist/                      Build output. Gitignored.
```

### Restyling

Everything visual is in `src/assets/site.css`. The design tokens at the top of that file
(`--ink`, `--paper`, `--acc`, …) drive the whole palette; the rest of the file is grouped by
page with comments. The generated markup uses stable, readable class names — the card template
in `scripts/build.js` (`researchCard`) and the one in `src/assets/research.js` (`card`)
produce identical HTML, so if you change one, change the other to match.

### Why the research page renders twice

The database page ships server-rendered cards *and* the full dataset. The pre-rendered cards
mean content is visible immediately and the page still works with JavaScript disabled or for a
crawler; `research-data.js` is what makes client-side search and faceting possible. Sorting is
"Best match" while there's a search query and newest-first otherwise.

At 247 records that costs about 193 KB gzipped for the page, roughly half of it the
pre-rendered half. If the library grows to the point where that hurts, set
`"prerenderResults": false` in `src/site.config.json` — the page then renders entirely in the
browser and drops to about 100 KB, at the cost of the no-JS fallback and crawlable abstracts.

---

## Other pipelines in this repo

[**Zotero → Airtable sync**](docs/zotero-airtable-sync.md) — `sync-zotero-to-airtable.js` and
`.github/workflows/sync.yml` keep the Airtable **Research** table populated from Zotero. That
runs upstream of everything above and is documented separately.
