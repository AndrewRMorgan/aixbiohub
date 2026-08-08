#!/usr/bin/env node
/**
 * Suggest Tags values for Research records that don't have any.
 *
 * Reads the committed snapshot in data/library.json, asks Claude Haiku 4.5 to
 * pick tags from the controlled vocabulary in scripts/tag-vocabulary.json, and
 * writes the result to data/tag-suggestions.json for review.
 *
 * THIS SCRIPT NEVER WRITES TO AIRTABLE. Review the output, edit it, then run
 * scripts/apply-tags.js to push the approved rows.
 *
 * The vocabulary is enforced structurally, not by asking nicely: every allowed
 * tag is compiled into a JSON Schema `enum` and passed as a structured output
 * format, so the API rejects an invented tag before we ever see it. That is the
 * whole reason for using structured outputs here rather than parsing prose.
 *
 * Env:
 *   ANTHROPIC_API_KEY  (required)
 *   TAG_MODEL          (optional) defaults to claude-haiku-4-5
 *   TAG_CONCURRENCY    (optional) parallel requests, defaults to 4
 *
 * Flags:
 *   --limit N          only process the first N untagged records (for a cheap trial run)
 *   --id recXXXX       only process this record; repeatable
 *   --include-untitled process records with no abstract too (default: they are
 *                      still processed, but see --require-abstract)
 *   --require-abstract skip records with no abstract instead of guessing from the title
 *   --out PATH         override the output path
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const ROOT = path.join(__dirname, '..');
const VOCAB_FILE = path.join(__dirname, 'tag-vocabulary.json');
const LIBRARY_FILE = path.join(ROOT, 'data', 'library.json');

const MODEL = process.env.TAG_MODEL || 'claude-haiku-4-5';
const CONCURRENCY = Number(process.env.TAG_CONCURRENCY) || 4;

// Haiku 4.5 is $1/$5 per million tokens. Used for the cost estimate printed at
// the end; update alongside TAG_MODEL if you switch models.
const PRICE_IN_PER_MTOK = 1.0;
const PRICE_OUT_PER_MTOK = 5.0;

// Abstracts in this base top out around 3k characters. The cap is a guard
// against a pathological record, not a routine truncation.
const MAX_ABSTRACT_CHARS = 6000;

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { limit: Infinity, ids: [], requireAbstract: false, out: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') opts.limit = Number(argv[++i]);
    else if (arg === '--id') opts.ids.push(argv[++i]);
    else if (arg === '--require-abstract') opts.requireAbstract = true;
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(opts.limit) && opts.limit !== Infinity) {
    throw new Error('--limit needs a number');
  }
  return opts;
}

/* ------------------------------------------------------------------ *
 * Vocabulary → prompt + schema
 * ------------------------------------------------------------------ */

function loadVocabulary() {
  const vocab = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
  const facets = vocab.facets || [];

  const allTags = [];
  const seen = new Set();
  for (const facet of facets) {
    for (const tag of facet.tags) {
      // A duplicate name across facets would make the per-facet caps
      // unenforceable and silently double-count in the review output.
      if (seen.has(tag.name)) {
        throw new Error(`Duplicate tag "${tag.name}" in tag-vocabulary.json`);
      }
      seen.add(tag.name);
      allTags.push({ ...tag, facet: facet.name });
    }
  }

  return { facets, allTags, names: allTags.map((t) => t.name) };
}

/** Render the vocabulary as the reference block the model picks from. */
function renderVocabulary(facets) {
  return facets
    .map((facet) => {
      const header =
        `## ${facet.name} (choose at most ${facet.maxPerRecord})\n` +
        `${facet.guidance}\n`;
      const lines = facet.tags
        .map((t) => `- ${t.name}: ${t.description}`)
        .join('\n');
      return `${header}\n${lines}`;
    })
    .join('\n\n');
}

/**
 * Structured output schema. The `enum` on tags[] is the enforcement mechanism —
 * with it the model physically cannot return a tag outside the vocabulary.
 *
 * Note that array length caps (maxItems) are NOT supported by structured
 * outputs, so the per-facet limits live in the prompt and are re-checked
 * client-side in validateSuggestion().
 */
function buildSchema(names) {
  return {
    type: 'object',
    properties: {
      tags: {
        type: 'array',
        description: 'Tags that apply to this record. May be empty.',
        items: { type: 'string', enum: names },
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'high = the abstract states the subject plainly; medium = inferred but well supported; low = guessing, usually because only a title was available.',
      },
      reasoning: {
        type: 'string',
        description: 'One sentence justifying the choices, for human review.',
      },
    },
    required: ['tags', 'confidence', 'reasoning'],
    additionalProperties: false,
  };
}

function buildSystemPrompt(facets) {
  return [
    'You are tagging records in a research library about the intersection of',
    'artificial intelligence and biosecurity (AIxBio). Every record in this',
    'library is already about AI and biology, so do not tag that fact — tag what',
    'makes this record different from its neighbours.',
    '',
    'Assign tags from the controlled vocabulary below. Rules:',
    '',
    '- Use only tags that appear in the vocabulary. Never invent one.',
    '- Respect the per-facet limits stated in each section heading.',
    '- Prefer precision over coverage. Every tag should be one a reader',
    '  filtering the library would expect to find this record under. Do not pad',
    '  to the limit — the per-facet caps are ceilings, not targets.',
    '- Tag the subject of the item, not passing mentions. If a paper mentions',
    '  cloud labs in one sentence, it is not a cloud labs paper.',
    '- Returning an empty list is a valid and useful answer when nothing fits',
    '  well. Do not stretch for a tag.',
    '- The record already carries separate Item Type, Institution, Publication,',
    '  and Year fields, which are shown to you for context. Do not duplicate them',
    '  as tags.',
    '- If only a title is available, tag conservatively and set confidence "low".',
    '',
    '# Vocabulary',
    '',
    renderVocabulary(facets),
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Record rendering
 * ------------------------------------------------------------------ */

function renderRecord(record) {
  const abstract = (record.abstract || '').slice(0, MAX_ABSTRACT_CHARS);
  const fields = [
    ['Title', record.title],
    ['Item type', record.type],
    ['Publication', record.publication],
    ['Institution', record.institution],
    ['Year', record.year],
    ['Authors', record.creators],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');

  return abstract
    ? `${fields}\n\nAbstract:\n${abstract}`
    : `${fields}\n\n(No abstract available — tag from the title alone and set confidence "low".)`;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Re-check what the schema cannot express: per-facet caps and duplicates.
 * Over-limit tags are trimmed rather than rejected — a record with four topic
 * tags is still a useful suggestion, it just needs the tail cut.
 */
function validateSuggestion(result, vocab) {
  const warnings = [];
  const facetOf = new Map(vocab.allTags.map((t) => [t.name, t.facet]));
  const capOf = new Map(vocab.facets.map((f) => [f.name, f.maxPerRecord]));

  const seen = new Set();
  const counts = new Map();
  const kept = [];

  for (const tag of result.tags || []) {
    if (seen.has(tag)) continue;
    seen.add(tag);

    const facet = facetOf.get(tag);
    const used = counts.get(facet) || 0;
    if (used >= capOf.get(facet)) {
      warnings.push(`dropped "${tag}" (over the ${facet} limit)`);
      continue;
    }
    counts.set(facet, used + 1);
    kept.push(tag);
  }

  return { tags: kept.sort(), warnings };
}

/* ------------------------------------------------------------------ *
 * Model call
 * ------------------------------------------------------------------ */

async function suggestForRecord(client, record, ctx) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: ctx.systemPrompt,
    output_config: { format: { type: 'json_schema', schema: ctx.schema } },
    messages: [{ role: 'user', content: renderRecord(record) }],
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error('response truncated at max_tokens');
  }

  const text = response.content.find((b) => b.type === 'text');
  if (!text) throw new Error('no text block in response');

  const parsed = JSON.parse(text.text);
  const { tags, warnings } = validateSuggestion(parsed, ctx.vocab);

  return {
    id: record.id,
    title: record.title,
    type: record.type,
    url: record.url,
    hasAbstract: Boolean(record.abstract),
    tags,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    warnings,
    // Flip to false (or edit `tags`) during review; apply-tags.js honours it.
    approved: true,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'Missing ANTHROPIC_API_KEY.\n' +
        '  Get a key at https://console.anthropic.com/settings/keys\n' +
        '  Then: $env:ANTHROPIC_API_KEY = "sk-ant-..."   (PowerShell)'
    );
    process.exit(1);
  }

  const vocab = loadVocabulary();
  const library = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  const research = library.research || [];

  let candidates = research.filter((r) => r.title && !(r.tags || []).length);
  if (opts.ids.length) {
    const wanted = new Set(opts.ids);
    candidates = research.filter((r) => wanted.has(r.id));
  }
  if (opts.requireAbstract) {
    candidates = candidates.filter((r) => r.abstract);
  }
  candidates = candidates.slice(0, opts.limit);

  if (!candidates.length) {
    console.log('Nothing to tag. Every Research record already has tags.');
    return;
  }

  const outFile = opts.out
    ? path.resolve(opts.out)
    : path.join(ROOT, 'data', 'tag-suggestions.json');

  console.log(`Model:      ${MODEL}`);
  console.log(`Vocabulary: ${vocab.names.length} tags across ${vocab.facets.length} facets`);
  console.log(`Records:    ${candidates.length} (${candidates.filter((r) => r.abstract).length} with abstracts)`);
  console.log(`Output:     ${path.relative(ROOT, outFile)}\n`);

  const client = new Anthropic({ maxRetries: 4 });
  const ctx = {
    vocab,
    schema: buildSchema(vocab.names),
    systemPrompt: buildSystemPrompt(vocab.facets),
  };

  let done = 0;
  const failures = [];

  const suggestions = await mapWithConcurrency(candidates, CONCURRENCY, async (record) => {
    try {
      const result = await suggestForRecord(client, record, ctx);
      done++;
      process.stdout.write(
        `  [${String(done).padStart(3)}/${candidates.length}] ${result.tags.join(', ') || '(none)'}` +
          `  — ${record.title.slice(0, 60)}\n`
      );
      return result;
    } catch (err) {
      // One bad record shouldn't lose the other 209. Collect and report.
      done++;
      failures.push({ id: record.id, title: record.title, error: err.message });
      console.error(`  [${String(done).padStart(3)}/${candidates.length}] FAILED — ${record.title.slice(0, 60)}: ${err.message}`);
      return null;
    }
  });

  const ok = suggestions.filter(Boolean);

  const usage = ok.reduce(
    (acc, s) => ({ input: acc.input + s.usage.input, output: acc.output + s.usage.output }),
    { input: 0, output: 0 }
  );
  const cost =
    (usage.input / 1e6) * PRICE_IN_PER_MTOK + (usage.output / 1e6) * PRICE_OUT_PER_MTOK;

  const payload = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    vocabularyTags: vocab.names.length,
    usage: { ...usage, estimatedCostUSD: Number(cost.toFixed(4)) },
    failures,
    suggestions: ok,
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  /* -------------------------------------------------------------- */

  const byConfidence = ok.reduce((acc, s) => {
    acc[s.confidence] = (acc[s.confidence] || 0) + 1;
    return acc;
  }, {});
  const empty = ok.filter((s) => !s.tags.length).length;
  const tagCounts = {};
  ok.forEach((s) => s.tags.forEach((t) => (tagCounts[t] = (tagCounts[t] || 0) + 1)));

  console.log(`\nWrote ${path.relative(ROOT, outFile)}`);
  console.log(`  tagged:     ${ok.length - empty}`);
  console.log(`  no tags:    ${empty}`);
  console.log(`  failed:     ${failures.length}`);
  console.log(`  confidence: ${Object.entries(byConfidence).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  tokens:     ${usage.input} in / ${usage.output} out  (~$${cost.toFixed(2)})`);

  console.log('\nTag distribution:');
  Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([tag, n]) => console.log(`  ${String(n).padStart(4)}  ${tag}`));

  // A tag nothing matched is usually a badly-worded description, not an absent
  // subject — surface it so the vocabulary can be tightened before applying.
  const unused = vocab.names.filter((n) => !tagCounts[n]);
  if (unused.length) {
    console.log(`\nNever suggested (${unused.length}): ${unused.join(', ')}`);
  }

  console.log('\nNext: review the file, then `node scripts/apply-tags.js` for a dry run.');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
