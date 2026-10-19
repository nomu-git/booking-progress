ObjC.import('WebKit'); ObjC.import('AppKit'); ObjC.import('Foundation');
function run(argv) {
  const [page, stubPath, out, W, H, theme, hash, pre] = argv;
  $.NSApplication.sharedApplication;
  const cfg = $.WKWebViewConfiguration.alloc.init;
  let stub = $.NSString.stringWithContentsOfFileEncodingError(stubPath, 4, null).js;
  stub = `window.__VIEW=${JSON.stringify(hash)};try{localStorage.setItem('nomuTheme',${JSON.stringify(theme)})}catch(e){};` + stub;
  cfg.userContentController.addUserScript($.WKUserScript.alloc.initWithSourceInjectionTimeForMainFrameOnly(stub, 0, true));
  const wv = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, Number(W), Number(H)), cfg);
  const win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, Number(W), Number(H)), 0, 2, false);
  win.contentView = wv;
  const html = $.NSString.stringWithContentsOfFileEncodingError(page, 4, null);
  wv.loadHTMLStringBaseURL(html, $.NSURL.URLWithString('https://bookingprogress.vercel.app/#' + hash));
  const spin = (s) => $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(s));
  spin(4);
  let res = null;
  const js = (code) => { res = undefined; wv.evaluateJavaScriptCompletionHandler(code, (r, e) => { res = e && !e.isNil() ? 'ERR ' + e.localizedDescription.js : (r && !r.isNil() ? ObjC.unwrap(r) : null); }); for (let i = 0; i < 50 && res === undefined; i++) spin(0.1); return res; };
  if (pre) { js(pre); spin(1.5); }
  const h = js('document.documentElement.scrollHeight');
  const info = js('JSON.stringify({h: document.documentElement.scrollHeight, view: typeof view, bars: [...document.querySelectorAll(".pv-bar")].filter(b=>b.offsetParent).map(b=>b.textContent), more: [...document.querySelectorAll(".pv-more")].filter(b=>b.offsetParent).map(b=>b.textContent), err: window.__err||null, out: window.__out||null})');
  const fullH = Math.min(Number(h) || Number(H), 6000);
  win.setContentSize($.NSMakeSize(Number(W), fullH)); wv.setFrame($.NSMakeRect(0, 0, Number(W), fullH)); spin(1);
  let done = false;
  const sc = $.WKSnapshotConfiguration.alloc.init;
  wv.takeSnapshotWithConfigurationCompletionHandler(sc, (img, e) => {
    if (img && !img.isNil()) { const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation); rep.representationUsingTypeProperties(4, $({})).writeToFileAtomically(out, true); }
    done = true;
  });
  for (let i = 0; i < 80 && !done; i++) spin(0.1);
  return info;
}
