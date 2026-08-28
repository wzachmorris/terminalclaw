// Markdown-table prettifier for the chat reader. The transcript stores
// Claude's replies as raw markdown, and everything else survives as
// monospace text — but table rows are wider than a phone screen, so each
// row wraps mid-cell and the columns turn to soup. splitMdTables() slices
// a message into plain segments and table blocks; tables come back
// re-padded into aligned columns with box-drawing rules, ready to render
// inside a horizontal scroller so rows never wrap.

export type MdSeg = { table: boolean; text: string };

// a table row: starts with a pipe after optional indent
const isRow = (l: string) => /^\s*\|/.test(l);

// the header/body separator: | --- | :--: | ... (dashes + optional colons)
const isSep = (l: string) => {
  if (!isRow(l)) return false;
  const cells = splitCells(l);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
};

function splitCells(l: string): string[] {
  let s = l.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) =>
    // inline emphasis/code markers just add noise once columns are aligned
    c.trim().replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'));
}

// display columns in a monospace font: CJK and emoji glyphs take two cells
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 0x1100 && (
      c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || c >= 0x1f000
    ) ? 2 : 1;
  }
  return w;
}

type Align = 'l' | 'r' | 'c';

function pad(s: string, w: number, align: Align): string {
  const gap = Math.max(0, w - width(s));
  if (align === 'r') return ' '.repeat(gap) + s;
  if (align === 'c') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + s + ' '.repeat(gap - left);
  }
  return s + ' '.repeat(gap);
}

function formatTable(lines: string[]): string {
  const aligns = splitCells(lines[1]).map((c): Align =>
    c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l');
  const rows = lines.filter((l) => !isSep(l)).map(splitCells);
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(1, ...rows.map((r) => width(r[i] ?? ''))));
  const out = rows.map((r) =>
    widths.map((w, i) => pad(r[i] ?? '', w, aligns[i] ?? 'l')).join(' │ '));
  out.splice(1, 0, widths.map((w) => '─'.repeat(w)).join('─┼─'));
  return out.join('\n');
}

export function splitMdTables(text: string): MdSeg[] {
  const lines = text.split('\n');
  const segs: MdSeg[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length) { segs.push({ table: false, text: plain.join('\n') }); plain = []; }
  };
  for (let i = 0; i < lines.length; ) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const tbl = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) { tbl.push(lines[j]); j++; }
      flush();
      segs.push({ table: true, text: formatTable(tbl) });
      i = j;
    } else {
      plain.push(lines[i]);
      i++;
    }
  }
  flush();
  return segs;
}
