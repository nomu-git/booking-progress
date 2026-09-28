// Just enough of an .xlsx reader to get cell values out of a workbook, with
// no dependencies — this project runs on Node built-ins alone, and a whole
// spreadsheet library for "read the numbers Marina typed" isn't worth adding
// the first npm install for.
//
// An .xlsx is a zip of XML files. This opens the zip, maps sheet names to
// their XML, resolves shared strings, and turns date-formatted numbers back
// into dates. Formulas aren't evaluated: Excel saves each formula's last
// computed value alongside it, and that cached value is what's returned.
//
// Not handled, because a hand-maintained report doesn't use them: zip64,
// encrypted workbooks, .xls (the pre-2007 binary format).

const zlib = require('zlib');

function unzip(buf) {
  // The central directory, listing every file, sits at the end of the zip;
  // its locator record is in the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an .xlsx file (no zip directory found)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt .xlsx (bad zip directory)');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // The local header repeats the name but can carry a different-length
    // extra field, so the data offset has to be read from it, not assumed.
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    files.set(name, { method, raw: buf.slice(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return (name) => {
    const f = files.get(name.replace(/^\//, ''));
    if (!f) return null;
    if (f.method === 0) return f.raw.toString('utf8');
    if (f.method === 8) return zlib.inflateRawSync(f.raw).toString('utf8');
    throw new Error(`Unsupported compression in ${name}`);
  };
}

const unescapeXml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

const attrOf = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
};

// The text of a string item, joining rich-text runs and skipping the
// phonetic-reading runs (<rPh>) that some East Asian inputs add.
const textOf = (xml) => {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1]);
  return out;
};

// Excel stores a date as a plain number and marks it as a date only through
// the cell's number format. Built-in formats 14–22 and 45–47 are dates;
// custom ones are dates if their pattern has d/m/y outside quoted text.
function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Map();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    custom.set(Number(attrOf(m[0], 'numFmtId')), attrOf(m[0], 'formatCode') || '');
  }
  const isDateFmt = (id) => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const code = custom.get(id);
    if (!code) return false;
    const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    return /[dmy]/i.test(bare);
  };
  const xfs = (stylesXml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/) || [''])[0];
  const out = new Set();
  let index = 0;
  for (const m of xfs.matchAll(/<xf\b[^>]*\/?>/g)) {
    if (isDateFmt(Number(attrOf(m[0], 'numFmtId')))) out.add(index);
    index += 1;
  }
  return out;
}

// Serial day count from 1899-12-30 (Excel's epoch, off by one for the 1900
// leap-year bug it inherited from Lotus — which is why it's the 30th).
const serialToIso = (n) => new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);

// "B12" -> { col: 1, row: 11 }, both zero-based.
function address(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

function readSheet(xml, shared, dates) {
  const grid = [];
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const at = address(attrOf(m[1], 'r') || '');
    if (!at || !m[2]) continue;
    const type = attrOf(m[1], 't');
    const raw = (m[2].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    let value = null;
    if (type === 's') value = raw != null ? shared[Number(raw)] ?? null : null;
    else if (type === 'inlineStr') value = textOf(m[2]);
    else if (type === 'str') value = raw != null ? unescapeXml(raw) : null;
    else if (type === 'b') value = raw === '1';
    else if (type === 'e') value = null; // #DIV/0!, #REF! etc. — no usable value
    else if (raw != null) {
      const n = Number(raw);
      value = dates.has(Number(attrOf(m[1], 's'))) && Number.isFinite(n) ? serialToIso(n) : n;
    }
    if (value === '' || value == null) continue;
    (grid[at.row] || (grid[at.row] = []))[at.col] = value;
  }
  // Holes stay as null so every row is a plain array the caller can index.
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    grid[r] = Array.from({ length: row.length }, (_, c) => (row[c] === undefined ? null : row[c]));
  }
  const merges = [...xml.matchAll(/<mergeCell\b[^>]*ref="([^"]+)"/g)].map((m) => m[1]);
  return { grid, merges };
}

// Buffer -> [{ name, grid, merges }], in the workbook's own tab order.
function readWorkbook(buf) {
  const file = unzip(buf);
  const workbook = file('xl/workbook.xml');
  if (!workbook) throw new Error('Not an .xlsx workbook (no xl/workbook.xml)');

  const rels = new Map();
  for (const m of (file('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*\/?>/g)) {
    rels.set(attrOf(m[0], 'Id'), attrOf(m[0], 'Target'));
  }
  const shared = [...(file('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const dates = dateStyles(file('xl/styles.xml'));

  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const target = rels.get(attrOf(m[0], 'r:id'));
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = file(path);
    if (!xml) continue;
    sheets.push({ name: attrOf(m[0], 'name'), ...readSheet(xml, shared, dates) });
  }
  return sheets;
}

module.exports = { readWorkbook };
