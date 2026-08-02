const https = require('https');

// Configuration from environment variables
const ZOTERO_USER_ID = process.env.ZOTERO_USER_ID;
const ZOTERO_GROUP_ID = process.env.ZOTERO_GROUP_ID;
const ZOTERO_API_KEY = process.env.ZOTERO_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Research';

// Determine library prefix (user or group)
const libraryPrefix = ZOTERO_GROUP_ID 
  ? `groups/${ZOTERO_GROUP_ID}` 
  : `users/${ZOTERO_USER_ID}`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to make HTTPS requests
function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    if (postData) {
      options = {
        ...options,
        headers: {
          ...options.headers,
          'Content-Length': Buffer.byteLength(postData)
        }
      };
    }

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({
              data: data ? JSON.parse(data) : null,
              headers: res.headers
            });
          } catch (e) {
            resolve({ data: data, headers: res.headers });
          }
        } else {
          const error = new Error(`Request failed with status ${res.statusCode}: ${data}`);
          error.statusCode = res.statusCode;
          error.body = data;
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (postData) {
      req.write(postData);
    }

    req.end();
  });
}

// Retry on rate limits (429) and transient server errors. A 4xx other than 429
// is a request we built wrong - retrying it just wastes time, so fail fast.
async function makeRequestWithRetry(options, postData = null, maxAttempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await makeRequest(options, postData);
    } catch (error) {
      lastError = error;

      const retryable = error.statusCode === 429 || error.statusCode >= 500 || !error.statusCode;
      if (!retryable || attempt === maxAttempts) break;

      // Airtable blocks the base for 30s after a 429, so back off hard.
      const backoff = error.statusCode === 429 ? 30000 : 1000 * Math.pow(2, attempt - 1);
      console.log(`  Request failed (${error.statusCode || 'network'}), retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts})`);
      await sleep(backoff);
    }
  }

  throw lastError;
}

// Fetch all items from Zotero with pagination
async function fetchAllZoteroItems() {
  const allItems = [];
  let start = 0;
  const limit = 100;
  let totalResults = null;
  
  console.log('Fetching items from Zotero...');
  
  while (totalResults === null || start < totalResults) {
    const options = {
      // /items/top returns only top-level items, matching the count Zotero's UI
      // shows. Sorting by dateAdded ascending keeps paging stable - the default
      // dateModified sort reshuffles items between pages mid-sync, which silently
      // skips records.
      hostname: 'api.zotero.org',
      path: `/${libraryPrefix}/items/top?limit=${limit}&start=${start}&sort=dateAdded&direction=asc`,
      method: 'GET',
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-API-Key': ZOTERO_API_KEY
      }
    };

    try {
      const response = await makeRequestWithRetry(options);
      let items = response.data;

      // Standalone notes and attachments can still appear at the top level
      items = items.filter(item => {
        const itemType = item.data.itemType;
        return itemType !== 'attachment' && itemType !== 'note';
      });

      if (totalResults === null) {
        totalResults = parseInt(response.headers['total-results'] || '0');
        console.log(`Total top-level items in library: ${totalResults}`);
      }

      allItems.push(...items);
      start += limit;
      console.log(`Fetched ${allItems.length} items (excluding attachments/notes)`);

      // Small delay to respect rate limits
      await sleep(100);

    } catch (error) {
      console.error(`Error fetching Zotero items at start=${start}:`, error.message);
      throw error;
    }
  }

  return allItems;
}

// Fetch existing items from Airtable
async function fetchAirtableRecords() {
  const allRecords = [];
  let offset = null;

  console.log('Fetching existing records from Airtable...');

  do {
    let path = `/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
    if (offset) {
      // Offsets look like "itrAbC123/recXyZ456" and must be encoded
      path += `?offset=${encodeURIComponent(offset)}`;
    }

    const options = {
      hostname: 'api.airtable.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    };

    try {
      const response = await makeRequestWithRetry(options);
      allRecords.push(...response.data.records);
      offset = response.data.offset;

      console.log(`Fetched ${allRecords.length} records from Airtable...`);

    } catch (error) {
      console.error('Error fetching Airtable records:', error.message);
      throw error;
    }
  } while (offset);

  return allRecords;
}

// Select fields whose values must already exist as options in Airtable.
// Sending an unknown option returns INVALID_MULTIPLE_CHOICE_OPTIONS and rejects
// the whole batch, so every one of these needs validating before we send it.
const SELECT_FIELDS = {
  institutions: 'Institution',
  publications: 'Publication',
  itemTypes: 'Item Type',
  years: 'Year'
};

const EMPTY_OPTIONS = { institutions: [], publications: [], itemTypes: [], years: [] };

// Fetch Airtable base schema to get valid field options
async function fetchFieldOptions() {
  console.log('Fetching field options from Airtable schema...');

  const options = {
    hostname: 'api.airtable.com',
    path: `/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${AIRTABLE_API_KEY}`
    }
  };

  try {
    const response = await makeRequestWithRetry(options);
    const tables = response.data.tables;

    // Find our table
    const table = tables.find(t => t.name === AIRTABLE_TABLE_NAME);
    if (!table) {
      console.log(`Table "${AIRTABLE_TABLE_NAME}" not found in schema`);
      return { ...EMPTY_OPTIONS };
    }

    const result = {};

    for (const [key, fieldName] of Object.entries(SELECT_FIELDS)) {
      const field = table.fields.find(f => f.name === fieldName);
      const choices = field && field.options && field.options.choices;

      if (choices) {
        result[key] = choices.map(choice => choice.name);
        console.log(`Found ${result[key].length} existing "${fieldName}" options`);
      } else {
        result[key] = [];
        console.log(`Field "${fieldName}" not found or has no options`);
      }
    }

    return result;

  } catch (error) {
    console.error('Error fetching Airtable schema:', error.message);
    console.log('Continuing without field validation...');
    return { ...EMPTY_OPTIONS };
  }
}

// Convert Zotero item type to human-readable format
function formatItemType(itemType) {
  const itemTypeMap = {
    'report': 'Report',
    'blogPost': 'Blog post',
    'journalArticle': 'Journal article',
    'preprint': 'Preprint',
    'webpage': 'Webpage',
    'magazineArticle': 'Magazine article',
    'newspaperArticle': 'Newspaper article',
    'book': 'Book',
    'bookSection': 'Book section'
  };

  return itemTypeMap[itemType] || itemType;
}

// Convert various date formats to YYYY-MM-DD, or null if there is no usable
// date. Never return a partial or unparseable string: "Publication Date" is a
// real Airtable Date column and anything it can't parse rejects the entire
// 10-record batch.
function formatDate(dateString) {
  if (!dateString) return null;

  // Try to parse the date
  let date = new Date(dateString);

  // If the date is invalid, try to extract year/month/day from common formats
  if (isNaN(date.getTime())) {
    // Try to match YYYY-MM-DD, YYYY/MM/DD, or YYYY
    const yearMatch = dateString.match(/(\d{4})/);
    if (yearMatch) {
      const year = yearMatch[1];
      const monthMatch = dateString.match(/\d{4}[-/](\d{1,2})/);
      const dayMatch = dateString.match(/\d{4}[-/]\d{1,2}[-/](\d{1,2})/);

      if (monthMatch && dayMatch) {
        const month = monthMatch[1].padStart(2, '0');
        const day = dayMatch[1].padStart(2, '0');
        return `${year}-${month}-${day}`;
      } else if (monthMatch) {
        const month = monthMatch[1].padStart(2, '0');
        return `${year}-${month}-01`;
      } else {
        return `${year}-01-01`;
      }
    }
    // Free text like "n.d." or "forthcoming" - no date at all
    return null;
  }

  // Format as YYYY-MM-DD (UTC, so the runner's timezone can't shift the day)
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

// Select values dropped because the option doesn't exist in Airtable yet.
// Reported as a summary at the end of the run so they can be added.
const skippedSelectValues = {};

function recordSkippedOption(fieldName, value) {
  if (!skippedSelectValues[fieldName]) {
    skippedSelectValues[fieldName] = new Set();
  }
  skippedSelectValues[fieldName].add(value);
}

// Keep only values that already exist as options on the Airtable select field.
// If the schema fetch failed we have no option list, so pass values through
// rather than silently blanking every select in the table.
function filterToValidOptions(values, allowed, fieldName) {
  if (!allowed || allowed.length === 0) return values;

  return values.filter(value => {
    if (allowed.includes(value)) return true;
    recordSkippedOption(fieldName, value);
    return false;
  });
}

// Transform Zotero item to Airtable fields
function transformZoteroItem(zoteroItem, validOptions = EMPTY_OPTIONS) {
  const data = zoteroItem.data;

  // Build creator names (authors, editors, etc.)
  const creators = (data.creators || [])
    .map(c => {
      if (c.name) return c.name;
      const parts = [];
      if (c.firstName) parts.push(c.firstName);
      if (c.lastName) parts.push(c.lastName);
      return parts.join(' ');
    })
    .filter(name => name);

  // Process Item Type for Multiple select (single value array). Zotero types
  // with no entry in itemTypeMap fall through as-is (e.g. "document"), so this
  // still has to be checked against the real options.
  const itemType = formatItemType(data.itemType) || '';
  const itemTypeArray = filterToValidOptions(
    itemType ? [itemType] : [],
    validOptions.itemTypes,
    'Item Type'
  );

  // Extract year from date for Year field (Multiple select)
  const formattedDate = formatDate(data.date);
  let yearArray = [];
  if (formattedDate) {
    const yearMatch = formattedDate.match(/^(\d{4})/);
    if (yearMatch) {
      yearArray = [yearMatch[1]];
    }
  }
  yearArray = filterToValidOptions(yearArray, validOptions.years, 'Year');

  // Process institution field for Multiple select in Airtable
  // Different item types use different field names:
  // - Report uses 'institution'
  // - Thesis uses 'university'
  // - Court Document uses 'court'
  let institutionValue = data.institution || data.university || data.court || '';

  let allInstitutions = [];
  if (institutionValue) {
    // Split by semicolon or comma if multiple institutions are present
    allInstitutions = institutionValue
      .split(/[;,]/)
      .map(inst => inst.trim())
      .filter(inst => inst);
  }

  // Split institutions into valid (existing options) and new (need to be added)
  const validInstitutions = [];
  const newInstitutions = [];

  allInstitutions.forEach(inst => {
    if (validOptions.institutions.includes(inst)) {
      validInstitutions.push(inst);
    } else {
      newInstitutions.push(inst);
    }
  });

  // Process publication field for Multiple select in Airtable
  let publicationValue = data.publicationTitle || data.publisher || '';

  // For preprints, also include repository
  if (data.itemType === 'preprint' && data.repository) {
    publicationValue = publicationValue
      ? `${publicationValue}, ${data.repository}`
      : data.repository;
  }

  // For blog posts, also include blog title
  if (data.itemType === 'blogPost' && data.blogTitle) {
    publicationValue = publicationValue
      ? `${publicationValue}, ${data.blogTitle}`
      : data.blogTitle;
  }

  // For webpages, also include website title
  if (data.itemType === 'webpage' && data.websiteTitle) {
    publicationValue = publicationValue
      ? `${publicationValue}, ${data.websiteTitle}`
      : data.websiteTitle;
  }

  let allPublications = [];
  if (publicationValue) {
    // Split by semicolon or comma if multiple publications are present
    allPublications = publicationValue
      .split(/[;,]/)
      .map(pub => pub.trim())
      .filter(pub => pub);
  }

  // Split publications into valid (existing options) and new (need to be added)
  const validPublications = [];
  const newPublications = [];

  allPublications.forEach(pub => {
    if (validOptions.publications.includes(pub)) {
      validPublications.push(pub);
    } else {
      newPublications.push(pub);
    }
  });

  // Basic mapping - adjust these field names to match your Airtable schema
  const result = {
    'Zotero Key': zoteroItem.key,
    'Title': data.title || '',
    'Item Type': itemTypeArray,
    'Creators': creators.join('; '),
    'Abstract': data.abstractNote || '',
    'Publication': validPublications,
    'Publications to add': newPublications.join(', '),
    'Date': formattedDate || '',
    'Publication Date': formattedDate,
    'Year': yearArray,
    'URL': data.url || '',
    'DOI': data.DOI || '',
    'Date Added': data.dateAdded || '',
    'Date Modified': data.dateModified || '',
    'Institution': validInstitutions,
    'Institutions to add': newInstitutions.join(', ')
  };

  // Drop keys with no value. Airtable's Date columns reject "" outright, and
  // omitting a field is always safe - it just leaves the cell untouched.
  Object.keys(result).forEach(key => {
    if (result[key] === null || result[key] === undefined) {
      delete result[key];
    }
  });

  return result;
}

// Airtable omits empty fields from responses entirely, so an absent value and
// an empty array/string mean the same thing. Arrays are compared by content -
// comparing them with !== compares references, which is always true.
function normalizeForCompare(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return [...value].map(String).sort().join('|');
  return String(value);
}

function findChangedField(existingFields, newFields) {
  return Object.keys(newFields).find(
    key => normalizeForCompare(existingFields[key]) !== normalizeForCompare(newFields[key])
  );
}

// Write records to Airtable in batches of 10. Airtable batches are all-or-
// nothing, so when a batch is rejected we retry its records one at a time -
// that way a single bad record costs one record instead of ten.
async function writeRecords(method, records, verb) {
  const stats = { succeeded: 0, failed: 0, errors: [] };

  const options = {
    hostname: 'api.airtable.com',
    path: `/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
    method: method,
    headers: {
      'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    }
  };

  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const rangeLabel = `${i + 1} to ${Math.min(i + 10, records.length)}`;

    try {
      await makeRequestWithRetry(options, JSON.stringify({ records: batch }));
      stats.succeeded += batch.length;
      console.log(`${verb} records ${rangeLabel}`);
    } catch (error) {
      console.error(`Batch ${rangeLabel} rejected, retrying individually: ${error.message}`);

      for (const record of batch) {
        try {
          await makeRequestWithRetry(options, JSON.stringify({ records: [record] }));
          stats.succeeded += 1;
        } catch (recordError) {
          stats.failed += 1;
          const title = record.fields['Title'] || record.fields['Zotero Key'] || '(untitled)';
          console.error(`  FAILED: "${title}" - ${recordError.message}`);
          stats.errors.push(`${title}: ${recordError.message}`);
        }
        await sleep(200); // Rate limiting
      }
    }

    await sleep(200); // Rate limiting
  }

  return stats;
}

// Update or create records in Airtable
async function syncToAirtable(zoteroItems, existingRecords, validOptions = EMPTY_OPTIONS) {
  // Create a map of existing records by Zotero Key
  const existingMap = new Map();
  const matchedKeys = new Set();
  existingRecords.forEach(record => {
    if (record.fields['Zotero Key']) {
      existingMap.set(record.fields['Zotero Key'], record);
    }
  });

  const recordsToCreate = [];
  const recordsToUpdate = [];
  const changeReasons = {};

  // Determine which records need to be created or updated
  zoteroItems.forEach(zoteroItem => {
    const fields = transformZoteroItem(zoteroItem, validOptions);
    const existingRecord = existingMap.get(zoteroItem.key);

    if (existingRecord) {
      matchedKeys.add(zoteroItem.key);

      const changedField = findChangedField(existingRecord.fields, fields);
      if (changedField) {
        changeReasons[changedField] = (changeReasons[changedField] || 0) + 1;
        recordsToUpdate.push({
          id: existingRecord.id,
          fields: fields
        });
      }
    } else {
      recordsToCreate.push({ fields: fields });
    }
  });

  console.log(`Records to create: ${recordsToCreate.length}`);
  console.log(`Records to update: ${recordsToUpdate.length}`);

  // If one field is driving nearly every update, it's a formatting mismatch
  // between what we send and what Airtable stores, not real churn.
  if (recordsToUpdate.length > 0) {
    const reasons = Object.entries(changeReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([field, count]) => `${field} (${count})`);
    console.log(`Updates triggered by: ${reasons.join(', ')}`);
  }

  const created = await writeRecords('POST', recordsToCreate, 'Created');
  const updated = await writeRecords('PATCH', recordsToUpdate, 'Updated');

  // Airtable rows whose Zotero item no longer exists (or that have no key).
  // Reported only - deleting them is your call, not the script's.
  const orphans = existingRecords.filter(
    record => !record.fields['Zotero Key'] || !matchedKeys.has(record.fields['Zotero Key'])
  );

  return { created, updated, orphans };
}

// Main sync function
async function main() {
  try {
    console.log('Starting Zotero to Airtable sync...');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    
    // Validate environment variables
    if ((!ZOTERO_USER_ID && !ZOTERO_GROUP_ID) || !ZOTERO_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      throw new Error('Missing required environment variables. Need either ZOTERO_USER_ID or ZOTERO_GROUP_ID, plus ZOTERO_API_KEY, AIRTABLE_API_KEY, and AIRTABLE_BASE_ID');
    }
    
    console.log(`Syncing from Zotero ${ZOTERO_GROUP_ID ? 'group' : 'user'} library...`);

    // Fetch data from both sources
    const zoteroItems = await fetchAllZoteroItems();
    const airtableRecords = await fetchAirtableRecords();
    const validFieldOptions = await fetchFieldOptions();

    // Sync to Airtable
    const { created, updated, orphans } = await syncToAirtable(
      zoteroItems,
      airtableRecords,
      validFieldOptions
    );

    console.log('\n--- Summary ---');
    console.log(`Zotero items:      ${zoteroItems.length}`);
    console.log(`Airtable records:  ${airtableRecords.length}`);
    console.log(`Created:           ${created.succeeded} (${created.failed} failed)`);
    console.log(`Updated:           ${updated.succeeded} (${updated.failed} failed)`);

    if (orphans.length > 0) {
      console.log(`\n${orphans.length} Airtable record(s) with no matching Zotero item:`);
      orphans.forEach(record => {
        console.log(`  - ${record.fields['Title'] || record.id} (key: ${record.fields['Zotero Key'] || 'none'})`);
      });
    }

    const skippedFields = Object.keys(skippedSelectValues);
    if (skippedFields.length > 0) {
      console.log('\nSelect values dropped - add these options in Airtable to sync them:');
      skippedFields.forEach(field => {
        const values = [...skippedSelectValues[field]].sort();
        console.log(`  ${field}: ${values.join(', ')}`);
      });
    }

    const totalFailed = created.failed + updated.failed;
    if (totalFailed > 0) {
      throw new Error(`${totalFailed} record(s) could not be written to Airtable`);
    }

    console.log('\nSync completed successfully!');

  } catch (error) {
    console.error('Sync failed:', error.message || error);
    process.exit(1);
  }
}

main();