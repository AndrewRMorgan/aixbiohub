const https = require('https');

// Configuration from environment variables
const ZOTERO_USER_ID = process.env.ZOTERO_USER_ID;
const ZOTERO_API_KEY = process.env.ZOTERO_API_KEY;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Research';

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
      path: `/users/${ZOTERO_USER_ID}/items?limit=${limit}&start=${start}`,
      method: 'GET',
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-API-Key': ZOTERO_API_KEY
      }
    };
    
    try {
      const response = await makeRequest(options);
      const items = response.data;
      
      if (totalResults === null) {
        totalResults = parseInt(response.headers['total-results'] || '0');
        console.log(`Total items to fetch: ${totalResults}`);
      }
      
      allItems.push(...items);
      start += limit;
      console.log(`Fetched ${allItems.length} of ${totalResults} items`);
      
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

// Transform Zotero item to Airtable fields
function transformZoteroItem(zoteroItem) {
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
  
  // Basic mapping - adjust these field names to match your Airtable schema
  return {
    'Zotero Key': zoteroItem.key,
    'Title': data.title || '',
    'Item Type': data.itemType || '',
    'Creators': creators.join('; '),
    'Abstract': data.abstractNote || '',
    'Publication': data.publicationTitle || data.publisher || '',
    'Date': data.date || '',
    'URL': data.url || '',
    'DOI': data.DOI || '',
    'Tags': (data.tags || []).map(t => t.tag).join(', '),
    'Date Added': data.dateAdded || '',
    'Date Modified': data.dateModified || ''
  };
}

// Update or create records in Airtable
async function syncToAirtable(zoteroItems, existingRecords) {
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
    const fields = transformZoteroItem(zoteroItem);
    const existingRecord = existingMap.get(zoteroItem.key);
    
    if (existingRecord) {
      // Check if update is needed (compare date modified)
      if (existingRecord.fields['Date Modified'] !== fields['Date Modified']) {
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
    if (!ZOTERO_USER_ID || !ZOTERO_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      throw new Error('Missing required environment variables');
    }
    
    // Fetch data from both sources
    const zoteroItems = await fetchAllZoteroItems();
    const airtableRecords = await fetchAirtableRecords();
    
    // Sync to Airtable
    await syncToAirtable(zoteroItems, airtableRecords);
    
    console.log('Sync completed successfully!');
    
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  }
}

main();
