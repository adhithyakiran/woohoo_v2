import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');

// Glyphs Chrome resolves to a proportional fallback font, which breaks box-drawing
// alignment inside <pre>. Single-char swaps keep every diagram's column count intact.
const SWAP = { '\u{1F464}': 'o', '★': '*', '⇄': '/', '⚠': '!', '⇒': '=>' };
// Circled digits are only ~6% narrow; wrap them instead of losing the cross-reference to §8.
const CIRCLED = /[①-⑫]/g;

function normalisePre(html) {
  let swaps = 0, wraps = 0;
  const out = html.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/g, (_, attrs, body) => {
    for (const [from, to] of Object.entries(SWAP)) {
      const n = body.split(from).length - 1;
      if (n) { swaps += n; body = body.split(from).join(to); }
    }
    body = body.replace(CIRCLED, (c) => { wraps++; return `<span class="mw">${c}</span>`; });
    return `<pre${attrs}>${body}</pre>`;
  });
  return { out, swaps, wraps };
}

// Box-drawing diagrams are hand-drawn, so a stray space silently ruins a frame in print.
// Fail the build instead of shipping a ragged diagram.
function checkAlignment(html, file) {
  const dec = s => s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
  const errs = [];
  const re = /<pre class="ascii">([\s\S]*?)<\/pre>/g;
  let m, blk = 0;
  while ((m = re.exec(html))) {
    blk++;
    const lines = dec(m[1]).split('\n');
    const outer = lines.map(l => [...l]).filter(a => '║╔╠╚'.includes(a[0]));
    if (outer.length) {
      const widths = new Set(outer.map(a => a.length));
      if (widths.size > 1) errs.push(`${file} blk${blk}: outer frame widths ${[...widths].join('/')}`);
    }
    let open = null;
    lines.forEach((l, i) => {
      const a = [...l];
      let j = a.length - 1;
      while (j >= 0 && (a[j] === ' ' || a[j] === '║')) j--;
      const ch = a[j];
      if (ch === '┐') { open = { col: j, at: i + 1 }; return; }
      if (!open) return;
      if (ch === '┘' || ch === '│') {
        if (j !== open.col) errs.push(`${file} blk${blk} L${i + 1}: ${ch}@${j} != ┐@${open.col} (box opened L${open.at})`);
        if (ch === '┘') open = null;
      }
    });
  }
  return errs;
}

const files = readdirSync(srcDir).filter(f => f.endsWith('.html')).sort();
if (!files.length) { console.error('no source fragments found'); process.exit(1); }

const alignErrs = files.flatMap(f => checkAlignment(readFileSync(join(srcDir, f), 'utf8'), f));
if (alignErrs.length) {
  console.error(`ASCII frame alignment failed (${alignErrs.length}):`);
  alignErrs.slice(0, 20).forEach(e => console.error('  ' + e));
  process.exit(1);
}

let swaps = 0, wraps = 0;
const html = files.map(f => {
  const r = normalisePre(readFileSync(join(srcDir, f), 'utf8'));
  swaps += r.swaps; wraps += r.wraps;
  return r.out;
}).join('\n');

const out = join(here, 'Woohoo-V2-Architecture.html');
writeFileSync(out, html, 'utf8');

console.log(`assembled ${files.length} fragments -> ${out}`);
console.log(`glyph swaps: ${swaps}, circled-digit wraps: ${wraps}`);
console.log(`total ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(0)} KB`);
