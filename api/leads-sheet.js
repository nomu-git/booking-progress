// Fetches Marina's leads workbook straight from its OneDrive/SharePoint share
// link, so the Leads tab shows whatever she last saved, with no export step
// in between. The sheet stays the source of truth (docs/LEADS-PLAN.md,
// Phase 1) until counting is automated.

const { readWorkbook } = require('./xlsx');

// A share link opens Excel Online, not the file. SharePoint and OneDrive for
// Business hand back the file itself when download=1 is on the link;
// personal OneDrive (1drv.ms) links go through the shares API instead.
function downloadUrl(link) {
  const url = new URL(link.trim());
  if (/(^|\.)1drv\.ms$|(^|\.)onedrive\.live\.com$/.test(url.hostname)) {
    const token = Buffer.from(url.toString()).toString('base64')
      .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    return `https://api.onedrive.com/v1.0/shares/u!${token}/root/content`;
  }
  url.searchParams.set('download', '1');
  return url.toString();
}

// SharePoint's "Anyone with the link" access is granted by a guest cookie set
// on the first redirect, and the next hop is refused (403) without it. fetch
// doesn't keep cookies across the redirects it follows, so they're followed
// by hand here, carrying every cookie forward.
async function download(url) {
  const jar = new Map();
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    });
    const set = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') || '').split(/,(?=\s*[^;,=\s]+=)/);
    for (const c of set) {
      const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
      if (m) jar.set(m[1], m[2]);
    }
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) {
      url = new URL(next, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Leads sheet download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('Leads sheet download failed: too many redirects');
}

async function fetchLeadsWorkbook() {
  const link = (process.env.LEADS_SHEET_URL || '').trim();
  if (!link) throw new Error('LEADS_SHEET_URL is not set');

  const buf = await download(downloadUrl(link));

  // A link that isn't shared with "Anyone with the link" doesn't fail with an
  // error code: it answers 200 with a Microsoft sign-in page. An .xlsx always
  // starts with the zip signature "PK", so anything else means the sharing is
  // wrong, and saying that is more useful than a zip parse error.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error('Leads sheet link returned a web page instead of the file; it needs to be shared as "Anyone with the link can view"');
  }
  return readWorkbook(buf);
}

module.exports = { fetchLeadsWorkbook, downloadUrl };
