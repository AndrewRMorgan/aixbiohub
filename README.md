# Zotero to Airtable Sync

Automatically syncs research items from Zotero to Airtable every 12 hours using GitHub Actions.

## Features

- ✅ Handles pagination to fetch all Zotero items (no 100-item limit)
- ✅ Creates new records in Airtable for new Zotero items
- ✅ Updates existing Airtable records when Zotero items are modified
- ✅ Runs automatically every 12 hours
- ✅ Can be triggered manually
- ✅ Uses no external dependencies (pure Node.js)

## Setup Instructions

### 1. Get Your API Credentials

#### Zotero
1. Go to https://www.zotero.org/settings/keys
2. Create a new API key with read permissions for your group
3. For a **User Library**: Note your **User ID** (shown on the same page)
4. For a **Group Library**: 
   - Go to your group page: https://www.zotero.org/groups/
   - Click on your group (e.g., "aixbiohub")
   - Look at the URL: `https://www.zotero.org/groups/12345/groupname`
   - The number (12345) is your Group ID
5. Save your **API Key**

#### Airtable
1. Go to https://airtable.com/create/tokens
2. Create a personal access token with these scopes:
   - `data.records:read`
   - `data.records:write`
   - `schema.bases:read`
3. Add access to your base
4. Save your **API Key**
5. Get your **Base ID** from your Airtable URL: `https://airtable.com/appXXXXXXXXXXXXXX/...`
   (The part starting with `app` is your Base ID)
6. Note your **Table Name** (e.g., "Research")

### 2. Set Up Your Airtable Table

Make sure your Airtable table has these fields (or modify the script to match your schema):

| Field Name | Type |
|------------|------|
| Zotero Key | Single line text |
| Title | Single line text |
| Item Type | Multiple select |
| Creators | Long text |
| Abstract | Long text |
| Publication | Multiple select |
| Publications to add | Long text |
| Date | Single line text |
| URL | URL |
| DOI | Single line text |
| Tags | Long text |
| Date Added | Single line text |
| Date Modified | Single line text |
| Institution | Multiple select |
| Institutions to add | Long text |

**Important:**
- The "Zotero Key" field is required - it's used to match records between systems.
- The "Item Type" field uses Multiple select. Item types are automatically handled by the script.
- The "Institution" and "Publication" fields use Multiple select. Any values not already in your dropdown options will be placed in "Institutions to add" or "Publications to add" fields.
- To use new institutions/publications: (1) Check "Institutions to add" / "Publications to add" fields, (2) Add those values to the corresponding field dropdown options in Airtable, (3) Re-run the sync.

### 3. Create a GitHub Repository

1. Create a new repository on GitHub (can be private)
2. Clone it to your computer
3. Copy these files into your repository:
   - `sync-zotero-to-airtable.js`
   - `.github/workflows/sync.yml`

### 4. Add Secrets to GitHub

1. Go to your repository on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret** and add these secrets:

| Secret Name | Value |
|-------------|-------|
| ZOTERO_USER_ID | Your Zotero User ID |
| ZOTERO_API_KEY | Your Zotero API Key |
| AIRTABLE_API_KEY | Your Airtable API Key |
| AIRTABLE_BASE_ID | Your Airtable Base ID (starts with "app") |
| AIRTABLE_TABLE_NAME | Your table name (e.g., "Research") |

### 5. Push to GitHub

```bash
git add .
git commit -m "Initial commit: Zotero to Airtable sync"
git push origin main
```

### 6. Verify It's Working

1. Go to the **Actions** tab in your GitHub repository
2. Click on **Sync Zotero to Airtable** workflow
3. Click **Run workflow** to test it manually
4. Watch the logs to see if it completes successfully

The sync will now run automatically every 12 hours!

## Customization

### Change Sync Schedule

Edit `.github/workflows/sync.yml` and modify the cron schedule:

```yaml
schedule:
  # Examples:
  - cron: '0 */6 * * *'   # Every 6 hours
  - cron: '0 0 * * *'     # Once daily at midnight UTC
  - cron: '0 9,21 * * *'  # Twice daily at 9 AM and 9 PM UTC
```

### Modify Field Mappings

Edit `sync-zotero-to-airtable.js` and modify the `transformZoteroItem()` function to match your Airtable schema.

### Filter Zotero Items

To sync only specific collections or tags, modify the API path in `fetchAllZoteroItems()`:

```javascript
// Sync only a specific collection
path: `/users/${ZOTERO_USER_ID}/collections/COLLECTIONKEY/items?limit=${limit}&start=${start}`,

// Sync only items with a specific tag
path: `/users/${ZOTERO_USER_ID}/items?tag=website&limit=${limit}&start=${start}`,
```

### Managing Multiple Select Field Options

The script automatically checks which institutions and publications are already configured in your Airtable Multiple select fields:

#### For Institutions:

1. **When a new institution is found** in Zotero that doesn't match existing Airtable options, it will be added to "Institutions to add"
2. **To add new institutions**:
   - Run the sync and check the "Institutions to add" field for any records
   - In Airtable, click the "Institution" field header → "Customize field type" → Add the new institutions to the options list
   - Re-run the sync - the institutions will now move from "Institutions to add" to "Institution"

**Note:** The script pulls institution data from different Zotero fields depending on item type:
- Reports use the "institution" field
- Theses use the "university" field
- Court documents use the "court" field

#### For Publications:

1. **When a new publication is found** in Zotero that doesn't match existing Airtable options, it will be added to "Publications to add"
2. **To add new publications**:
   - Run the sync and check the "Publications to add" field for any records
   - In Airtable, click the "Publication" field header → "Customize field type" → Add the new publications to the options list
   - Re-run the sync - the publications will now move from "Publications to add" to "Publication"

**Note:** The script pulls publication data from "publicationTitle" or falls back to "publisher" if no publication title exists.

## Troubleshooting

### Sync fails with "Missing required environment variables"
- Check that all secrets are added in GitHub Settings → Secrets

### No records are created in Airtable
- Verify your Airtable Base ID and Table Name are correct
- Check that the Airtable token has write permissions
- Ensure field names in the script match your Airtable table

### Rate limiting errors
- The script includes delays to respect API limits
- If you have many items, the sync might take several minutes

### View sync logs
1. Go to **Actions** tab in GitHub
2. Click on a workflow run
3. Click on the "sync" job to see detailed logs

## Manual Trigger

You can manually trigger a sync anytime:
1. Go to **Actions** tab
2. Click **Sync Zotero to Airtable**
3. Click **Run workflow**

## License

MIT