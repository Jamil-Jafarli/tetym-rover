/**
 * No two scripts on the same page may declare the same name.
 *
 * This is not a style rule. The shared modules are loaded as plain <script>
 * tags, so they all land in one global scope, and a second top-level `const`
 * with the same name is a SyntaxError — not a warning, not a shadow. The
 * offending script and everything after it simply does not run.
 *
 * It cost three broken pages to learn that: pilot.js, sonar.js and analyse.js
 * each defined `const clamp`, so /follow — the page that actually drives the
 * robot — threw on load and had done for as long as sonar.js had existed. It
 * looked fine. The buttons were there. Nothing happened when you pressed them.
 *
 * The unit tests could not catch it because each module is loaded alone; the
 * browser tests catch it now, but only for pages that happen to be opened. This
 * catches it for every page, in a second, with no browser.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  [PASS] ${m}`); }
                       else { fail++; console.log(`  [FAIL] ${m}`); } };

/**
 * Top-level declarations in a script.
 *
 * Deliberately crude — it counts braces to tell top level from nested rather
 * than parsing, because the thing being defended against is a name at column
 * zero, and every one of them in this project is written that way. It reads
 * declarations at depth 0 only, so a `const clamp` inside a function is
 * correctly ignored.
 */
function topLevelNames(src) {
  const names = new Set();
  let depth = 0;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '');
    if (depth === 0) {
      const m = line.match(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/);
      if (m) names.add(m.group ? m.group(1) : m[1]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
    }
    if (depth < 0) depth = 0;
  }
  return names;
}

/** The scripts a page loads, in order: external files then its own inline one. */
function scriptsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<script src="\/([\w.-]+)"><\/script>/g)) {
    out.push({ name: m[1], src: readFileSync(path.join(PUB, m[1]), 'utf8') });
  }
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    out.push({ name: 'inline', src: m[1] });
  }
  return out;
}

const pages = readdirSync(PUB).filter((f) => f.endsWith('.html')).sort();

console.log('\nBir səhifədə eyni ad iki dəfə elan olunmur');
for (const page of pages) {
  const html = readFileSync(path.join(PUB, page), 'utf8');
  const scripts = scriptsOf(html);
  const seen = new Map();
  const clashes = [];
  for (const s of scripts) {
    for (const n of topLevelNames(s.src)) {
      if (seen.has(n)) clashes.push(`${n} — ${seen.get(n)} və ${s.name}`);
      else seen.set(n, s.name);
    }
  }
  ok(clashes.length === 0,
     `${page}  (${scripts.length} skript, ${seen.size} ad)`
     + (clashes.length ? `  ← ${clashes.join('; ')}` : ''));
}

console.log('\nPaylaşılan modullar bir-birinə mane olmur');
{
  // Checked as a set rather than per page, so a new module cannot be written
  // that happens to collide only with a page nobody has opened yet.
  const mods = readdirSync(PUB).filter((f) => f.endsWith('.js')).sort();
  const owner = new Map();
  const clashes = [];
  for (const f of mods) {
    for (const n of topLevelNames(readFileSync(path.join(PUB, f), 'utf8'))) {
      if (owner.has(n)) clashes.push(`${n} — ${owner.get(n)} və ${f}`);
      else owner.set(n, f);
    }
  }
  ok(clashes.length === 0,
     `${mods.length} modul, ${owner.size} ad` + (clashes.length ? `  ← ${clashes.join('; ')}` : ''));
}

console.log('\nHər səhifə mövcud faylları yükləyir');
for (const page of pages) {
  const html = readFileSync(path.join(PUB, page), 'utf8');
  const refs = [...html.matchAll(/<script src="\/([\w.-]+)"><\/script>/g)].map((m) => m[1]);
  const missing = refs.filter((f) => !readdirSync(PUB).includes(f));
  ok(missing.length === 0, `${page} → ${refs.join(', ') || '(yalnız inline)'}`);
}

console.log('\nOxucu üçün: aşkarlayıcının özü işləyir');
{
  // A check that cannot fail is not a check, so the detector is pointed at
  // known-bad and known-good input before it is trusted with the real files.
  const bad = topLevelNames('const a = 1;\nfunction b(){ const a = 2; }\nlet c;');
  ok(bad.has('a') && bad.has('b') && bad.has('c') && bad.size === 3,
     `yalnız üst səviyyə adlar sayılır  (${[...bad].join(', ')})`);
  const nested = topLevelNames('function f() {\n  const hidden = 1;\n}\n');
  ok(!nested.has('hidden'), 'funksiya daxilindəki ad üst səviyyə sayılmır');
  const obj = topLevelNames('const o = {\n  const: 1,\n};\nconst after = 2;');
  ok(obj.has('o') && obj.has('after') && obj.size === 2,
     'obyekt gövdəsindən sonra sayğac düz qayıdır');
}

console.log(fail ? `\nFAILED — ${pass} ok, ${fail} fail`
                 : `\nALL CHECKS PASSED — ${pass} ok, 0 fail`);
process.exit(fail ? 1 : 0);
