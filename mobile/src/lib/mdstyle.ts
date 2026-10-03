// Markdown → display text + style runs for the chat reader. The transcript
// holds Claude's replies as raw markdown; the TUI colors that markdown
// (bold, headings, `code`, bullets) and the reader showed the bare syntax.
// styleMarkdown() strips the markers and returns runs (UTF-16 offsets, as
// NSString counts them) that the native bubble paints as attributed text
// and the RN fallback paints as nested <Text>.
import { C } from './theme';

export type Run = {
  s: number; l: number;
  b?: boolean; i?: boolean; u?: boolean;
  c?: string; bg?: string;
};
export type Styled = { text: string; runs: Run[] };

// the palette the TUI's dark theme reads as: headings bold, code in amber on
// the panel, links accent + underline, list markers accent, quotes muted
const CODE = { c: C.amber, bg: C.panel };
const BLOCK = { bg: C.panel };
const MARK = { c: C.accent };
const LINK = { c: C.accent, u: true };
const QUOTE = { c: C.muted, i: true };
const MUTED = { c: C.muted };

type Style = Omit<Run, 's' | 'l'>;

class Out {
  text = '';
  runs: Run[] = [];
  push(str: string, st?: Style) {
    if (!str) return;
    if (st && Object.keys(st).length) {
      this.runs.push({ s: this.text.length, l: str.length, ...st });
    }
    this.text += str;
  }
}

// inline: `code`, **bold**, *em*, _em_ (word-bounded — snake_case stays),
// [text](url). One pass, leftmost match wins; no nesting (bold inside a
// link etc. is rare in replies and renders as its outer style).
const INLINE = new RegExp(
  '(`[^`\\n]+`)'
  + '|(\\*\\*[^*\\n]+?\\*\\*)'
  + '|(\\*[^*\\s][^*\\n]*?\\*)'
  + '|((?:^|[\\s(])_[^_\\n]+?_(?=[\\s).,;:!?]|$))'
  + '|(\\[[^\\]\\n]+\\]\\([^)\\n]+\\))',
  'g');

function inline(out: Out, text: string, base?: Style) {
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    out.push(text.slice(last, m.index), base);
    const tok = m[0];
    if (m[1]) {
      out.push(tok.slice(1, -1), { ...base, ...CODE });
    } else if (m[2]) {
      out.push(tok.slice(2, -2), { ...base, b: true });
    } else if (m[3]) {
      out.push(tok.slice(1, -1), { ...base, i: true });
    } else if (m[4]) {
      const lead = tok.startsWith('_') ? '' : tok[0];
      out.push(lead, base);
      out.push(tok.slice(lead.length + 1, -1), { ...base, i: true });
    } else if (m[5]) {
      const close = tok.indexOf('](');
      out.push(tok.slice(1, close), { ...base, ...LINK });
    }
    last = m.index + tok.length;
  }
  out.push(text.slice(last), base);
}

export function styleMarkdown(src: string): Styled {
  const out = new Out();
  const lines = src.split('\n');
  let fence = false;
  lines.forEach((line, n) => {
    if (n) out.push('\n');
    if (/^\s*```/.test(line)) {
      fence = !fence;
      // the fence line itself: keep a thin marker so block edges read
      out.push(fence ? '┌─' : '└─', MUTED);
      return;
    }
    if (fence) { out.push(line || ' ', BLOCK); return; }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      inline(out, m[2], { b: true });
    } else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
      out.push(m[1] + '• ', MARK);
      inline(out, m[2]);
    } else if ((m = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line))) {
      out.push(m[1] + m[2] + ' ', MARK);
      inline(out, m[3]);
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      out.push('▎ ', MUTED);
      inline(out, m[1], QUOTE);
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('────────', MUTED);
    } else {
      inline(out, line);
    }
  });
  return { text: out.text, runs: out.runs };
}

// the RN <Text> fallback (binaries without the native bubble): split the
// display text at run boundaries into nested spans
export function toSpans(st: Styled): Array<{ text: string; run?: Run }> {
  const spans: Array<{ text: string; run?: Run }> = [];
  let pos = 0;
  for (const r of st.runs) {
    if (r.s > pos) spans.push({ text: st.text.slice(pos, r.s) });
    spans.push({ text: st.text.slice(r.s, r.s + r.l), run: r });
    pos = r.s + r.l;
  }
  if (pos < st.text.length) spans.push({ text: st.text.slice(pos) });
  return spans;
}
