#!/usr/bin/env node
/**
 * Preview dist/ locally: `node scripts/serve.js`
 *
 * The pages use root-absolute links (/research/), so opening the files
 * directly from disk gives broken navigation. This serves dist/ at a domain
 * root, the same shape GitHub Pages will. No dependencies.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT) || 4173;

// Mirror the deployed sub-path locally. Serving at the root while production
// serves under /aixbiohub is exactly how a broken base path reaches the site
// unnoticed — every link works on localhost and 404s once deployed.
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'site.config.json'), 'utf8')
);
const BASE = config.customDomain
  ? ''
  : String(process.env.BASE_PATH || config.basePath || '')
      .trim()
      .replace(/\/+$/, '');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

if (!fs.existsSync(DIST)) {
  console.error('No dist/ directory. Run `node scripts/build.js` first.');
  process.exit(1);
}

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);

    // Anything outside the base path does not exist in production either.
    if (BASE) {
      if (urlPath === BASE) {
        res.writeHead(302, { Location: BASE + '/' }).end();
        return;
      }
      if (!urlPath.startsWith(BASE + '/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not found. This site is served under ${BASE}/`);
        return;
      }
      urlPath = urlPath.slice(BASE.length);
    }

    // Resolve inside DIST and reject anything that escapes it.
    let file = path.join(DIST, urlPath);
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, 'index.html');
    }

    let status = 200;
    if (!fs.existsSync(file)) {
      status = 404;
      file = path.join(DIST, '404.html');
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
    }

    res.writeHead(status, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, () => {
    console.log(`Serving dist/ at http://localhost:${PORT}${BASE}/`);
  });
