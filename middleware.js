// Login gate for the whole dashboard (Anton, 18 Oct 2026): one shared
// password, no username; a device stays signed in for 30 days, and every
// visit pushes that back another 30 days.
//
// It runs on Vercel in front of everything (page AND data endpoints), not in
// the page, because the site and the repo are public: a gate drawn by the
// page alone would leave every /api/* endpoint open. The password lives only
// in Vercel (DASHBOARD_PASSWORD), never in this public code. Until it's set
// the gate stays off, so a deploy can't lock everyone out.
//
// Session cookie: "<expiry>.<HMAC>" signed with CAMPAIGN_ALERT_SECRET plus
// the password, so changing the password signs every device out.
// Passed through without a login: the alert jobs that carry their own secret
// (cron-job.org, the Vercel cron), any request carrying that secret (the AI
// Adviser reads the dashboard's own endpoints this way), HEAD requests for
// the page (the desktop app's update check; no content is sent), and the
// logo the login page shows, plus the app manifest and service worker that
// let the site be installed as an app (they hold no data).

import { next } from '@vercel/functions/middleware';

export const config = { matcher: '/((?!brand/|favicon).*)' };

const COOKIE = 'nomu_session';
const DAYS = 30;
const OWN_AUTH = ['/api/campaign-alerts', '/api/lead-alerts', '/api/slack-notify'];
const MAX_FAILS = 10; // per IP per 15 minutes

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(exp, key) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(`v1.${exp}`)));
}

function sameText(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function readCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

async function makeCookie(key) {
  const exp = Math.floor(Date.now() / 1000) + DAYS * 86400;
  return { exp, header: `${COOKIE}=${exp}.${await sign(exp, key)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` };
}

async function sessionExp(req, key) {
  const v = readCookie(req, COOKIE);
  if (!v) return 0;
  const [exp, sig] = v.split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return 0;
  return sameText(sig, await sign(exp, key)) ? Number(exp) : 0;
}

// Wrong-password counter per IP, in the same Upstash store as the alerts.
async function failures(ip, add) {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return 0;
  const key = `login-fail:${ip}`;
  const cmds = add ? [['INCR', key], ['EXPIRE', key, '900']] : [['GET', key]];
  try {
    const r = await fetch(`${url}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
    const j = await r.json();
    return Number((j[0] && j[0].result) || 0);
  } catch (e) {
    return 0;
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage(error, status = 200) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>NomuHub CRM · Sign in</title>
<link rel="icon" href="/brand/logo.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#2099ac">
<link rel="apple-touch-icon" href="/brand/icon-192.png">
<style>
  :root { --teal: #2099ac; --teal-dark: #167a8a; --ink: #0f2f38; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; padding: 20px;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: var(--ink);
    background: radial-gradient(circle at 20% 15%, #34b3c5 0, var(--teal) 45%, var(--teal-dark) 100%); }
  .card { width: 100%; max-width: 380px; background: #fff; border-radius: 20px; padding: 34px 30px 28px;
    box-shadow: 0 24px 60px rgba(6, 50, 60, .35); text-align: center; }
  img { width: 84px; height: 84px; border-radius: 16px; display: block; margin: 0 auto 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { margin: 0 0 22px; color: #557580; font-size: 14px; }
  label { display: block; text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #557580; margin-bottom: 6px; }
  .field { position: relative; }
  input[type=password], input[type=text] { width: 100%; padding: 13px 44px 13px 14px; border: 1.5px solid #cfe2e7; border-radius: 12px; font-size: 16px; color: var(--ink); outline: none; }
  input:focus { border-color: var(--teal); box-shadow: 0 0 0 4px rgba(32,153,172,.15); }
  .eye { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); border: 0; background: none; color: #557580; cursor: pointer; font-size: 13px; font-weight: 700; padding: 6px; }
  button.go { width: 100%; margin-top: 16px; padding: 13px; border: 0; border-radius: 12px; background: var(--teal); color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; }
  button.go:hover { background: var(--teal-dark); }
  .err { margin: 14px 0 0; color: #c0352b; font-size: 14px; font-weight: 600; }
  .note { margin: 18px 0 0; color: #7d959e; font-size: 12.5px; }
  .wrap { width: 100%; max-width: 380px; }
  .install { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; padding: 14px; border-radius: 16px; background: rgba(255,255,255,.95); box-shadow: 0 12px 30px rgba(6,50,60,.25); text-align: left; }
  .install[hidden] { display: none; }
  .install .ic { width: 38px; height: 38px; flex: none; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: #e6f4f6; color: var(--teal-dark); }
  .install b { display: block; font-size: 14px; }
  .install span { display: block; font-size: 12.5px; color: #557580; line-height: 1.4; margin-top: 2px; }
  .install .txt { flex: 1; min-width: 0; }
  .install .go2 { padding: 9px 14px; border: 0; border-radius: 10px; background: var(--teal-dark); color: #fff; font-weight: 700; font-size: 14px; cursor: pointer; }
  .install .x { border: 0; background: none; color: #7d959e; font-size: 20px; cursor: pointer; padding: 2px 4px; }
  .howto { margin: 10px 0 0; font-size: 12.5px; color: #0f2f38; background: #e6f4f6; border-radius: 10px; padding: 9px 11px; line-height: 1.45; }
</style></head>
<body>
  <div class="wrap">
  <div class="install" id="inst" hidden>
    <div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg></div>
    <div class="txt"><b>Install NomuHub CRM on this device</b><span>An icon on your desktop or home screen, opening in its own window.</span><div class="howto" id="howto" hidden></div></div>
    <button type="button" class="go2" id="instBtn">Install</button>
    <button type="button" class="x" id="instX" aria-label="Dismiss">×</button>
  </div>
  <form class="card" method="post" action="/login">
    <img src="/brand/logo.png" alt="NomuHub">
    <h1>NomuHub CRM</h1>
    <p class="sub">Enter the team password to continue</p>
    <label for="pw">Password</label>
    <div class="field">
      <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="button" class="eye" id="eye" aria-label="Show password">Show</button>
    </div>
    <input type="hidden" name="to" id="to" value="/">
    <button class="go" type="submit">Sign in</button>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <p class="note">You'll stay signed in on this device for 30 days.</p>
  </form>
  </div>
  <script>
    document.getElementById('to').value = location.pathname + location.search + location.hash;
    document.getElementById('eye').addEventListener('click', function () {
      var i = document.getElementById('pw'); var show = i.type === 'password';
      i.type = show ? 'text' : 'password'; this.textContent = show ? 'Hide' : 'Show';
    });
    // Install as an app (a PWA): Chrome / Edge show their own install prompt;
    // Safari and others get the steps instead. Hidden once installed.
    (function () {
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
      var box = document.getElementById('inst'), how = document.getElementById('howto'), deferred = null;
      var installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
      var hidden = false; try { hidden = localStorage.getItem('nomuInstallHide') === '1'; } catch (e) {}
      if (!installed && !hidden) box.hidden = false;
      addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
      addEventListener('appinstalled', function () { box.hidden = true; });
      function steps() {
        var ua = navigator.userAgent;
        if (/iPhone|iPad|iPod/.test(ua)) return 'On iPhone or iPad: tap the Share button, then "Add to Home Screen".';
        if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return 'In Safari on a Mac: open the File menu and choose "Add to Dock".';
        if (/Firefox/.test(ua)) return "Firefox can\'t install apps. Open this page in Chrome, Edge or Safari to install it.";
        return 'Use the install icon at the right end of the address bar, or the browser menu, then "Install NomuHub CRM".';
      }
      document.getElementById('instBtn').addEventListener('click', function () {
        if (deferred) { deferred.prompt(); deferred.userChoice.then(function () { deferred = null; }); return; }
        how.textContent = steps(); how.hidden = false;
      });
      document.getElementById('instX').addEventListener('click', function () {
        box.hidden = true; try { localStorage.setItem('nomuInstallHide', '1'); } catch (e) {}
      });
    })();
  </script>
</body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default async function middleware(req) {
  const password = (process.env.DASHBOARD_PASSWORD || '').trim();
  if (!password) return next(); // gate off until the password is set in Vercel

  const url = new URL(req.url);
  const path = url.pathname;
  const secret = (process.env.CAMPAIGN_ALERT_SECRET || '').trim();
  const key = `${process.env.SESSION_SECRET || secret}|${password}`;

  if (OWN_AUTH.includes(path) || path === '/manifest.webmanifest' || path === '/sw.js') return next();
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) return next();
  if (req.method === 'HEAD' && (path === '/' || path === '/index.html')) return next();

  if (path === '/logout') {
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  }

  if (path === '/login' && req.method === 'POST') {
    const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
    if (await failures(ip, false) >= MAX_FAILS) return loginPage('Too many tries. Please wait 15 minutes and try again.', 429);
    const form = await req.formData().catch(() => null);
    const given = form ? String(form.get('password') || '') : '';
    let to = form ? String(form.get('to') || '/') : '/';
    if (!to.startsWith('/') || to.startsWith('//') || to.startsWith('/login')) to = '/';
    if (!sameText(given, password)) {
      await failures(ip, true);
      return loginPage('That password is not right. Please try again.', 401);
    }
    const c = await makeCookie(key);
    return new Response(null, { status: 303, headers: { location: to, 'set-cookie': c.header, 'cache-control': 'no-store' } });
  }

  const exp = await sessionExp(req, key);
  if (exp) {
    // Signed in. On a page visit, push the 30 days forward (at most once a day).
    const page = req.method === 'GET' && !path.startsWith('/api/');
    if (page && exp - Date.now() / 1000 < (DAYS - 1) * 86400) {
      const c = await makeCookie(key);
      return next({ headers: { 'set-cookie': c.header } });
    }
    return next();
  }

  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return loginPage('', path === '/' ? 200 : 401);
}
