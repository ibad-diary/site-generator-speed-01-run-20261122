// fast-makefun-site: a faster drop-in for makefun-site 1.0.0.
//
// Same answers, byte for byte, for every input: the same front matter, template
// dialect, Markdown subset, slug rule and report as makefun-site 1.0.0, run
// faster. How it gets there:
//   - templates are compiled once per build into plain JavaScript functions
//     (one function per template, scopes as prototype-chained objects, values
//     looked up by direct property access), instead of walking a node tree
//     through a scope chain on every render;
//   - Markdown is rendered in a single pass over its lines, with no token
//     objects, and inline markup is scanned with one regex for the next
//     special character, copying plain runs in bulk through a single escape
//     pass instead of escaping one character at a time;
//   - cards are built once per page and reused; slugs use native regexes.
//
// The program is a dependency-free ES module: run(input) returns the output
// tree (path -> text) for one site, exactly as makefun-site 1.0.0's build does.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ------------------------------------------------------------------ text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MARK_RE = /\p{M}/gu;
const SLUG_RUN_RE = /[^a-z0-9]+/g;
const SLUG_EDGE_RE = /^-+|-+$/g;
const SLUG_TAIL_RE = /-+$/;
const NON_ASCII_RE = /[^\x00-\x7F]/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), "untitled" when nothing
 * is left. ASCII-only text has no NFKD decomposition and no combining marks,
 * so it skips the normalisation outright.
 */
function slugify(text) {
  let out;
  if (NON_ASCII_RE.test(text)) out = text.normalize('NFKD').replace(MARK_RE, '').toLowerCase();
  else out = text.toLowerCase();
  out = out.replace(SLUG_RUN_RE, '-').replace(SLUG_EDGE_RE, '');
  out = out.slice(0, SLUG_MAX).replace(SLUG_TAIL_RE, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const FM_TRAIL = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The lines are walked
 * by index instead of splitting the whole body, so a long body is never copied
 * into a line array.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing "---" line; its 1-based line number is closeLine.
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let cur = pos;
  let n = 2;
  let closeLine = -1;
  let closeEnd = -1;
  while (cur <= text.length) {
    const eol = text.indexOf('\n', cur);
    const lineEnd = eol === -1 ? text.length : eol;
    if (text.slice(cur, lineEnd) === '---') {
      closeLine = n;
      closeEnd = lineEnd;
      break;
    }
    cur = eol === -1 ? text.length + 1 : eol + 1;
    n++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  cur = pos;
  n = 2;
  while (n < closeLine) {
    const eol = text.indexOf('\n', cur);
    const lineEnd = eol === -1 ? text.length : eol;
    const line = text.slice(cur, lineEnd);
    if (!FM_BLANK.test(line) && !line.startsWith('#')) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${n} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(FM_TRAIL, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    cur = eol === -1 ? text.length + 1 : eol + 1;
    n++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_QUOTE = /^>/;
const MD_QUOTE_STRIP = /^> ?/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const MD_TRIM = /^[ \t]+|[ \t]+$/g;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/**
 * Whether `line` ends a paragraph: a blank line, a fence, a heading or a
 * thematic break. Dispatched on the first character so most lines cost no
 * regex at all.
 */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return MD_BLANK.test(line);
  if (c0 === 96) return line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && MD_FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return MD_HR.test(line);
  return false;
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => line.replace(MD_TRIM, '');

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The next special character an inline scan must handle. */
const INLINE_SPECIAL = /[\\`*\[]/g;
/** Whether a string holds any inline special character at all. */
const INLINE_ANY = /[\\`*\[]/;
/** Whether a string holds any escapable character at all. */
const ESCAPE_ANY = /[&<>"']/;
/** `**` outside a backslash escape, or an escaped pair, while scanning ahead. */
const STRONG_CLOSE = /\*\*|\\./g;
/** `]` outside a backslash escape, or an escaped pair, while scanning ahead. */
const BRACKET_CLOSE = /\]|\\./g;
/** A run of `*`, or an escaped pair, while scanning ahead for emphasis. */
const STAR_RUN = /\*+|\\./g;
const WS_RE = /\s/;

/** The first `**` from `from` outside a backslash escape, or -1. */
function findStrong(s, from) {
  STRONG_CLOSE.lastIndex = from;
  let m;
  while ((m = STRONG_CLOSE.exec(s)) !== null) {
    if (m[0] === '**') return m.index;
  }
  return -1;
}

/** The first `]` from `from` outside a backslash escape, or -1. */
function findBracket(s, from) {
  BRACKET_CLOSE.lastIndex = from;
  let m;
  while ((m = BRACKET_CLOSE.exec(s)) !== null) {
    if (m[0] === ']') return m.index;
  }
  return -1;
}

/**
 * The first single `*` from `from` (one whose run is not `**`) outside an
 * escape, or -1: a run of stars counts only when it is odd, at its last star.
 */
function findEm(s, from) {
  STAR_RUN.lastIndex = from;
  let m;
  while ((m = STAR_RUN.exec(s)) !== null) {
    if (m[0][0] === '*' && m[0].length % 2 === 1) return m.index + m[0].length - 1;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href. Plain runs are copied
 * through one escape pass; only the markup characters are handled one by one.
 */
function inline(s, link) {
  // No markup at all: one escape pass over the whole string.
  if (!INLINE_ANY.test(s)) return escapeHtml(s);
  let out = '';
  let i = 0;
  let start = 0;
  const n = s.length;
  // A plain run is escaped only when it holds an escapable character (most
  // runs hold none, so this skips the replace machinery for them). Written
  // out at each site instead of a closure, so no function is allocated per
  // inline call.
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) break;
    const p = m.index;
    const c = s[p];
    if (c === '\\') {
      if (p + 1 < n && ESCAPABLE.has(s[p + 1])) {
        if (p > start) {
          const run = s.slice(start, p);
          out += ESCAPE_ANY.test(run) ? escapeHtml(run) : run;
        }
        out += s[p + 1] === '>' ? '&gt;' : s[p + 1];
        i = p + 2;
        start = i;
      } else {
        i = p + 1;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) {
        if (p > start) {
          const run = s.slice(start, p);
          out += ESCAPE_ANY.test(run) ? escapeHtml(run) : run;
        }
        out += '<code>' + escapeHtml(s.slice(p + 1, j)) + '</code>';
        i = j + 1;
        start = i;
      } else {
        i = p + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[p + 1] === '*') {
        const j = findStrong(s, p + 2);
        if (j > p + 2) {
          if (p > start) {
            const run = s.slice(start, p);
            out += ESCAPE_ANY.test(run) ? escapeHtml(run) : run;
          }
          out += '<strong>' + inline(s.slice(p + 2, j), link) + '</strong>';
          i = j + 2;
          start = i;
        } else {
          i = p + 2;
        }
        continue;
      }
      const j = findEm(s, p + 1);
      if (j > p + 1) {
        if (p > start) {
          const run = s.slice(start, p);
          out += ESCAPE_ANY.test(run) ? escapeHtml(run) : run;
        }
        out += '<em>' + inline(s.slice(p + 1, j), link) + '</em>';
        i = j + 1;
        start = i;
      } else {
        i = p + 1;
      }
      continue;
    }
    // c === '['
    const k = findBracket(s, p + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS_RE.test(target)) {
      if (p > start) {
        const run = s.slice(start, p);
        out += ESCAPE_ANY.test(run) ? escapeHtml(run) : run;
      }
      out += '<a href="' + escapeHtml(link(target)) + '">' + inline(s.slice(p + 1, k), link) + '</a>';
      i = mm + 1;
      start = i;
    } else {
      i = p + 1;
    }
  }
  if (start < n) {
    const run = s.slice(start);
    out += ESCAPE_ANY.test(run) ? escapeHtml(run) : run;
  }
  return out;
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (every level 2 and 3
 * heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = '';
  let hasExcerpt = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // A space or tab first: a blank line, or paragraph text.
      if (MD_BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        const body = [];
        i++;
        while (i < n && !MD_FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        // '\n' is never escaped, so the whole body escapes in one pass.
        const code = body.length === 0 ? '' : escapeHtml(body.join('\n')) + '\n';
        blocks.push('<pre><code' + (lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"') + '>' + code + '</code></pre>');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (MD_HR.test(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const bullet = MD_BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < n) {
          const mm = MD_BULLET.exec(lines[i]);
          if (mm !== null) {
            items.push(trimLine(mm[1]));
            i++;
          } else if (MD_CONTINUED.test(lines[i])) {
            items[items.length - 1] += '\n' + trimLine(lines[i]);
            i++;
          } else break;
        }
        let html = '<ul>\n';
        for (let k = 0; k < items.length; k++) html += `<li>${inline(items[k], link)}</li>\n`;
        html += '</ul>';
        blocks.push(html);
        continue;
      }
    } else if (c0 === 62) {
      const q = [];
      while (i < n && MD_QUOTE.test(lines[i])) {
        const t = trimLine(lines[i++].replace(MD_QUOTE_STRIP, ''));
        if (t !== '') q.push(t);
      }
      blocks.push(q.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(q.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = MD_ORDERED.exec(line);
      if (ordered !== null) {
        const start = Number(ordered[1]);
        const items = [];
        while (i < n) {
          const mm = MD_ORDERED.exec(lines[i]);
          if (mm !== null) {
            items.push(trimLine(mm[2]));
            i++;
          } else if (MD_CONTINUED.test(lines[i])) {
            items[items.length - 1] += '\n' + trimLine(lines[i]);
            i++;
          } else break;
        }
        let html = (start !== 1 ? `<ol start="${start}">` : '<ol>') + '\n';
        for (let k = 0; k < items.length; k++) html += `<li>${inline(items[k], link)}</li>\n`;
        html += '</ol>';
        blocks.push(html);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (!hasExcerpt) {
      excerpt = html;
      hasExcerpt = true;
    }
    blocks.push(`<p>${html}</p>`);
  }
  // Each block on its own line, a "\n" after the last.
  const html = blocks.length === 0 ? '' : blocks.join('\n') + '\n';
  return { html, toc, excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` past its first name: each next name an own property, else undefined. */
function getProp(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/**
 * A value as escaped text: escapeHtml(textOf(v)) in one call, for the
 * templates' {{ }}. A number or boolean has no escapable character, and an
 * array is escaped once its items are joined.
 */
function escTxt(v) {
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/**
 * A path's lookup as JavaScript over the scope `s`: the first name from the
 * scope chain (a prototype-chained object, so the innermost binding wins),
 * each next name through getProp.
 */
function lookupCode(path) {
  let e = `s.${path[0]}`;
  for (let k = 1; k < path.length; k++) e = `g(${e},${JSON.stringify(path[k])})`;
  return e;
}

/**
 * A node tree analysed for build-constancy: which first names it reads that
 * no enclosing for binds (`free`), which templates it includes, which loop
 * names it binds, and whether every for iterates a build-constant collection
 * (`site`, `tags`, `recent`, or a value bound by such a for).
 */
function analyzeTemplate(nodes) {
  const free = new Set();
  const includes = [];
  const loopNames = new Set();
  let allForsConstant = true;
  const walk = (ns, bound, constBound) => {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        walk(n.then, bound, constBound);
        if (n.else !== null) walk(n.else, bound, constBound);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        const collConst = n.path[0] === 'site' || n.path[0] === 'tags' || n.path[0] === 'recent' || constBound.has(n.path[0]);
        if (!collConst) allForsConstant = false;
        loopNames.add(n.name);
        const nb = new Set(bound);
        nb.add(n.name);
        const ncb = new Set(constBound);
        if (collConst) ncb.add(n.name);
        walk(n.body, nb, ncb);
      } else if (n.kind === 'include') {
        includes.push(n.name);
      }
    }
  };
  walk(nodes, new Set(), new Set());
  return { free, includes, loopNames, allForsConstant };
}

/**
 * An include of a build-constant template: render it from the cache when the
 * cached render (taken at depth 0) is valid at this depth, else render it.
 * The cache is valid while the include-depth cap cannot bind differently
 * than it did at depth 0: at caller depth `d`, with `L` the longest include
 * chain below the template, that is `d + L <= 7`.
 */
function incConst(T, C, name, s, o, d, L) {
  if (d >= INCLUDE_DEPTH) return;
  if (d + L <= INCLUDE_DEPTH - 1) {
    const cs = C.get(name);
    if (cs !== undefined) {
      o.push(cs);
      return;
    }
  }
  const f = T.get(name);
  if (f !== undefined) f(s, o, d + 1);
}

/** A node tree compiled into JavaScript statements appended to `out`. */
function compileNodes(nodes, out, counter, ctx) {
  for (const n of nodes) {
    if (n.kind === 'text') out.push(`o.push(${JSON.stringify(n.text)});`);
    else if (n.kind === 'var') out.push(`o.push(etx(${lookupCode(n.path)}));`);
    else if (n.kind === 'raw') out.push(`o.push(txt(${lookupCode(n.path)}));`);
    else if (n.kind === 'if') {
      out.push(`if(tru(${lookupCode(n.path)})!==${n.not ? 'true' : 'false'}){`);
      compileNodes(n.then, out, counter, ctx);
      if (n.else !== null) {
        out.push('}else{');
        compileNodes(n.else, out, counter, ctx);
      }
      out.push('}');
    } else if (n.kind === 'for') {
      const id = counter.n++;
      const a = `_a${id}`;
      const c = `_c${id}`;
      const l = `_l${id}`;
      const ii = `_i${id}`;
      out.push(`{const ${a}=${lookupCode(n.path)};if(Array.isArray(${a})){const ${c}=Object.create(s);const ${l}={index:0,first:false,last:false,length:${a}.length};for(let ${ii}=0;${ii}<${a}.length;${ii}++){${c}.${n.name}=${a}[${ii}];${c}.loop=${l};${l}.index=${ii}+1;${l}.first=${ii}===0;${l}.last=${ii}===${a}.length-1;{const s=${c};`);
      compileNodes(n.body, out, counter, ctx);
      out.push('}}}}');
    } else if (n.kind === 'include') {
      if (ctx.isConst.get(n.name) === true) {
        out.push(`ic(T,C,${JSON.stringify(n.name)},s,o,d,${ctx.chainLen.get(n.name) ?? 0});`);
      } else {
        out.push(`if(d<${INCLUDE_DEPTH}){const _f=T.get(${JSON.stringify(n.name)});if(_f!==undefined)_f(s,o,d+1);}`);
      }
    }
  }
}

/**
 * One template compiled to a render function (scope, out, depth). The
 * helpers are bound by the wrapper, so an include sees the same template map
 * the build filled and the same constant-partial cache.
 */
function compileTemplate(nodes, ctx, templates, constCache) {
  const out = [];
  compileNodes(nodes, out, { n: 0 }, ctx);
  const fn = new Function('s', 'o', 'd', 'T', 'C', 'ic', 'etx', 'txt', 'g', 'tru', out.join(''));
  return (s, o, d) => fn(s, o, d, templates, constCache, incConst, escTxt, textOf, getProp, truthy);
}

/**
 * Which templates are build-constant: rendered once per build and reused.
 * A template is constant when it only reads `site`, `tags` and `recent`,
 * every for iterates one of those (or a value bound by such a for), every
 * template it includes is constant, and its include chain is finite. It is
 * only safe when no loop anywhere binds `site`, `tags` or `recent` (such a
 * loop would shadow the build-level values inside an include).
 */
function computeConstancy(parsed, analyzed) {
  let cacheOk = true;
  for (const m of analyzed.values()) {
    if (m.loopNames.has('site') || m.loopNames.has('tags') || m.loopNames.has('recent')) {
      cacheOk = false;
      break;
    }
  }
  // The longest include chain below each template (Infinity on a cycle).
  const chainLen = new Map();
  const visiting = new Set();
  const chainOf = (name) => {
    if (chainLen.has(name)) return chainLen.get(name);
    if (visiting.has(name)) return Infinity;
    const m = analyzed.get(name);
    if (m === undefined) return 0;
    visiting.add(name);
    let L = 0;
    for (const inc of m.includes) {
      const c = chainOf(inc);
      if (c === Infinity) {
        L = Infinity;
        break;
      }
      if (c + 1 > L) L = c + 1;
    }
    visiting.delete(name);
    chainLen.set(name, L);
    return L;
  };
  const isConst = new Map();
  for (const [name, m] of analyzed) {
    let ok = cacheOk && m.allForsConstant && chainOf(name) !== Infinity;
    if (ok) {
      for (const f of m.free) {
        if (f !== 'site' && f !== 'tags' && f !== 'recent') {
          ok = false;
          break;
        }
      }
    }
    isConst.set(name, ok);
  }
  // A template is constant only when everything it includes is constant.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, m] of analyzed) {
      if (isConst.get(name)) {
        for (const inc of m.includes) {
          if (isConst.get(inc) === false) {
            isConst.set(name, false);
            changed = true;
            break;
          }
        }
      }
    }
  }
  return { isConst, chainLen };
}

// --------------------------------------------------------------------- build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// ASCII whitespace lookup: space, tab, LF, VT, FF, CR.
const WS8 = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS8[c] = 1;

/**
 * The words of a body: its runs of characters other than whitespace. Counted
 * in one scan without building the array a match would allocate. ASCII
 * characters (nearly all of a body) take a table lookup; the rare non-ASCII
 * character takes the full Unicode whitespace check.
 */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      if (WS8[c] === 1) inWord = false;
      else if (!inWord) {
        inWord = true;
        count++;
      }
    } else {
      const ws = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
      if (ws) inWord = false;
      else if (!inWord) {
        inWord = true;
        count++;
      }
    }
  }
  return count;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const constCache = new Map();
  const report = [];
  // Parse every template first: constancy is a property of the whole set.
  const parsed = new Map();
  const analyzed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      parsed.set(name, nodes);
      analyzed.set(name, analyzeTemplate(nodes));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const { isConst, chainLen } = computeConstancy(parsed, analyzed);
  for (const [name, nodes] of parsed) {
    templates.set(name, compileTemplate(nodes, { isConst, chainLen }, templates, constCache));
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped,
  // and so is a draft. The checks run in order; the first that fails is the
  // one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files
  // they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older
  // neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  // Tag names repeat across a site; their slugs are computed once.
  const slugCache = new Map();
  const slugCached = (name) => {
    let s = slugCache.get(name);
    if (s === undefined) {
      s = slugify(name);
      slugCache.set(name, s);
    }
    return s;
  };
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugCached(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugCached(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugCached(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A page's link record as templates read it.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  // A post's card, as lists show it (built once per page and reused).
  const cards = new Map();
  const cardOf = (s) => {
    let c = cards.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cards.set(s, c);
    }
    return c;
  };

  // A page as its layout reads it.
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // A tag as templates read it (its posts as cards).
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  // The build-constant partials, rendered once: they only read site, tags
  // and recent, so every page reuses the same strings.
  const constScope = Object.create(null);
  constScope.site = site;
  constScope.tags = allTags;
  constScope.recent = recent;
  for (const name of templates.keys()) {
    if (isConst.get(name) === true) {
      const out = [];
      templates.get(name)(constScope, out, 0);
      constCache.set(name, out.join(''));
    }
  }
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    scope.page = vars.page;
    scope.posts = vars.posts;
    scope.pager = vars.pager;
    scope.tag = vars.tag;
    fn(scope, out, 0);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
