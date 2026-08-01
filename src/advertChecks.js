// Pure content checks for the advert failsafe, ported 1:1 from the YAGPDB
// consolidated advert commands (group_advert / 1x1_advert / quick_advert) so
// behaviour matches during a YAGPDB outage. No I/O here — just string logic,
// which keeps it unit-testable.

// Code-point length (YAGPDB's toRune length), for the character limit.
function runeLength(str) {
  return [...(str || '')].length;
}

// Whitespace-delimited word count, for the quick-channel word limit.
function wordCount(str) {
  const t = (str || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

// Whole-word, case-insensitive banned-word hits, de-duplicated and wrapped in
// ||spoilers|| exactly like the templates' advisory line.
function bannedHits(content, banned) {
  if (!banned || !banned.length) return [];
  const escaped = banned.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
  const hits = (content || '').match(re) || [];
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const k = h.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(`||${h}||`);
    }
  }
  return out;
}

// Discord's heading rule (client regex "^ *#{1,3}\s+...") is looser than a
// plain startsWith("#"):
//   • leading spaces still render        "  # TITLE"
//   • any whitespace may follow the #s   "#<tab>TITLE"
//   • headings render INSIDE blockquotes "> # TITLE", ">>> # TITLE"
// An ad evaded the header rules by quoting every header line, so strip one
// level of quote markup before testing. Quotes don't nest ("> > # x" stays
// literal) and ">>> " doesn't require the space, so one strip pass matches
// what Discord actually shows.
const QUOTE_RE = /^ *(?:>>>\s*|>\s+)/;
// 1-3 #'s (4+ render literally) then whitespace + text, or a bare marker with
// nothing after it — Discord then renders the NEXT line as the heading text.
const HEADER_RE = /^ *(#{1,3})(?:\s+(\S.*?))?\s*$/;

// {level, body} when the line renders as a heading, else null.
// body === '' means a bare marker (heading text comes from the next line).
function headerMatch(line) {
  const m = HEADER_RE.exec((line || '').replace(QUOTE_RE, ''));
  return m ? { level: m[1].length, body: m[2] || '' } : null;
}

// A line is a header if it renders as one, or is a bare #/##/### marker.
function isHeaderLine(line) {
  return headerMatch(line) !== null;
}

// 1x1 / quick rule: any header line at all is disallowed.
function hasAnyHeader(content) {
  return (content || '').split('\n').some(isHeaderLine);
}

// Group rule: at most ONE header line, each within its size cap (# ≤50, ## ≤60,
// ### ≤70), counting a custom emoji <:name:id> as a single glyph. A bare marker
// line is stitched to the following line for the count + cap. Returns true if
// the post breaks the rule (too many headers or one too long).
function groupHeaderIssue(content) {
  const lines = (content || '').split('\n');
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const m = headerMatch(lines[i]);
    if (!m) continue;
    let body = m.body;
    if (!body) {
      const next = i + 1 < lines.length ? lines[i + 1] : '';
      body = next.replace(QUOTE_RE, '').trim();
      if (!body) continue;
    }
    headers.push({ level: m.level, body });
  }
  if (headers.length > 1) return true;
  for (const h of headers) {
    const cap = h.level === 3 ? 70 : h.level === 2 ? 60 : 50;
    const body = h.body.replace(/<a?:\w+:\d+>/g, 'x');
    if (runeLength(body) > cap) return true;
  }
  return false;
}

// Any http(s) link present (quick channels disallow links).
function linkPresent(content) {
  return /https?:\/\/\S+/i.test(content || '');
}

// Normalize for cross-channel duplicate comparison: lowercase, drop URLs, strip
// to [a-z0-9 ], collapse whitespace. Matches the templates' normalization.
function normalizeForDupe(content) {
  let s = (content || '').toLowerCase();
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  s = s.replace(/[^a-z0-9 ]+/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

module.exports = {
  runeLength,
  wordCount,
  bannedHits,
  headerMatch,
  isHeaderLine,
  hasAnyHeader,
  groupHeaderIssue,
  linkPresent,
  normalizeForDupe,
};
