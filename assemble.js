#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const template = fs.readFileSync(path.join(BASE, 'config-editor-template.html'), 'utf8');
const meta     = fs.readFileSync(path.join(BASE, 'meta-generated.js'), 'utf8');

// Safety: prevent </script> in the injected data from breaking the HTML parser
const safeData = meta.trim().replace(/<\/script>/gi, '<\\/script>');

// Replace the placeholder line — the template has: const META={};const TABS=[];/*META_INJECT*/
const result = template.replace('const META={};const TABS=[];/*META_INJECT*/', safeData);

if (result === template) {
  console.error('ERROR: placeholder not found in template');
  process.exit(1);
}

const outPath = path.join(BASE, 'config-editor.html');
fs.writeFileSync(outPath, result, 'utf8');
const kb = (Buffer.byteLength(result, 'utf8') / 1024).toFixed(1);
console.log(`Built: config-editor.html  (${kb} KB)`);
