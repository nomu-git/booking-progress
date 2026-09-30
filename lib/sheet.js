// Fetches a workbook straight from its OneDrive/SharePoint share link, so a
// tab shows whatever its owner last saved, with no export step in between.
// Every sheet-mirror tab comes through here: Leads (Marina's workbook),
// Engagements (Maryam's), Trips & R&D and Feedback. Each link lives in its
// own env var and is shared as "Anyone with the link can view".

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

// envVar names the env var holding the share link. The link itself never
// goes in the code: the repo is public, and anyone with it can open the sheet.
async function fetchWorkbook(envVar) {
  const link = (process.env[envVar] || '').trim();
  if (!link) throw new Error(`${envVar} is not set`);

  const buf = await download(downloadUrl(link));

  // A link that isn't shared with "Anyone with the link" doesn't fail with an
  // error code: it answers 200 with a Microsoft sign-in page. An .xlsx always
  // starts with the zip signature "PK", so anything else means the sharing is
  // wrong, and saying that is more useful than a zip parse error.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`The ${envVar} link returned a web page instead of the file; it needs to be shared as "Anyone with the link can view"`);
  }
  return readWorkbook(buf);
}

module.exports = { fetchWorkbook, downloadUrl };
