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

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

if (!fs.existsSync(DIST)) {
  console.error('No dist/ directory. Run `node scripts/build.js` first.');
  process.exit(1);
}

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

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
    console.log(`Serving dist/ at http://localhost:${PORT}`);
  });
