#!/usr/bin/env node
/**
 * Fetch every record from the AIxBio Airtable base into data/library.json.
 *
 * This is the ONLY place Airtable is ever contacted. It runs in CI (and
 * locally), never in a visitor's browser. The build step reads the committed
 * JSON, so the published site makes zero Airtable requests.
 *
 * The output is written deterministically — sorted object keys, stable record
 * order, no timestamps — so that `git diff` on data/library.json shows real
 * content changes and nothing else. Anything time-varying in here would make
 * the file differ on every run and defeat the commit-only-if-changed check.
 *
 * Env:
 *   AIRTABLE_TOKEN    (required) personal access token, data.records:read
 *   AIRTABLE_BASE_ID  (optional) defaults to the AIxBio base
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appAHRsnSatd4AJpf';
const OUT_FILE = path.join(__dirname, '..', 'data', 'library.json');

// Airtable caps a page at 100 records and returns an `offset` cursor whenever
// more remain. PAGE_SIZE is the max; the loop below is what actually matters.
const PAGE_SIZE = 100;

if (!TOKEN) {
  console.error(
    'Missing AIRTABLE_TOKEN.\n' +
      '  CI:    add it under Settings > Secrets and variables > Actions.\n' +
      '  Local: set it in your shell before running this script.'
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Airtable transport
 * ------------------------------------------------------------------ */

function request(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 429) {
            return reject(Object.assign(new Error('rate limited'), { retryable: true }));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Never echo the response verbatim without trimming — keep the
            // failure readable in CI logs.
            return reject(
              new Error(`Airtable ${res.statusCode}: ${body.slice(0, 400)}`)
            );
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Could not parse Airtable response: ${err.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestWithRetry(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await request(url);
    } catch (err) {
      lastErr = err;
      if (!err.retryable) throw err;
      const wait = 2000 * (i + 1);
      console.warn(`  rate limited, retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * Walk every page of a table via the offset cursor.
 *
 * Airtable returns at most 100 records per response plus an `offset` token when
 * more exist. Stopping after the first response — the classic bug — would
 * silently truncate the Research table to its first 100 rows.
 */
async function fetchTable(table) {
  const records = [];
  let offset;
  let page = 0;

  do {
    const url = new URL(
      `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}`
    );
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (offset) url.searchParams.set('offset', offset);

    const data = await requestWithRetry(url.toString());
    records.push(...(data.records || []));
    offset = data.offset;
    page++;
    console.log(`  ${table}: page ${page} (+${(data.records || []).length}, total ${records.length})`);

    // Airtable's documented limit is 5 requests/second per base. One small
    // pause per page keeps us comfortably under it without slowing the job.
    if (offset) await sleep(220);
  } while (offset);

  return records;
}

/* ------------------------------------------------------------------ *
 * Field mapping — raw Airtable field bags into a clean, stable shape
 * ------------------------------------------------------------------ */

/** Airtable omits empty fields entirely, so every read is defensive. */
function text(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
  return String(value).replace(/\s+$/, '').trim();
}

/** multipleSelects come back as arrays; normalise to a trimmed string array. */
function list(value) {
  if (!Array.isArray(value)) {
    const single = text(value);
    return single ? [single] : [];
  }
  return value.map((v) => text(v)).filter(Boolean);
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapResearch(record) {
  const f = record.fields || {};

  // Institution is a multipleSelects field, and some institution names contain
  // commas ("National Academies of Sciences, Engineering, and Medicine"). The
  // array is what the page filters on; `institution` is only ever displayed.
  const institutions = list(f.Institution);

  return {
    abstract: text(f.Abstract),
    creators: text(f.Creators),
    date: text(f.Date),
    doi: text(f.DOI),
    id: record.id,
    institution: institutions.join(', '),
    institutions,
    publication: text(f.Publication),
    publicationDate: text(f['Publication Date']),
    tags: list(f.Tags).sort(),
    title: text(f.Title),
    type: text(f['Item Type']),
    url: text(f.URL),
    year: text(f.Year),
  };
}

function mapDirectory(record) {
  const f = record.fields || {};
  return {
    description: text(f.Description),
    id: record.id,
    link: text(f.Link),
    name: text(f.Name),
    number: number(f.Number),
  };
}

/* ------------------------------------------------------------------ *
 * Deterministic serialisation
 * ------------------------------------------------------------------ */

/** Recursively sort object keys so JSON.stringify emits a canonical form. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = sortKeys(value[key]);
        return out;
      }, {});
  }
  return value;
}

/** Sort by the given key, then by record id, so ties never reorder. */
function stableBy(items, key) {
  return items.slice().sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return av < bv ? -1 : 1;
  });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  console.log(`Fetching from Airtable base ${BASE_ID}`);

  // Sequential rather than parallel: three tables against one base would
  // otherwise interleave and push us into Airtable's per-base rate limit.
  const researchRaw = await fetchTable('Research');
  const newslettersRaw = await fetchTable('Newsletters');
  const organisationsRaw = await fetchTable('Organisations');

  // Drop blank rows — Airtable keeps trailing empty records in most tables.
  const research = stableBy(
    researchRaw.map(mapResearch).filter((r) => r.title),
    'id'
  );
  const newsletters = stableBy(
    newslettersRaw.map(mapDirectory).filter((r) => r.name),
    'number'
  );
  const organisations = stableBy(
    organisationsRaw.map(mapDirectory).filter((r) => r.name),
    'number'
  );

  // A zero-record read means a revoked token, a renamed table or a bad base ID
  // far more often than it means someone emptied the base. Fail instead of
  // committing an empty file and publishing an empty site.
  if (!research.length) {
    throw new Error(
      'Airtable returned 0 usable Research records. Refusing to overwrite ' +
        'data/library.json. Check the token scopes, the base ID and the table name.'
    );
  }

  const payload = sortKeys({ newsletters, organisations, research });
  const json = JSON.stringify(payload, null, 2) + '\n';

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  // Compare with line endings normalised. .gitattributes pins this file to LF,
  // but a working copy that predates that (or a stray editor save) shouldn't
  // masquerade as a data change.
  const previous = fs.existsSync(OUT_FILE)
    ? fs.readFileSync(OUT_FILE, 'utf8').replace(/\r\n/g, '\n')
    : null;
  if (previous === json) {
    console.log(
      `\nNo change: ${research.length} research, ${newsletters.length} newsletters, ` +
        `${organisations.length} organisations. Leaving data/library.json untouched.`
    );
    return;
  }

  fs.writeFileSync(OUT_FILE, json, 'utf8');
  console.log(
    `\nWrote data/library.json: ${research.length} research, ${newsletters.length} newsletters, ` +
      `${organisations.length} organisations.`
  );
}

main().catch((err) => {
  console.error(`\nFetch failed: ${err.message}`);
  process.exit(1);
});
