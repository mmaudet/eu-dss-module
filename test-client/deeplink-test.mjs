#!/usr/bin/env node
// EU-DSS Sign — deep-link round-trip test client.
//
// Simulates an external web app that asks EU-DSS Sign to sign a document via the
// `eudss://` deep link, then receives the signed document back on a callback.
//
//   node deeplink-test.mjs [port]      (default port 8787, or $PORT)
//
// Then open http://localhost:<port>, click "Signer avec EU-DSS": the OS launches
// the installed app, you confirm + enter the PIN, the app POSTs the signed PDF
// back here, and the page shows it. Signed files are saved to ./received/.
//
// NOTE: the app must be INSTALLED (or `tauri dev` running on Linux/Windows) so
// the `eudss://` scheme is registered with the OS.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || process.argv[2] || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECV_DIR = path.join(__dirname, 'received');
fs.mkdirSync(RECV_DIR, { recursive: true });

/** state -> { signedFileName, size, file } */
const results = new Map();

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
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 6vh auto; padding: 0 20px; }
  h1 { font-size: 1.35rem; }
  button { font: inherit; font-weight: 600; padding: .7em 1.3em; border: 0; border-radius: 10px;
           background: #2563eb; color: #fff; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  code, pre { background: rgba(127,127,127,.15); border-radius: 6px; padding: .15em .4em; }
  pre { padding: .8em; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .out { margin-top: 1.2em; padding: 1em; border-radius: 10px; background: rgba(127,127,127,.1); min-height: 1.5em; }
  .muted { color: #888; font-size: .9em; }
</style></head><body>
<h1>🖊️ EU-DSS Sign — test du deep-link</h1>
<p>Ce client simule un site externe qui demande la signature d'un document via le lien
<code>eudss://sign</code>, puis reçoit le document signé sur son callback.</p>
<p><button id="go">Signer avec EU-DSS</button></p>
<p class="muted">Lien généré :</p>
<pre id="link">—</pre>
<div class="out" id="out">En attente.</div>
<p class="muted">Le document signé est aussi enregistré dans <code>test-client/received/</code>.</p>
<script>
  const btn = document.getElementById('go');
  const out = document.getElementById('out');
  btn.onclick = () => {
    const state = crypto.randomUUID();
    const base = location.origin;
    const link = 'eudss://sign?doc_url=' + encodeURIComponent(base + '/doc.pdf')
      + '&callback_url=' + encodeURIComponent(base + '/callback')
      + '&state=' + encodeURIComponent(state);
    document.getElementById('link').textContent = link;
    out.textContent = '⏳ Ouverture de EU-DSS Sign… confirmez et saisissez le PIN dans l\\'application.';
    location.href = link; // hands off to the OS-registered app
    const started = Date.now();
    const timer = setInterval(async () => {
      let j;
      try { j = await (await fetch('/result?state=' + encodeURIComponent(state))).json(); }
      catch { return; }
      if (j.ready) {
        clearInterval(timer);
        out.innerHTML = '✅ Document signé reçu : <b>' + j.signedFileName + '</b> ('
          + j.size + ' octets) — <a href="' + j.url + '">télécharger</a>';
      } else if (Date.now() - started > 180000) {
        clearInterval(timer);
        out.textContent = '⌛ Timeout : aucun callback reçu en 3 min.';
      }
    }, 1000);
  };
</script></body></html>`;

/* ── Server ────────────────────────────────────────────────────────────────── */
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
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="contrat-demo.pdf"',
    });
    return res.end(PDF);
  }
  if (req.method === 'POST' && u.pathname === '/callback') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const bytes = Buffer.from(j.signedDocumentBase64 || '', 'base64');
        const safe = (j.signedFileName || 'signed.bin').replace(/[^\w.\-]/g, '_');
        const fname = `${Date.now()}-${safe}`;
        fs.writeFileSync(path.join(RECV_DIR, fname), bytes);
        if (j.state) results.set(j.state, { signedFileName: j.signedFileName, size: bytes.length, file: fname });
        console.log(`✅ callback  state=${j.state}  ${j.signedFileName}  (${bytes.length} octets)  -> received/${fname}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('callback error:', e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/result') {
    const st = u.searchParams.get('state');
    const r = st && results.get(st);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(
      r ? { ready: true, signedFileName: r.signedFileName, size: r.size, url: `/received/${encodeURIComponent(r.file)}` }
        : { ready: false },
    ));
  }
  if (req.method === 'GET' && u.pathname.startsWith('/received/')) {
    const f = path.join(RECV_DIR, path.basename(decodeURIComponent(u.pathname.slice('/received/'.length))));
    if (f.startsWith(RECV_DIR) && fs.existsSync(f)) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(f)}"`,
      });
      return res.end(fs.readFileSync(f));
    }
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  EU-DSS Sign — deep-link test client`);
  console.log(`  ▶  http://localhost:${PORT}\n`);
  console.log(`  doc_url      = http://localhost:${PORT}/doc.pdf`);
  console.log(`  callback_url = http://localhost:${PORT}/callback`);
  console.log(`  signed docs  -> ${path.relative(process.cwd(), RECV_DIR)}/\n`);
});
