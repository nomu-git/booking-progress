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

async function fetchLeadsWorkbook() {
  const link = (process.env.LEADS_SHEET_URL || '').trim();
  if (!link) throw new Error('LEADS_SHEET_URL is not set');

  const res = await fetch(downloadUrl(link), { redirect: 'follow' });
  if (!res.ok) throw new Error(`Leads sheet download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

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
