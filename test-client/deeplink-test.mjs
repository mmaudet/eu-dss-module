#!/usr/bin/env node
// EU-DSS Sign — deep-link round-trip test client (sign + verify).
//
// Simulates an external web app that asks EU-DSS Sign, via the `eudss://` deep
// link, to (1) SIGN a document and (2) VALIDATE that signed document, receiving
// the result back on a callback each time.
//
//   node deeplink-test.mjs [port]      (default port 8787, or $PORT)
//
// Open http://localhost:<port>, then:
//   • "Signer avec EU-DSS"            → app signs /doc.pdf, posts the signed doc back.
//   • "Valider le dernier signé"      → app validates that signed doc, posts the report back.
// Signed files are saved to ./received/.
//
// NOTE: the app must be INSTALLED (or `tauri dev` running on Linux/Windows) so the
// `eudss://` scheme is registered with the OS. On macOS, deep links resolve only to
// a built/installed `.app` (the scheme lives in its Info.plist).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || process.argv[2] || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECV_DIR = path.join(__dirname, 'received');
fs.mkdirSync(RECV_DIR, { recursive: true });

const signResults = new Map();   // state -> { signedFileName, size, file }
const verifyResults = new Map(); // state -> { signatureCount, signatures, ok }
let lastSigned = null;           // { name, bytes } — most recent signed document

/* ── Generate a minimal but valid PDF (DSS must be able to parse it) ───────── */
function makeMinimalPdf(title = 'EU-DSS deep-link test') {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 18 Tf 20 80 Td (${esc(title)}) Tj ET`;
  const objs = [
    `<</Type/Catalog/Pages 2 0 R>>`,
    `<</Type/Pages/Kids[3 0 R]/Count 1>>`,
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>`,
    `<</Length ${Buffer.byteLength(stream, 'latin1')}>>\nstream\n${stream}\nendstream`,
    `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`,
  ];
  let pdf = `%PDF-1.4\n`;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ` 00000 n \n`;
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
const PDF = makeMinimalPdf();

/* ── The page ──────────────────────────────────────────────────────────────── */
const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EU-DSS — test deep-link</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 660px; margin: 6vh auto; padding: 0 20px; }
  h1 { font-size: 1.35rem; } h2 { font-size: 1.05rem; margin-top: 2em; }
  button { font: inherit; font-weight: 600; padding: .7em 1.3em; border: 0; border-radius: 10px;
           background: #2563eb; color: #fff; cursor: pointer; }
  button:hover { background: #1d4ed8; } button:disabled { opacity: .45; cursor: not-allowed; }
  button.alt { background: #0e7490; } button.alt:hover { background: #155e75; }
  code, pre { background: rgba(127,127,127,.15); border-radius: 6px; padding: .15em .4em; }
  pre { padding: .8em; overflow-x: auto; white-space: pre-wrap; word-break: break-all; font-size: .85em; }
  .out { margin-top: .9em; padding: 1em; border-radius: 10px; background: rgba(127,127,127,.1); min-height: 1.4em; }
  .muted { color: #888; font-size: .9em; }
</style></head><body>
<h1>🖊️ EU-DSS Sign — test du deep-link</h1>
<p>Ce client simule un site externe qui demande, via <code>eudss://</code>, la
<b>signature</b> puis la <b>validation</b> d'un document, et reçoit le résultat sur un callback.</p>

<h2>1. Signer</h2>
<p><button id="sign">Signer avec EU-DSS</button></p>
<pre id="signLink">—</pre>
<div class="out" id="signOut">En attente.</div>

<h2>2. Valider</h2>
<p class="muted">Disponible après une signature (on valide le document qu'on vient de signer).</p>
<p><button id="verify" class="alt" disabled>Valider le dernier document signé</button></p>
<pre id="verifyLink">—</pre>
<div class="out" id="verifyOut">En attente d'une signature.</div>

<p class="muted">Les documents signés sont enregistrés dans <code>test-client/received/</code>.</p>
<script>
  const base = location.origin;
  const $ = (id) => document.getElementById(id);

  function poll(url, state, onReady, onTimeout) {
    const started = Date.now();
    const timer = setInterval(async () => {
      let j; try { j = await (await fetch(url + '?state=' + encodeURIComponent(state))).json(); }
      catch { return; }
      if (j.ready) { clearInterval(timer); onReady(j); }
      else if (Date.now() - started > 180000) { clearInterval(timer); onTimeout(); }
    }, 1000);
  }

  $('sign').onclick = () => {
    const state = crypto.randomUUID();
    const link = 'eudss://sign?doc_url=' + encodeURIComponent(base + '/doc.pdf')
      + '&callback_url=' + encodeURIComponent(base + '/callback')
      + '&state=' + encodeURIComponent(state);
    $('signLink').textContent = link;
    $('signOut').textContent = '⏳ Ouverture de EU-DSS Sign… confirmez + PIN dans l\\'app.';
    location.href = link;
    poll('/result', state,
      (j) => {
        $('signOut').innerHTML = '✅ Document signé reçu : <b>' + j.signedFileName + '</b> ('
          + j.size + ' octets) — <a href="' + j.url + '">télécharger</a>';
        $('verify').disabled = false;
        $('verifyOut').textContent = 'Prêt à valider : ' + j.signedFileName;
      },
      () => $('signOut').textContent = '⌛ Timeout : aucun callback de signature en 3 min.');
  };

  $('verify').onclick = () => {
    const state = crypto.randomUUID();
    const link = 'eudss://verify?doc_url=' + encodeURIComponent(base + '/last-signed')
      + '&callback_url=' + encodeURIComponent(base + '/verify-callback')
      + '&state=' + encodeURIComponent(state);
    $('verifyLink').textContent = link;
    $('verifyOut').textContent = '⏳ Ouverture de EU-DSS Sign… confirmez la validation dans l\\'app.';
    location.href = link;
    poll('/verify-result', state,
      (j) => {
        const rows = (j.signatures || []).map((s) =>
          '• ' + (s.signedBy || '?') + ' — <b>' + s.indication + '</b>'
          + (s.signingDate ? ' (' + s.signingDate + ')' : '')).join('<br>');
        $('verifyOut').innerHTML = (j.ok ? '✅' : '⚠️') + ' Rapport reçu — '
          + j.signatureCount + ' signature(s)<br>' + rows;
      },
      () => $('verifyOut').textContent = '⌛ Timeout : aucun callback de validation en 3 min.');
  };
</script></body></html>`;

/* ── Server ────────────────────────────────────────────────────────────────── */
function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 60 * 1024 * 1024) req.destroy(); });
  req.on('end', () => cb(body));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (req.method === 'GET' && u.pathname === '/doc.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="contrat-demo.pdf"' });
    return res.end(PDF);
  }
  // Most recent signed document — used as doc_url for the verify deep link.
  if (req.method === 'GET' && u.pathname === '/last-signed') {
    if (!lastSigned) { res.writeHead(409); return res.end('aucun document signé pour le moment'); }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `inline; filename="${lastSigned.name.replace(/"/g, '')}"`,
    });
    return res.end(lastSigned.bytes);
  }
  // Sign callback — receives the signed document.
  if (req.method === 'POST' && u.pathname === '/callback') {
    return readBody(req, (body) => {
      try {
        const j = JSON.parse(body);
        const bytes = Buffer.from(j.signedDocumentBase64 || '', 'base64');
        const safe = (j.signedFileName || 'signed.bin').replace(/[^\w.\-]/g, '_');
        const fname = `${Date.now()}-${safe}`;
        fs.writeFileSync(path.join(RECV_DIR, fname), bytes);
        lastSigned = { name: j.signedFileName || 'document-signe', bytes };
        if (j.state) signResults.set(j.state, { signedFileName: j.signedFileName, size: bytes.length, file: fname });
        console.log(`✅ sign     state=${j.state}  ${j.signedFileName}  (${bytes.length} octets)  -> received/${fname}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { console.error('sign callback error:', e); res.writeHead(400); res.end(String(e)); }
    });
  }
  // Verify callback — receives the validation report.
  if (req.method === 'POST' && u.pathname === '/verify-callback') {
    return readBody(req, (body) => {
      try {
        const j = JSON.parse(body);
        const sigs = j.signatures || [];
        const ok = sigs.length > 0 && sigs.every((s) => s.indication === 'TOTAL_PASSED');
        if (j.state) verifyResults.set(j.state, { signatureCount: j.signatureCount, signatures: sigs, ok });
        console.log(`🔎 verify   state=${j.state}  ${j.signatureCount} signature(s)  ok=${ok}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { console.error('verify callback error:', e); res.writeHead(400); res.end(String(e)); }
    });
  }
  if (req.method === 'GET' && u.pathname === '/result') {
    const r = u.searchParams.get('state') && signResults.get(u.searchParams.get('state'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(
      r ? { ready: true, signedFileName: r.signedFileName, size: r.size, url: `/received/${encodeURIComponent(r.file)}` } : { ready: false }));
  }
  if (req.method === 'GET' && u.pathname === '/verify-result') {
    const r = u.searchParams.get('state') && verifyResults.get(u.searchParams.get('state'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r ? { ready: true, ...r } : { ready: false }));
  }
  if (req.method === 'GET' && u.pathname.startsWith('/received/')) {
    const f = path.join(RECV_DIR, path.basename(decodeURIComponent(u.pathname.slice('/received/'.length))));
    if (f.startsWith(RECV_DIR) && fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(f)}"` });
      return res.end(fs.readFileSync(f));
    }
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  EU-DSS Sign — deep-link test client (sign + verify)`);
  console.log(`  ▶  http://localhost:${PORT}\n`);
  console.log(`  sign:    doc_url=/doc.pdf        callback_url=/callback`);
  console.log(`  verify:  doc_url=/last-signed    callback_url=/verify-callback`);
  console.log(`  signed docs -> ${path.relative(process.cwd(), RECV_DIR)}/\n`);
});
