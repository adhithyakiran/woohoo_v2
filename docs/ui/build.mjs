import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regenerate the API reference HTML from src/ fragments.
//   node docs/ui/build.mjs
// then render to PDF with headless Chrome:
//   chrome --headless=new --no-pdf-header-footer \
//          --print-to-pdf=docs/ui/Woohoo-V2-UI-UX-Guide.pdf \
//          file:///…/docs/ui/Woohoo-V2-UI-UX-Guide.html

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');

// Code blocks are hand-laid; anything wider than the print area is silently clipped in PDF.
const LIMITS = { ascii: 136, def: 124 };

function checkWidths(html, file) {
  const errs = [];
  for (const m of html.matchAll(/<pre([^>]*)>([\s\S]*?)<\/pre>/g)) {
    const kind = m[1].includes('ascii') ? 'ascii' : 'def';
    const body = m[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&[a-z]+;/g, '?');
    const max = Math.max(...body.split('\n').map((l) => l.length));
    if (max > LIMITS[kind]) errs.push(`${file}: <pre class="${kind}"> is ${max} chars (limit ${LIMITS[kind]})`);
  }
  return errs;
}

const files = readdirSync(srcDir).filter((f) => f.endsWith('.html')).sort();
if (!files.length) {
  console.error('no source fragments found');
  process.exit(1);
}

const parts = files.map((f) => ({ f, html: readFileSync(join(srcDir, f), 'utf8') }));
const errs = parts.flatMap((p) => checkWidths(p.html, p.f));
if (errs.length) {
  console.error(`Code-block width check failed (${errs.length}):`);
  errs.forEach((e) => console.error('  ' + e));
  process.exit(1);
}

const html = parts.map((p) => p.html).join('\n');
const out = join(here, 'Woohoo-V2-UI-UX-Guide.html');
writeFileSync(out, html, 'utf8');

console.log(`assembled ${files.length} fragments -> ${out}`);
console.log(`total ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(0)} KB · all code blocks fit`);
