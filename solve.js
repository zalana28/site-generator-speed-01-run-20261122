// A faster drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
// Byte-exact reimplementation of vendor/makefun-site 1.0.0's build(), written from
// its README.md and reference code, optimised for speed:
//
//  - Markdown inline rendering scans in bulk literal runs instead of escaping
//    one character at a time; the block lexer, front matter and template
//    parser keep the reference's exact rules.
//  - slugify results are memoised per run() call; pure-ASCII inputs skip the
//    NFKD normalisation (ASCII is fixed under NFKD and holds no combining
//    marks); reading time counts words with a char-code scan that matches
//    /\S+/g exactly.
//  - Templates render into an array joined once, with scopes as a chain of
//    null-prototype objects, so a path's first name is one property lookup
//    instead of a scope-chain walk with hasOwn at every step. Includes,
//    loops, truthiness and value formatting follow the reference exactly.
//  - Each post/page card is built once and reused for its layout page.
//  - Nothing is cached from one run() call to the next: every memo and
//    parsed template is created fresh inside run().
//
// Dependency-free ES module. run(input) returns makefun-site 1.0.0's answer.

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let m;
  let out = '';
  let last = 0;
  let found = false;
  while ((m = ESC_RE.exec(text)) !== null) {
    found = true;
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  if (!found) return text;
  return out + text.slice(last);
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;
const TRAILING_DASHES = /-+$/;

function slugifyFactory(cache) {
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    let plain;
    if (!NON_ASCII.test(text)) {
      plain = text;
    } else {
      plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    }
    let out = '';
    let gap = false;
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX).replace(TRAILING_DASHES, '');
    const result = out === '' ? 'untitled' : out;
    cache.set(text, result);
    return result;
  };
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Word count identical to (text.match(/\S+/g) || []).length, without the array. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // JS \s: \t\n\v\f\r space \u00a0 \u1680 \u2000-\u200a \u2028 \u2029 \u202f \u205f \u3000 \ufeff
    const sp =
      c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
      c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
      c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (sp) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/* ------------------------------------------------------------- front matter */

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function stringOf(raw) {
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

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
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
 * A source's front matter and body, or { error } with the first reason it
 * is refused. Same rules as the reference, but the body is sliced, never
 * split and re-joined: only the front-matter lines are walked.
 */
function parseFrontMatter(text) {
  // Line 1 must be exactly '---'.
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  // The closing line: a line exactly '---'. Scan for it; line numbers count
  // from 1 at the opening '---'.
  let closeStart = -1; // offset of the closing line's first '-'
  let closeEnd = -1; // offset just past the closing line's '\n' (or end)
  let search = 3; // the '\n' ending the opening line: a close on line 1 follows it
  while (true) {
    const at = text.indexOf('\n---', search);
    if (at === -1) break;
    const after = at + 4;
    if (after === text.length || text[after] === '\n') {
      closeStart = at + 1;
      closeEnd = after === text.length ? text.length : after + 1;
      break;
    }
    search = at + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1; // the opening '---' is line 1
  let pos = 4; // just past '---\n'
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 || nl > closeStart - 1 ? closeStart - 1 : nl;
    const line = text.slice(pos, lineEnd);
    lineNo++;
    if (FM_BLANK.test(line) || line.startsWith('#')) {
      pos = nl === -1 ? closeStart : nl + 1;
      continue;
    }
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = nl === -1 ? closeStart : nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

/* ---------------------------------------------------------------- markdown */

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  // Only a blank line, a fence, a heading or a thematic break ends a
  // paragraph; all four start with a distinctive first character, so any
  // line starting with anything else continues the paragraph.
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return MD_BLANK.test(line);
  if (c === 96) return MD_FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return MD_HR.test(line);
  return false;
}

/** `line` with spaces and tabs dropped at both ends (the reference's trim). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // A line starting with a space or tab is blank or a paragraph line:
    // no block opener starts with whitespace.
    if (c0 === 32 || c0 === 9) {
      if (MD_BLANK.test(line)) {
        i++;
        continue;
      }
      const body = [trimLine(line)];
      i++;
      while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
      tokens.push({ type: 'paragraph', text: body.join('\n') });
      continue;
    }
    if (c0 === 96) {
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (l.charCodeAt(0) === 96 && MD_FENCE_CLOSE.test(l)) break;
          body.push(l);
          i++;
        }
        i++;
        tokens.push({ type: 'code', lang: fence[1], lines: body });
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (MD_HR.test(line)) {
        tokens.push({ type: 'hr' });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = MD_ORDERED.exec(line);
      if (ordered !== null) {
        const items = [];
        while (i < lines.length) {
          const m = MD_ORDERED.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[2])]);
            i++;
          } else if (MD_CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        tokens.push({ type: 'list', ordered: true, start: Number(ordered[1]), items: items.map((parts) => parts.join('\n')) });
        continue;
      }
    }
    // Bullet lists also start with '-' or '*', checked after the HR test.
    if (c0 === 45 || c0 === 42) {
      const bullet = MD_BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < lines.length) {
          const m = MD_BULLET.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[1])]);
            i++;
          } else if (MD_CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        tokens.push({ type: 'list', ordered: false, start: 1, items: items.map((parts) => parts.join('\n')) });
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const HAS_WS = /\s/;

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Inline rendering: same output as the reference, but the scan jumps from
 *  one markup character to the next with indexOf (C++ speed) and flushes
 *  the plain text between them in one escaped run, instead of stepping
 *  character by character. A markup character that turns out to be literal
 *  stays in the pending run and the scan resumes just past it. */
function inline(s, env) {
  let out = '';
  const n = s.length;
  let i = 0;
  let run = 0;
  while (i < n) {
    let j = n;
    let k = s.indexOf('\\', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && k < j) j = k;
    if (j === n) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > run) out += escapeHtml(s.slice(run, j));
        out += escapeHtml(s[j + 1]);
        i = j + 2;
        run = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const e = s.indexOf('`', j + 1);
      if (e > j + 1) {
        if (j > run) out += escapeHtml(s.slice(run, j));
        out += `<code>${escapeHtml(s.slice(j + 1, e))}</code>`;
        i = e + 1;
        run = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const e = findUnescaped(s, '**', j + 2);
        if (e > j + 2) {
          if (j > run) out += escapeHtml(s.slice(run, j));
          out += `<strong>${inline(s.slice(j + 2, e), env)}</strong>`;
          i = e + 2;
          run = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const e = findSingleStar(s, j + 1);
      if (e > j + 1) {
        if (j > run) out += escapeHtml(s.slice(run, j));
        out += `<em>${inline(s.slice(j + 1, e), env)}</em>`;
        i = e + 1;
        run = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    // c === '['
    const close = findUnescaped(s, ']', j + 1);
    const m = close !== -1 && s[close + 1] === '(' ? s.indexOf(')', close + 2) : -1;
    const target = m === -1 ? '' : s.slice(close + 2, m);
    if (target !== '' && !HAS_WS.test(target)) {
      if (j > run) out += escapeHtml(s.slice(run, j));
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, close), env)}</a>`;
      i = m + 1;
      run = i;
    } else {
      i = j + 1;
    }
  }
  if (n > run) out += escapeHtml(s.slice(run, n));
  return out;
}

function renderMarkdown(src, env, slugify) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`, '\n');
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        blocks.push(`<pre><code${cls}>${t.lines.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>`, '\n');
        break;
      }
      case 'hr':
        blocks.push('<hr>', '\n');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`, '\n');
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        blocks.push(`${open}\n${t.items.map((item) => `<li>${inline(item, env)}</li>\n`).join('')}</${tag}>`, '\n');
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`, '\n');
        break;
      }
    }
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

/* ---------------------------------------------------------------- templates */

const INCLUDE_DEPTH = 8;
const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

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
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
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
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
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

/**
 * Scope is one null-prototype object whose prototype is its parent scope's
 * object, so a path's first name resolves with a single property lookup,
 * exactly as the reference's hasOwn walk up the scope chain (a name bound
 * to undefined in an inner scope still shadows, because the property exists
 * there with the value undefined).
 */
function lookup(scope, path) {
  let v = scope[path[0]];
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** One path segment past the first: the reference's own-property step. */
const segOf = (v, s) => (v === null || typeof v !== 'object' || !Object.hasOwn(v, s) ? undefined : v[s]);

/**
 * The names a template reads that no for-loop of its own binds, with the
 * names its includes read folded in (an include renders in the same scope,
 * so a name its includer binds still counts as read here). Computed with
 * no names bound, so a template whose free names are only site, tags and
 * recent reads nothing that varies from page to page: its output is the
 * same on every render of the case, at the same include depth, and can be
 * memoised per case. A name a for binds in an includer is still free here,
 * so a card that reads its loop's `p` is never memoised.
 */
function freeNamesOf(nodes, bound, into) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) into.add(n.path[0]);
      if (n.kind === 'if') {
        freeNamesOf(n.then, bound, into);
        if (n.else !== null) freeNamesOf(n.else, bound, into);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) into.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      freeNamesOf(n.body, inner, into);
    }
  }
  return into;
}

function cacheableTemplates(parsed) {
  const free = new Map();
  for (const [name, nodes] of parsed) free.set(name, freeNamesOf(nodes, new Set(), new Set()));
  // Fold includes in until stable (cycles converge: sets only grow).
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of parsed) {
      const set = free.get(name);
      const before = set.size;
      const walk = (ns) => {
        for (const n of ns) {
          if (n.kind === 'include') {
            const sub = free.get(n.name);
            if (sub !== undefined) for (const x of sub) set.add(x);
          } else if (n.kind === 'if') {
            walk(n.then);
            if (n.else !== null) walk(n.else);
          } else if (n.kind === 'for') walk(n.body);
        }
      };
      walk(nodes);
      if (set.size !== before) changed = true;
    }
  }
  const ok = new Set();
  for (const [name, set] of free) {
    let good = true;
    for (const x of set) if (x !== 'site' && x !== 'tags' && x !== 'recent') { good = false; break; }
    if (good) ok.add(name);
  }
  return ok;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const child = Object.create(scope);
          child[n.name] = xs[k];
          child.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        if (ctx.cacheable.has(n.name)) {
          // Same template, same depth, same site/tags/recent: same output.
          const key = `${n.name}\n${depth}`;
          let s = ctx.memo.get(key);
          if (s === undefined) {
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            s = tmp.join('');
            ctx.memo.set(key, s);
          }
          out.push(s);
        } else {
          renderNodes(t, scope, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

/* --------------------------------------------------------------------- build */

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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const slugify = slugifyFactory(slugCache);

  // Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');


  // 1. Sources, in code-unit order of path; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal checks, in the reference's order.
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
  sources = kept;

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to pages and static files.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug; newer/older.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
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
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards: one per source, built once, reused by its layout page and by lists.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  const cardOf = (s) => {
    let card = cards.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cards.set(s, card);
    }
    return card;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts: pages, index pages, tag pages, tags index, then statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { templates, cacheable: cacheableTemplates(templates), memo: new Map() };
  const render = (name, vars) => {
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    Object.assign(scope, vars);
    if (ctx.cacheable.has(name)) {
      const key = `${name}\n0`;
      let s = ctx.memo.get(key);
      if (s === undefined) {
        const nodes = templates.get(name);
        if (nodes === undefined) return null;
        const tmp = [];
        renderNodes(nodes, scope, ctx, 0, tmp);
        s = tmp.join('');
        ctx.memo.set(key, s);
      }
      return s;
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
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
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });
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

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
