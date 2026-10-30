// Verifies every UI string passed to t('…') or msg('…') has a Turkish translation.
//   bun scripts/check-i18n.ts            → fails (exit 1) on missing keys
//   bun scripts/check-i18n.ts --missing  → prints missing keys as a JSON array
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../src/locales/tr';

const root = join(import.meta.dir, '..', 'src');
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !p.includes('/locales/')) files.push(p);
  }
};
walk(root);

const CALL = /\b(?:t|msg)\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
const used = new Map<string, string>();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(CALL)) {
    const key = m[2].replace(/\\(['"\\])/g, '$1');
    if (!used.has(key)) used.set(key, f.slice(root.length + 1));
  }
}

const missing = [...used.keys()].filter((k) => !(k in tr));
const unused = Object.keys(tr).filter((k) => !used.has(k));

if (process.argv.includes('--missing')) {
  console.log(JSON.stringify(missing, null, 2));
  process.exit(0);
}

console.log(`i18n: ${used.size} strings, ${Object.keys(tr).length} Turkish entries`);
if (unused.length) console.log(`  unused tr keys (${unused.length}):\n` + unused.map((k) => `    ${JSON.stringify(k)}`).join('\n'));
if (missing.length) {
  console.error(`  missing tr keys (${missing.length}):\n` + missing.map((k) => `    ${JSON.stringify(k)}  (${used.get(k)})`).join('\n'));
  process.exit(1);
}
console.log('  all strings translated ✓');
