#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname);
const SRC  = path.join(BASE, 'ezquake-source-master', 'src');

// ── Load sources ─────────────────────────────────────────────────────────────
const helpData  = JSON.parse(fs.readFileSync(path.join(BASE, 'ezquake-source-master', 'help_variables.json'), 'utf8'));
const menuSrc   = fs.readFileSync(path.join(SRC, 'menu_options.c'), 'utf8');
const configSrc = fs.readFileSync(path.join(BASE, 'config.cfg'), 'utf8');

// ── Groups map ────────────────────────────────────────────────────────────────
const groups = {};
for (const g of helpData.groups) groups[g.id] = g.name;

// ── Config variable keys ──────────────────────────────────────────────────────
const configKeys = new Set();
for (const m of configSrc.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s+".*"$/gm)) configKeys.add(m[1]);
console.log(`Config variables: ${configKeys.size}`);

// ── Build C-variable → cvar-name translation map ─────────────────────────────
// menu_options.c uses C variable names (e.g. cl_teamtopcolor, scr_fov)
// but config.cfg uses the cvar string name (e.g. teamtopcolor, fov)
const cVarToCvar = {};
for (const cFile of fs.readdirSync(SRC).filter(f => f.endsWith('.c'))) {
  const src = fs.readFileSync(path.join(SRC, cFile), 'utf8');
  for (const m of src.matchAll(/cvar_t\s+(\w+)\s*=\s*\{\s*"(\w+)"/g)) {
    cVarToCvar[m[1]] = m[2]; // C var name → cvar string name
  }
}
console.log(`Cvar name mappings: ${Object.keys(cVarToCvar).length}`);

// ── Parse enum arrays from menu_options.c ────────────────────────────────────
const enumArrays = {};
for (const m of menuSrc.matchAll(/const char\s*\*+\s*(\w+)\s*\[\s*\]\s*=\s*\{([^}]+)\}/gs)) {
  const items = [];
  for (const q of m[2].matchAll(/"([^"]*)"/g)) items.push(q[1]);
  enumArrays[m[1]] = items;
}
console.log(`Enum arrays: ${Object.keys(enumArrays).length}`);

function parseEnumOptions(items) {
  if (!items || !items.length) return [];
  // Detect alternating label/value pairs vs simple value list.
  // Alternating when: even count AND (an even-indexed item has a space,
  // OR all odd-indexed items are numeric, OR even=ALL_CAPS and odd=all_lower).
  if (items.length % 2 === 0 && items.length >= 2) {
    const even = items.filter((_, i) => i % 2 === 0);
    const odd  = items.filter((_, i) => i % 2 === 1);
    const evenHasSpace    = even.some(s => s.includes(' ') || s.includes('('));
    const oddAllNumeric   = odd.every(s => /^-?\d*\.?\d+$/.test(s));
    const capsLowerPair   = even.every(s => s.length > 1 && s === s.toUpperCase()) &&
                            odd.every(s  => s === s.toLowerCase());
    if (evenHasSpace || oddAllNumeric || capsLowerPair) {
      const opts = [];
      for (let i = 0; i < items.length; i += 2) opts.push({ l: items[i], v: items[i+1] });
      return opts;
    }
  }
  return items.map(v => ({ l: v, v }));
}

// ── Parse ADDSET macros ───────────────────────────────────────────────────────
const menuMeta = {};

// Translate C variable name to config key name (falls back to C name if no mapping)
const toCvarKey = (cName) => cVarToCvar[cName] || cName;

const set = (varName, data) => {
  const key = toCvarKey(varName);
  if (!menuMeta[key]) menuMeta[key] = {};
  Object.assign(menuMeta[key], data);
};

// BOOL / BOOLLATE  — "Label", varName
for (const m of menuSrc.matchAll(/ADDSET_BOOL(?:LATE)?\s*\(\s*"([^"]+)"\s*,\s*(\w+)\s*[,)]/g))
  set(m[2], { l: m[1], t: 'bool' });

// NUMBER  — "Label", var, min, max, step
for (const m of menuSrc.matchAll(/ADDSET_NUMBER\s*\(\s*"([^"]+)"\s*,\s*(\w+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/g))
  set(m[2], { l: m[1], t: 'number', min: +m[3], max: +m[4], step: +m[5] });

// ENUM  — "Label", var, enum_array
for (const m of menuSrc.matchAll(/ADDSET_ENUM\s*\(\s*"([^"]+)"\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/g))
  set(m[2], { l: m[1], t: 'enum', opts: parseEnumOptions(enumArrays[m[3]]) });

// NAMED  — "Label", var, enum_array  (named integer selector)
for (const m of menuSrc.matchAll(/ADDSET_NAMED\s*\(\s*"([^"]+)"\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/g))
  set(m[2], { l: m[1], t: 'enum', opts: parseEnumOptions(enumArrays[m[3]]) });

// COLOR  — "Label", var  (Quake palette index 0-13, not RGB)
for (const m of menuSrc.matchAll(/ADDSET_COLOR\s*\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g))
  set(m[2], { l: m[1], t: 'palcolor' });

// STRING / SKIN  — "Label", var
for (const m of menuSrc.matchAll(/ADDSET_(?:STRING|SKIN)\s*\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g))
  set(m[2], { l: m[1] });

console.log(`Menu labels extracted: ${Object.keys(menuMeta).length}`);

// ── Build META ────────────────────────────────────────────────────────────────
const META = {};
let nLabel = 0, nDesc = 0, nType = 0, nOpts = 0;

for (const key of configKeys) {
  const menu = menuMeta[key];
  const help = helpData.vars[key];
  if (!menu && !help) continue;

  const e = {};

  // Label (from menu_options)
  if (menu?.l) { e.l = menu.l; nLabel++; }

  // Description (from help_variables.json — trim very long ones)
  if (help?.desc) {
    e.d = help.desc.length > 300 ? help.desc.slice(0, 297) + '…' : help.desc;
    nDesc++;
  }

  // Group name
  if (help?.['group-id'] && groups[help['group-id']]) e.g = groups[help['group-id']];

  // Type + constraints — menu_options takes priority over help_variables
  if (menu?.t === 'number') {
    e.t = 'number';
    if (menu.min  !== undefined) e.min  = menu.min;
    if (menu.max  !== undefined) e.max  = menu.max;
    if (menu.step !== undefined) e.step = menu.step;
    nType++;
  } else if (menu?.t === 'enum' && menu.opts?.length) {
    e.t = 'enum';
    e.opts = menu.opts;
    nType++; nOpts++;
  } else if (menu?.t === 'palcolor') {
    e.t = 'palcolor'; nType++;
  } else if (menu?.t === 'color') {
    e.t = 'color'; nType++;
  } else if (help?.type === 'enum' && help.values?.length) {
    // Enum from help_variables.json — use desc as label if short, else use name
    e.t = 'enum';
    e.opts = help.values.map(v => ({
      v: v.name,
      l: (v.description && v.description.length <= 40) ? v.description : v.name
    }));
    nType++; nOpts++;
  } else if (help?.type === 'boolean') {
    // Already handled by auto-detect (0/1), but record for accuracy
    e.t = 'bool';
  }
  // float / integer / string → let auto-detect handle it (no override needed)

  if (Object.keys(e).length) META[key] = e;
}

console.log(`META entries: ${Object.keys(META).length}`);
console.log(`  with label : ${nLabel}`);
console.log(`  with desc  : ${nDesc}`);
console.log(`  with type  : ${nType}`);
console.log(`  with opts  : ${nOpts}`);

// ── Build TABS structure ───────────────────────────────────────────────────────
const TAB_DEFS = [
  ['Player',   'settplayer_arr'],
  ['Graphics', 'settfps_arr'],
  ['View',     'settview_arr'],
  ['Controls', 'settbinds_arr'],
  ['Misc',     'settmisc_arr'],
  ['System',   'settsystem_arr'],
  ['Config',   'settconfig_arr'],
];

const TABS = [];
for (const [tabName, arrName] of TAB_DEFS) {
  const arrMatch = menuSrc.match(new RegExp(`setting ${arrName}\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`));
  if (!arrMatch) { console.warn(`Array not found: ${arrName}`); continue; }

  const tab = { n: tabName, secs: [] };
  let curSec = null;

  for (const line of arrMatch[1].split('\n')) {
    const sep = line.match(/ADDSET_SEPARATOR\s*\(\s*"([^"]+)"\s*\)/);
    if (sep) { curSec = { n: sep[1], vars: [], binds: [] }; tab.secs.push(curSec); continue; }
    if (!curSec) continue;

    const bind = line.match(/ADDSET_BIND\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/);
    if (bind) { curSec.binds.push({ l: bind[1], c: bind[2] }); continue; }

    const varM = line.match(/ADDSET_(?:BOOL|BOOLLATE|NUMBER|ENUM|NAMED|COLOR|STRING|SKIN|CUSTOM)\s*\(\s*"[^"]+"\s*,\s*(\w+)/);
    if (varM) curSec.vars.push(toCvarKey(varM[1]));
  }
  TABS.push(tab);
}

// Second pass: add META entries for TABS vars not already in config.cfg
for (const tab of TABS) {
  for (const sec of tab.secs) {
    for (const key of sec.vars) {
      if (META[key]) continue;
      const menu = menuMeta[key];
      if (!menu) continue;
      const e = {};
      if (menu.l) e.l = menu.l;
      if (menu.t === 'palcolor')                    { e.t = 'palcolor'; }
      else if (menu.t === 'color')                  { e.t = 'color'; }
      else if (menu.t === 'number')                 { e.t = 'number'; if (menu.min !== undefined) e.min = menu.min; if (menu.max !== undefined) e.max = menu.max; if (menu.step !== undefined) e.step = menu.step; }
      else if (menu.t === 'enum' && menu.opts?.length) { e.t = 'enum'; e.opts = menu.opts; }
      else if (menu.t === 'bool')                   { e.t = 'bool'; }
      if (Object.keys(e).length) META[key] = e;
    }
  }
}

const totalBinds = TABS.reduce((a,t)=>a+t.secs.reduce((b,s)=>b+s.binds.length,0),0);
const totalVars  = TABS.reduce((a,t)=>a+t.secs.reduce((b,s)=>b+s.vars.length,0),0);
console.log(`TABS: ${TABS.length} tabs, ${TABS.reduce((a,t)=>a+t.secs.length,0)} sections, ${totalVars} vars, ${totalBinds} binds`);

// ── Write output ──────────────────────────────────────────────────────────────
const js = `const META=${JSON.stringify(META)};const TABS=${JSON.stringify(TABS)};`;
const outPath = path.join(BASE, 'meta-generated.js');
fs.writeFileSync(outPath, js, 'utf8');
const kb = (Buffer.byteLength(js, 'utf8') / 1024).toFixed(1);
console.log(`\nWrote: meta-generated.js  (${kb} KB)`);
