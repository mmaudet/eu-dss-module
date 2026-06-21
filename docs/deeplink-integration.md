# Intégration par deep-link (`eudss://`)

EU-DSS Sign enregistre le schéma d'URL **`eudss://`**. Une application web externe
peut donc déclencher une opération dans l'application de bureau via un simple lien
— **sans pont localhost, sans extension navigateur, sans configuration réseau**.

Deux actions sont disponibles :

| Action | Lien | Effet |
|---|---|---|
| **Signer** | `eudss://sign?…` | l'app télécharge un document, le **signe** (PIN), et renvoie le document signé |
| **Valider** | `eudss://verify?…` | l'app télécharge un document signé, le **valide** (listes de confiance UE), et renvoie le rapport |

Le document est échangé **par URL** (l'application le télécharge) et le résultat est
renvoyé par **POST sur une URL de callback** que vous fournissez. C'est un modèle de
type *webhook* : votre application n'a pas besoin d'atteindre l'app de bureau, c'est
l'app qui vient à vous.

```
Site web externe                 EU-DSS Sign (bureau)                 Token PKCS#11
   │  eudss://sign?doc_url=…&callback_url=…&state=…
   │ ───── lien ouvert ─────────▶│
   │                             │ 1. télécharge doc_url
   │                             │ 2. confirme (origine + format) + PIN
   │                             │ 3. signe PAdES-B-T ───────────────▶│
   │                             │ 4. POST le document signé ▶ callback_url
   │ ◀──── résultat reçu ────────│
```

---

## Prérequis

- **EU-DSS Sign installé** : l'installeur enregistre le schéma `eudss://` auprès du
  système (Registre Windows, `.desktop`/MimeType Linux, `Info.plist` macOS).
  - En développement, sur Linux/Windows, `npm run tauri dev` suffit (l'app enregistre
    le schéma au démarrage). Sur **macOS**, le deep-link ne résout que vers une app
    **buildée/installée** (le schéma vit dans le bundle `.app`).
- **Pour signer** : token PKCS#11 branché + middleware ; l'utilisateur saisit son PIN
  dans l'app. **Pour valider** : rien de particulier (la validation est publique).
- Vos `doc_url` / `callback_url` doivent être **joignables par l'app** :
  `https://…` (recommandé en production) ou `http://localhost:…` / `http://127.0.0.1:…`
  (tests locaux). Ces origines sont autorisées par l'app.

---

## Schéma d'URL

### `eudss://sign`

```
eudss://sign?doc_url=<URL encodée>&callback_url=<URL encodée>&state=<opaque>
```

| Paramètre | Rôle |
|---|---|
| `doc_url` | l'app fait un **GET** sur cette URL pour récupérer le document à signer |
| `callback_url` | l'app fait un **POST** du document signé sur cette URL |
| `state` | chaîne opaque renvoyée **telle quelle** (corrélation / anti-rejeu ; optionnel) |

L'app télécharge `doc_url` → **écran de confirmation** (nom du fichier, format de
signature résolu, hôte du callback) → **PIN** → signe (PAdES-B-T pour un PDF,
XAdES/ASiC-E sinon) → POST le résultat.

**Payload POST envoyé au `callback_url`** (`Content-Type: application/json`) :

```json
{
  "state": "…",
  "signedFileName": "contrat.asice",
  "mediaType": "application/vnd.etsi.asic-e+zip",
  "signedDocumentBase64": "…(document signé encodé en base64)…"
}
```

### `eudss://verify`

```
eudss://verify?doc_url=<URL encodée>&callback_url=<URL encodée>&state=<opaque>
```

| Paramètre | Rôle |
|---|---|
| `doc_url` | l'app fait un **GET** sur cette URL pour récupérer le document **signé** à valider |
| `callback_url` | l'app fait un **POST** du rapport de validation sur cette URL |
| `state` | chaîne opaque renvoyée telle quelle |

L'app télécharge `doc_url` → écran de confirmation (**sans PIN**, la validation est en
lecture seule) → valide via la bibliothèque DSS (listes de confiance UE / LOTL) → POST
le rapport.

**Payload POST envoyé au `callback_url`** :

```json
{
  "state": "…",
  "signatureCount": 1,
  "signatures": [
    {
      "signatureId": "id-…",
      "signatureFormat": "ASiC-E …",
      "indication": "TOTAL_PASSED",
      "subIndication": null,
      "signedBy": "Michel-Marie MAUDET",
      "signingDate": "2026-06-21T11:05:57Z"
    }
  ],
  "simpleReportXml": "<SimpleReport …>…</SimpleReport>"
}
```

`indication` suit la sémantique eIDAS : **`TOTAL_PASSED`** (valide), **`TOTAL_FAILED`**
(invalide) ou **`INDETERMINATE`** (indéterminé — voir `subIndication` et le rapport).

---

## Modèle de sécurité

- N'importe quel site peut ouvrir un lien `eudss://`. L'app **affiche toujours** ce qui
  va être signé / validé et **où** le résultat sera envoyé, et **exige le PIN pour
  signer** — il n'y a **jamais** de signature silencieuse. La validation, en lecture
  seule, ne demande pas de PIN.
- `state` est renvoyé **verbatim** ; l'app ne l'interprète jamais. Utilisez-le pour
  corréler la réponse à votre requête (et comme nonce anti-rejeu).
- Le document transite par **vos** URLs : servez `doc_url` depuis un emplacement que
  vous contrôlez (idéalement une URL signée / temporaire en production), et n'exposez
  le `callback_url` qu'à votre backend.

---

## Mode Twake Drive

Pour l'intégration **Twake Drive** (Cozy), l'app sait écrire le résultat
**directement dans le Drive** via l'API `cozy-stack`, sans passer par le format
JSON générique ci-dessus. Ce mode est **détecté automatiquement** : il s'active
dès que le `callback_url` contient un paramètre **`token`** non vide.

Twake Drive construit le deep-link normalement (`doc_url`, `callback_url`,
`state`), mais le `callback_url` pointe sur l'endpoint d'écriture de `cozy-stack`
et porte les paramètres `Type`, `Name` et `token` :

```
eudss://sign
  ?doc_url=https%3A%2F%2F…%2Ffiles%2Fabc%2Fcontent
  &callback_url=https%3A%2F%2Falice.mycozy.cloud%2Ffiles%2F<dir-id>%3FType%3Dfile%26Name%3Dcontrat.pdf%26token%3DeyJ…
  &state=…
```

Quand un `token` est présent, le POST de retour change ainsi :

| | Mode générique | **Mode Twake Drive** |
|---|---|---|
| **Corps** | JSON (`…Base64`) | **octets bruts** du document / rapport |
| **`Content-Type`** | `application/json` | media type du résultat (`application/pdf`, `application/vnd.etsi.asic-e+zip`, ou `application/xml` pour un rapport) |
| **Auth** | — | `Authorization: Bearer <token>` (valeur du param `token`) |
| **Nom de fichier** | dans le corps | dans l'URL (`Name=`) — l'URL est POSTée **telle quelle** |
| **`state`** | renvoyé | ignoré (écriture directe dans le Drive) |

`cozy-stack` **exige le header `Bearer`** (le token en query ne suffit pas côté
stack). La validation suit la même règle : `eudss://verify` POSTe le **rapport
(`simpleReportXml`) en octets bruts** avec `Content-Type: application/xml`, le
nom du fichier rapport étant lui aussi dans l'URL (`Name=`).

**Réception côté `cozy-stack`** (ce que l'app envoie, simplifié) :

```
POST /files/<dir-id>?Type=file&Name=contrat.pdf&token=eyJ…
Authorization: Bearer eyJ…
Content-Type: application/pdf

<octets du document signé>
```

> Le `Bearer` n'est envoyé qu'à l'hôte du `callback_url` — celui-là même qui a
> fourni le `token` dans l'URL. Aucun secret stocké par l'app n'est transmis.

---

## Exemple JavaScript — Signer

**Côté serveur** (Node — sert le document et reçoit le résultat) :

```js
import http from 'node:http';
import fs from 'node:fs';

http.createServer((req, res) => {
  // 1. le document à signer
  if (req.method === 'GET' && req.url === '/doc.pdf') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    return res.end(fs.readFileSync('contrat.pdf'));
  }
  // 3. le document signé revient ici
  if (req.method === 'POST' && req.url === '/callback') {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { state, signedFileName, signedDocumentBase64 } = JSON.parse(body);
      fs.writeFileSync(signedFileName, Buffer.from(signedDocumentBase64, 'base64'));
      console.log('Signé :', signedFileName, '(state =', state, ')');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(8800, () => console.log('http://localhost:8800'));
```

**Côté page web** (ouvre le deep-link) :

```html
<button onclick="sign()">Signer avec EU-DSS</button>
<script>
function sign() {
  const state = crypto.randomUUID();
  location.href = 'eudss://sign'
    + '?doc_url='      + encodeURIComponent('http://localhost:8800/doc.pdf')
    + '&callback_url=' + encodeURIComponent('http://localhost:8800/callback')
    + '&state='        + encodeURIComponent(state);
  // …puis interrogez votre backend (ou un WebSocket/SSE) pour savoir quand
  //    le callback a reçu le document signé associé à `state`.
}
</script>
```

---

## Exemple JavaScript — Valider

**Côté serveur** (sert le document signé et reçoit le rapport) :

```js
// 1. le document signé à valider
if (req.method === 'GET' && req.url === '/signed') {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  return res.end(fs.readFileSync('contrat.asice'));
}
// 3. le rapport de validation revient ici
if (req.method === 'POST' && req.url === '/verify-callback') {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    const r = JSON.parse(body);
    console.log(r.signatureCount, 'signature(s) — state =', r.state);
    for (const s of r.signatures) console.log('  •', s.signedBy, '→', s.indication);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  return;
}
```

**Côté page web** :

```html
<button onclick="verify()">Valider avec EU-DSS</button>
<script>
function verify() {
  location.href = 'eudss://verify'
    + '?doc_url='      + encodeURIComponent('http://localhost:8800/signed')
    + '&callback_url=' + encodeURIComponent('http://localhost:8800/verify-callback')
    + '&state='        + encodeURIComponent(crypto.randomUUID());
}
</script>
```

Décidez du verdict à partir des `indication` reçues, p. ex. « toutes `TOTAL_PASSED` »
= valide :

```js
const valide = r.signatureCount > 0 && r.signatures.every((s) => s.indication === 'TOTAL_PASSED');
```

---

## Client de test prêt à l'emploi

Un client de test complet (signer **puis** valider, en un seul petit serveur Node sans
dépendance) est fourni dans **[`test-client/`](../test-client/)** :

```bash
node test-client/deeplink-test.mjs      # http://localhost:8787
```

Ouvrez la page, cliquez « Signer avec EU-DSS » (l'app signe un PDF généré à la volée),
puis « Valider le dernier document signé » (l'app valide ce même document). Voir
[`test-client/README.md`](../test-client/README.md) pour le détail.
