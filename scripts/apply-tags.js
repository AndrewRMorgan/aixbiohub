#!/usr/bin/env node
/**
 * Apply reviewed tag suggestions to Airtable.
 *
 * Reads data/tag-suggestions.json (produced by scripts/suggest-tags.js) and
 * PATCHes the Tags field on the matching Research records.
 *
 * DRY RUN BY DEFAULT. Nothing is written until you pass --confirm.
 *
 * Three safety checks run before any write:
 *   1. Entries with "approved": false, or with an empty tags array, are skipped.
 *   2. The base schema is read and every tag is checked against the existing
 *      options on the Tags field. Airtable rejects an entire batch with
 *      INVALID_MULTIPLE_CHOICE_OPTIONS if one unknown option slips through, so
 *      this fails loudly and lists exactly what to add in the Airtable UI.
 *   3. Live records are re-read. Any record that has acquired tags since the
 *      suggestions were generated is skipped rather than overwritten — this is
 *      what stops a stale suggestions file from clobbering manual curation.
 *
 * Env:
 *   AIRTABLE_TOKEN     (required) PAT with data.records:read, data.records:write
 *                                 and schema.bases:read
 *   AIRTABLE_BASE_ID   (optional) defaults to the AIxBio base
 *
 * Flags:
 *   --confirm          actually write (otherwise: dry run)
 *   --skip-low         skip suggestions with confidence "low"
 *   --in PATH          read a different suggestions file
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');

const TOKEN = process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appAHRsnSatd4AJpf';
const TABLE = 'Research';
const FIELD = 'Tags';

// Airtable caps writes at 10 records per request and 5 requests/second per base.
const BATCH_SIZE = 10;
const PAGE_SIZE = 100;
const PACE_MS = 250;

/* ------------------------------------------------------------------ *
 * Airtable transport
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.airtable.com',
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 429) {
            return reject(Object.assign(new Error('rate limited'), { retryable: true }));
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              Object.assign(new Error(`Airtable ${res.statusCode}: ${data.slice(0, 400)}`), {
                status: res.statusCode,
              })
            );
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (err) {
            reject(new Error(`Could not parse Airtable response: ${err.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function requestWithRetry(method, urlPath, body, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await request(method, urlPath, body);
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

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * Existing options on the Tags field. Returns null when the token lacks
 * schema.bases:read — the run continues, but check 2 is downgraded to a warning
 * and a bad option will surface as a per-record write failure instead.
 */
async function fetchTagOptions() {
  try {
    const schema = await requestWithRetry('GET', `/v0/meta/bases/${BASE_ID}/tables`);
    const table = (schema.tables || []).find((t) => t.name === TABLE);
    if (!table) throw new Error(`table "${TABLE}" not found in the base schema`);

    const field = (table.fields || []).find((f) => f.name === FIELD);
    if (!field) throw new Error(`field "${FIELD}" not found on "${TABLE}"`);

    const choices = field.options && field.options.choices;
    if (!choices) return null;
    return new Set(choices.map((c) => c.name));
  } catch (err) {
    console.warn(`  ! could not read the base schema (${err.message})`);
    console.warn('    Skipping the unknown-option pre-check. Add schema.bases:read to the');
    console.warn('    token to enable it.\n');
    return null;
  }
}

/** Current Tags value for every Research record, keyed by record id. */
async function fetchCurrentTags() {
  const current = new Map();
  let offset;

  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    url.searchParams.append('fields[]', FIELD);
    if (offset) url.searchParams.set('offset', offset);

    const data = await requestWithRetry('GET', url.pathname + url.search);
    for (const record of data.records || []) {
      const value = (record.fields || {})[FIELD];
      current.set(record.id, Array.isArray(value) ? value : value ? [value] : []);
    }
    offset = data.offset;
    if (offset) await sleep(PACE_MS);
  } while (offset);

  return current;
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * PATCH in batches of 10. Airtable batches are all-or-nothing, so a rejected
 * batch is retried one record at a time — a single bad record then costs one
 * record instead of ten.
 */
async function writeBatches(records) {
  const stats = { succeeded: 0, failed: 0, errors: [] };
  const urlPath = `/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const label = `${i + 1}-${Math.min(i + BATCH_SIZE, records.length)}`;

    try {
      await requestWithRetry('PATCH', urlPath, { records: batch });
      stats.succeeded += batch.length;
      console.log(`  updated ${label}`);
    } catch (err) {
      console.error(`  batch ${label} rejected, retrying individually: ${err.message}`);
      for (const record of batch) {
        try {
          await requestWithRetry('PATCH', urlPath, { records: [record] });
          stats.succeeded += 1;
        } catch (recordErr) {
          stats.failed += 1;
          stats.errors.push(`${record.id}: ${recordErr.message}`);
          console.error(`    FAILED ${record.id} — ${recordErr.message}`);
        }
        await sleep(PACE_MS);
      }
    }

    await sleep(PACE_MS);
  }

  return stats;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { confirm: false, skipLow: false, in: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') opts.confirm = true;
    else if (arg === '--skip-low') opts.skipLow = true;
    else if (arg === '--in') opts.in = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!TOKEN) {
    console.error(
      'Missing AIRTABLE_TOKEN.\n' +
        '  Needs scopes: data.records:read, data.records:write, schema.bases:read'
    );
    process.exit(1);
  }

  const inFile = opts.in
    ? path.resolve(opts.in)
    : path.join(ROOT, 'data', 'tag-suggestions.json');

  if (!fs.existsSync(inFile)) {
    console.error(
      `No suggestions file at ${path.relative(ROOT, inFile)}.\n` +
        '  Run: node scripts/suggest-tags.js'
    );
    process.exit(1);
  }

  // Strip a UTF-8 BOM. The whole point of this file is that a human edits it,
  // and Notepad (plus PowerShell's Out-File) writes a BOM that JSON.parse rejects.
  const raw = fs.readFileSync(inFile, 'utf8').replace(/^﻿/, '');

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path.relative(ROOT, inFile)} is not valid JSON (${err.message}).\n` +
        '  If you edited it by hand, check for a trailing comma or an unquoted string.'
    );
  }

  const all = payload.suggestions || [];

  console.log(`Base:        ${BASE_ID}`);
  console.log(`Suggestions: ${path.relative(ROOT, inFile)} (${all.length}, generated ${payload.generatedAt})`);
  console.log(`Mode:        ${opts.confirm ? 'WRITE' : 'dry run'}\n`);

  /* -- Check 1: approval and content ------------------------------- */

  const skipped = { unapproved: 0, empty: 0, lowConfidence: 0, alreadyTagged: 0 };

  let selected = all.filter((s) => {
    if (s.approved === false) return skipped.unapproved++, false;
    if (!s.tags || !s.tags.length) return skipped.empty++, false;
    if (opts.skipLow && s.confidence === 'low') return skipped.lowConfidence++, false;
    return true;
  });

  /* -- Check 2: every tag must already exist as an option ---------- */

  console.log('Reading base schema...');
  const options = await fetchTagOptions();

  if (options) {
    const missing = new Set();
    selected.forEach((s) => s.tags.forEach((t) => options.has(t) || missing.add(t)));

    if (missing.size) {
      console.error(
        `\n${missing.size} tag(s) are not yet options on the "${FIELD}" field:\n` +
          [...missing].sort().map((t) => `  - ${t}`).join('\n') +
          '\n\nAirtable rejects unknown select options, so nothing has been written.' +
          '\nAdd them in the Airtable UI (Tags field > Customize field type > Add option),' +
          '\nor drop them from scripts/tag-vocabulary.json and re-run suggest-tags.js.'
      );
      process.exit(1);
    }
    console.log(`  ${options.size} existing options, all suggested tags valid\n`);
  }

  /* -- Check 3: don't overwrite tags added since generation -------- */

  console.log('Reading current record state...');
  const current = await fetchCurrentTags();

  selected = selected.filter((s) => {
    const existing = current.get(s.id);
    if (existing === undefined) {
      console.warn(`  ! ${s.id} no longer exists in the base — skipping`);
      return false;
    }
    if (existing.length) {
      skipped.alreadyTagged++;
      return false;
    }
    return true;
  });

  console.log(`  ${current.size} records read\n`);

  /* -- Report ------------------------------------------------------ */

  console.log('Skipped:');
  console.log(`  approved: false   ${skipped.unapproved}`);
  console.log(`  no tags suggested ${skipped.empty}`);
  if (opts.skipLow) console.log(`  low confidence    ${skipped.lowConfidence}`);
  console.log(`  already tagged    ${skipped.alreadyTagged}`);
  console.log(`\nTo write: ${selected.length} records\n`);

  if (!selected.length) {
    console.log('Nothing to do.');
    return;
  }

  selected.slice(0, 20).forEach((s) => {
    console.log(`  ${s.id}  ${s.tags.join(', ')}`);
    console.log(`             ${s.title.slice(0, 70)}`);
  });
  if (selected.length > 20) console.log(`  ... and ${selected.length - 20} more`);

  if (!opts.confirm) {
    console.log('\nDry run — nothing written. Re-run with --confirm to apply.');
    return;
  }

  /* -- Write ------------------------------------------------------- */

  console.log('\nWriting to Airtable...');
  const records = selected.map((s) => ({ id: s.id, fields: { [FIELD]: s.tags } }));
  const stats = await writeBatches(records);

  console.log(`\nUpdated ${stats.succeeded}, failed ${stats.failed}.`);
  if (stats.failed) {
    console.log('\nFailures:');
    stats.errors.forEach((e) => console.log(`  ${e}`));
    process.exitCode = 1;
  }

  console.log(
    '\nNext: `node scripts/fetch-airtable.js` to refresh data/library.json, then commit.'
  );
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
