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

// Helper function to make HTTPS requests
function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
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
          reject(new Error(`Request failed with status ${res.statusCode}: ${data}`));
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

// Fetch all items from Zotero with pagination
async function fetchAllZoteroItems() {
  const allItems = [];
  let start = 0;
  const limit = 100;
  let totalResults = null;
  
  console.log('Fetching items from Zotero...');
  
  while (totalResults === null || start < totalResults) {
    const options = {
      hostname: 'api.zotero.org',
      path: `/${libraryPrefix}/items?limit=${limit}&start=${start}`,
      method: 'GET',
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-API-Key': ZOTERO_API_KEY
      }
    };
    
    try {
      const response = await makeRequest(options);
      let items = response.data;
      
      // Filter out attachments and notes
      items = items.filter(item => {
        const itemType = item.data.itemType;
        return itemType !== 'attachment' && itemType !== 'note';
      });
      
      if (totalResults === null) {
        totalResults = parseInt(response.headers['total-results'] || '0');
        console.log(`Total items in library: ${totalResults}`);
      }
      
      allItems.push(...items);
      start += limit;
      console.log(`Fetched ${allItems.length} items (excluding attachments/notes)`);
      
      // Small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
      
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
      path += `?offset=${offset}`;
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
      const response = await makeRequest(options);
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
    const response = await makeRequest(options);
    const tables = response.data.tables;

    // Find our table
    const table = tables.find(t => t.name === AIRTABLE_TABLE_NAME);
    if (!table) {
      console.log(`Table "${AIRTABLE_TABLE_NAME}" not found in schema`);
      return { institutions: [], publications: [] };
    }

    // Find the Institution field
    const institutionField = table.fields.find(f => f.name === 'Institution');
    const institutionOptions = [];
    if (institutionField && institutionField.options && institutionField.options.choices) {
      institutionOptions.push(...institutionField.options.choices.map(choice => choice.name));
      console.log(`Found ${institutionOptions.length} existing institution options:`, institutionOptions);
    } else {
      console.log('Institution field not found or has no options');
    }

    // Find the Publication field
    const publicationField = table.fields.find(f => f.name === 'Publication');
    const publicationOptions = [];
    if (publicationField && publicationField.options && publicationField.options.choices) {
      publicationOptions.push(...publicationField.options.choices.map(choice => choice.name));
      console.log(`Found ${publicationOptions.length} existing publication options:`, publicationOptions);
    } else {
      console.log('Publication field not found or has no options');
    }

    return {
      institutions: institutionOptions,
      publications: publicationOptions
    };

  } catch (error) {
    console.error('Error fetching Airtable schema:', error.message);
    console.log('Continuing without field validation...');
    return { institutions: [], publications: [] };
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

// Convert various date formats to YYYY-MM-DD
function formatDate(dateString) {
  if (!dateString) return '';

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
    // If we can't parse it, return the original string
    return dateString;
  }

  // Format as YYYY-MM-DD
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

// Transform Zotero item to Airtable fields
function transformZoteroItem(zoteroItem, validOptions = { institutions: [], publications: [] }) {
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

  // Process Item Type for Multiple select (single value array)
  const itemType = formatItemType(data.itemType) || '';
  const itemTypeArray = itemType ? [itemType] : [];

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
  const publicationValue = data.publicationTitle || data.publisher || '';

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
    'Date': formatDate(data.date),
    'URL': data.url || '',
    'DOI': data.DOI || '',
    'Tags': (data.tags || []).map(t => t.tag).join(', '),
    'Date Added': data.dateAdded || '',
    'Date Modified': data.dateModified || '',
    'Institution': validInstitutions,
    'Institutions to add': newInstitutions.join(', ')
  };

  // Log institution and publication data for debugging
  if (allInstitutions.length > 0) {
    console.log(`Item "${data.title}" - Institutions - Valid: [${validInstitutions.join(', ')}], New: [${newInstitutions.join(', ')}]`);
  }
  if (allPublications.length > 0) {
    console.log(`Item "${data.title}" - Publications - Valid: [${validPublications.join(', ')}], New: [${newPublications.join(', ')}]`);
  }

  return result;
}

// Update or create records in Airtable
async function syncToAirtable(zoteroItems, existingRecords, validOptions = { institutions: [], publications: [] }) {
  // Create a map of existing records by Zotero Key
  const existingMap = new Map();
  existingRecords.forEach(record => {
    if (record.fields['Zotero Key']) {
      existingMap.set(record.fields['Zotero Key'], record);
    }
  });

  const recordsToCreate = [];
  const recordsToUpdate = [];

  // Determine which records need to be created or updated
  zoteroItems.forEach(zoteroItem => {
    const fields = transformZoteroItem(zoteroItem, validOptions);
    const existingRecord = existingMap.get(zoteroItem.key);
    
    if (existingRecord) {
      // Check if update is needed (compare date modified, item type, or date format)
      const needsUpdate =
        existingRecord.fields['Date Modified'] !== fields['Date Modified'] ||
        existingRecord.fields['Item Type'] !== fields['Item Type'] ||
        existingRecord.fields['Date'] !== fields['Date'];

      if (needsUpdate) {
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
  
  // Create new records (Airtable allows up to 10 per request)
  if (recordsToCreate.length > 0) {
    for (let i = 0; i < recordsToCreate.length; i += 10) {
      const batch = recordsToCreate.slice(i, i + 10);
      
      const options = {
        hostname: 'api.airtable.com',
        path: `/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      };
      
      try {
        await makeRequest(options, JSON.stringify({ records: batch }));
        console.log(`Created records ${i + 1} to ${Math.min(i + 10, recordsToCreate.length)}`);
        await new Promise(resolve => setTimeout(resolve, 200)); // Rate limiting
      } catch (error) {
        console.error(`Error creating records:`, error.message);
      }
    }
  }
  
  // Update existing records (Airtable allows up to 10 per request)
  if (recordsToUpdate.length > 0) {
    for (let i = 0; i < recordsToUpdate.length; i += 10) {
      const batch = recordsToUpdate.slice(i, i + 10);
      
      const options = {
        hostname: 'api.airtable.com',
        path: `/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      };
      
      try {
        await makeRequest(options, JSON.stringify({ records: batch }));
        console.log(`Updated records ${i + 1} to ${Math.min(i + 10, recordsToUpdate.length)}`);
        await new Promise(resolve => setTimeout(resolve, 200)); // Rate limiting
      } catch (error) {
        console.error(`Error updating records:`, error.message);
      }
    }
  }
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
    await syncToAirtable(zoteroItems, airtableRecords, validFieldOptions);

    console.log('Sync completed successfully!');
    
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  }
}

main();