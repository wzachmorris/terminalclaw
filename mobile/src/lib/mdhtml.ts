// Inline-HTML detector for the chat reader. Replies sometimes carry HTML
// meant to be SEEN, not read: a ```html fence, a whole bare document, or —
// the common agent habit — prose followed by a self-contained styled <div>
// block. splitHtml() slices a message into text segments and html segments;
// the chat view renders html segments in an embedded web view instead of
// showing a wall of tag soup.

export type HtmlSeg = { html: boolean; text: string };

// a line that starts an HTML block: document roots or block-level containers
// agents actually emit. Deliberately not every tag — inline mentions of
// <code> etc. in prose must stay prose.
const OPEN = new RegExp(
  '^\\s*<(!doctype|html|head|body|style|div|table|section|article|main|'
  + 'header|footer|figure|svg|form|ul|ol|h[1-6]|p)\\b', 'i');

export function splitHtml(text: string): HtmlSeg[] {
  const lines = text.split('\n');
  const segs: HtmlSeg[] = [];
  let buf: string[] = [];
  const flushText = () => {
    if (buf.join('').trim()) segs.push({ html: false, text: buf.join('\n') });
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code: an ```html fence is an html segment (fence stripped);
    // any other fence is opaque text — never scan inside it for tags
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) j++;
      const inner = lines.slice(i + 1, j);
      if (fence[1].toLowerCase() === 'html' && inner.join('').trim()) {
        flushText();
        segs.push({ html: true, text: inner.join('\n') });
      } else {
        buf.push(...lines.slice(i, Math.min(j + 1, lines.length)));
      }
      i = j + 1;
      continue;
    }

    const m = OPEN.exec(line);
    if (m) {
      const tag = m[1].toLowerCase();
      const block = [line];
      let j = i + 1;
      if (tag === '!doctype' || tag === 'html') {
        while (j < lines.length) { block.push(lines[j]); j++; }
      } else {
        // track nesting of the OPENING tag only (<div…</div>) — enough to
        // find where the block ends without a real parser
        const openRe = new RegExp('<' + tag + '\\b', 'gi');
        const closeRe = new RegExp('</' + tag + '\\s*>', 'gi');
        const depthOf = (l: string) =>
          (l.match(openRe) ?? []).length - (l.match(closeRe) ?? []).length;
        let depth = depthOf(line);
        while (j < lines.length && depth > 0) {
          block.push(lines[j]);
          depth += depthOf(lines[j]);
          j++;
        }
      }
      flushText();
      segs.push({ html: true, text: block.join('\n') });
      i = j;
      continue;
    }

    buf.push(line);
    i++;
  }
  flushText();
  return segs;
}
