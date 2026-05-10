#!/usr/bin/env node
// Generate defaults/default-dm.cfg and defaults/default-ctf.cfg from config.cfg
// Run when the source config gets a meaningful update worth shipping as a starter.
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const src = fs.readFileSync(path.join(BASE, 'config.cfg'), 'utf8');

// Detect line ending used by the source so we preserve it
const eol = src.includes('\r\n') ? '\r\n' : '\n';

// Swap the source comment header BEFORE the global rename
let dm = src.replace(
  /\/\/ PharCyde's config[ \t]*(\r?\n)/,
  `// PharCyde's ezQuake Config Editor — Default Deathmatch starter${eol}// Load this, customize via the editor, then export as your own config.cfg.$1`
);

// Replace personal info with a placeholder name (Name + Teamchat Name fields)
// Excludes the header we just wrote (still contains PharCyde) so it stays intact.
// "Your Name Here" reads as an obvious template — discoverable on first load,
// the user fills it in and exports.
dm = dm.replace(/^name\s+"PharCyde"/m, 'name                                  "Your Name Here"');
dm = dm.replace(/^cl_fakename\s+"PharCyde"/m, 'cl_fakename                           "Your Name Here"');
// Move Forward defaults to w (standard WASD) instead of source's g
dm = dm.replace(/^bind\s+g\s+"\+forward"/m, 'bind w "+forward"');
// Direct 1:1 weapon binds for keys 1-8 — Axe, SG, SSG, NG, SNG, GL, RL, LG.
// Overrides whatever was on those keys in the source config (which may have had
// priority lists, message macros, or empty binds).
for (let n = 1; n <= 8; n++) {
  const re = new RegExp(`^bind\\s+${n}\\s+"[^"]*"`, 'm');
  dm = dm.replace(re, `bind  ${n}             "weapon ${n}"`);
}
// Remove q→weapon 6 and e→weapon 7 from source — keys 1-8 cover them now.
dm = dm.replace(/^bind\s+q\s+"weapon\s+6"/m, 'bind  q             ""');
dm = dm.replace(/^bind\s+e\s+"weapon\s+7"/m, 'bind  e             ""');
// Remove MOUSE2→weapon 8 from source. In DM this leaves MOUSE2 unbound; in CTF the
// hookshot setup will reclaim MOUSE2 via the appended ctfTail.
dm = dm.replace(/^bind\s+MOUSE2\s+"weapon\s+8"/m, 'bind  MOUSE2        ""');
// Sensible windowed-mode resolution defaults — most modern displays handle 1920×1080
// without complaint. Open in windowed mode by default. User can adjust via
// System → Screen Settings after loading.
dm = dm.replace(/^vid_win_width\s+"\d+"/m, 'vid_win_width                         "1920"');
dm = dm.replace(/^vid_win_height\s+"\d+"/m, 'vid_win_height                        "1080"');
dm = dm.replace(/^vid_fullscreen\s+"\d+"/m, 'vid_fullscreen                        "0"');

fs.writeFileSync(path.join(BASE, 'defaults', 'default-dm.cfg'), dm, 'utf8');
console.log(`Wrote: defaults/default-dm.cfg  (${(Buffer.byteLength(dm,'utf8')/1024).toFixed(1)} KB)`);

// CTF variant: same as DM + Hold to grapple hookshot on MOUSE2, with client-side
// previous-weapon tracking. `-hook` calls `_lastweapon`, which gets redefined inline
// inside each weapon bind so it always points at the most recent selection.
// KTX has no server-side previous-weapon impulse — verified in src/weapons.c
// (impulse 69 is not implemented; 10/12 are cycle ops). Inline tracking is the
// only reliable way to swap back on release.
const ctfTail = [
  '',
  '// CTF additions — Hookshot weapon tracking (client-side previous-weapon)',
  'alias _lastweapon "weapon 7 6 5 3 2 4 1"',
  '',
  '// CTF additions — grappling hook bound to MOUSE2 (Hold to grapple style)',
  'alias +hook "impulse 22;+attack"',
  'alias -hook "-attack;_lastweapon"',
  'bind MOUSE2 "+hook"',
  '',
].join(eol);
let ctf = dm.replace(/Default Deathmatch starter/, 'Default CTF starter');
// CTF-specific name overrides — themed default that the user can change after loading
ctf = ctf.replace(/^name\s+"Your Name Here"/m, 'name                                  "Where\'s Our Flag?"');
ctf = ctf.replace(/^cl_fakename\s+"Your Name Here"/m, 'cl_fakename                           "Where\'s Our Flag?"');
// Inline weapon-bind rewrites — append `;alias _lastweapon <same payload>` so each
// weapon press updates _lastweapon. Handles both `impulse N` and `weapon a b c…` forms.
ctf = ctf.replace(
  /^(\s*bind\s+\S+\s+")(impulse\s+[1-8]|weapon\s+[1-8](?:\s+[1-8])*)("\s*)$/gm,
  '$1$2;alias _lastweapon $2$3',
);
ctf = ctf.replace(/(\r?\n)*$/, eol) + ctfTail;

fs.writeFileSync(path.join(BASE, 'defaults', 'default-ctf.cfg'), ctf, 'utf8');
console.log(`Wrote: defaults/default-ctf.cfg (${(Buffer.byteLength(ctf,'utf8')/1024).toFixed(1)} KB)`);
