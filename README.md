# EU-DSS Sign

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
![Java 21](https://img.shields.io/badge/Java-21-007396?logo=openjdk&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![EU DSS 6.4](https://img.shields.io/badge/EU_DSS-6.4-003399)

> Application de bureau pour **signer et vérifier des documents** (PAdES / XAdES / ASiC) à l'aide d'une **clé USB cryptographique** (carte à puce / token PKCS#11), construite sur la bibliothèque **EU DSS** (Digital Signature Services, v6.4). L'application est autonome : elle embarque son propre backend Java — aucun serveur séparé à installer ni à lancer.

Public visé : utilisateurs disposant d'un token de signature (ex. **ChamberSign**, middleware **IDOPTE**) qui souhaitent signer des PDF ou d'autres documents en **PAdES-B-T** / **XAdES-B-T** / **ASiC** depuis leur poste (Windows, macOS, Linux), ainsi que les développeurs qui font évoluer la plateforme.

- **Installation utilisateur (Windows, macOS & Linux)** : voir le guide pas-à-pas [`docs/INSTALL.md`](docs/INSTALL.md).
- **Téléchargements** : voir [Téléchargements / Releases](#téléchargements--releases).

---

## Aperçu

**Signer** : token connecté, certificat de signature affiché, puis flux de signature :

![EU-DSS Sign, Signer : agent connecté + certificat](docs/images/app/02-signer-connecte.png)

**Vérifier** : verdict eIDAS (TOTAL_PASSED) et rapport DSS détaillé :

![EU-DSS Sign, Vérifier : TOTAL_PASSED + rapport DSS](docs/images/app/05-verifier.png)

> Interface identique sur Windows, macOS et Linux. Parcours complet (PIN, signature, récapitulatif) dans le [guide d'installation](docs/INSTALL.md#à-quoi-ça-ressemble--le-parcours-de-signature).

---

## Comment ça marche

**EU-DSS Sign** est une application de bureau Tauri (Rust + React). Elle **embarque le backend EU DSS** (Spring Boot, jpackagé en app-image avec son propre JRE) : au démarrage, l'application le lance sur un port local `127.0.0.1:<port>` choisi automatiquement et attend qu'il réponde. L'utilisateur n'a rien à installer ni démarrer manuellement.

Le **modèle de sécurité** repose sur trois principes :

1. **La clé privée reste sur le token.** L'app ne reçoit jamais la clé ni ne l'exporte. Le backend lui transmet une **empreinte (digest)** à signer, et le token renvoie la **valeur de signature calculée par la carte**.
2. **PKCS#11 directement depuis l'app (Rust, crate `eudss-signer`).** L'accès à la carte se fait via la bibliothèque PKCS#11 du middleware fourni par le fabricant (IDOPTE, etc.) ; la clé privée ne transite pas sur le réseau.
3. **PIN au moment de signer.** Le PIN est saisi dans l'application au moment de signer, jamais mis en cache, et la session se reverrouille après un délai d'inactivité (5 min par défaut).

### Flux de signature (3 allers-retours)

```
  Application (UI Tauri)       Backend embarqué (:port local, EU DSS)   Token PKCS#11
        │                              │                                       │
        │ 1. /api/sign/prepare ───────▶│                                       │
        │    (document + paramètres)   │  getDataToSign + digest               │
        │◀──── empreinte (digest) ─────│                                       │
        │                              │                                       │
        │ 2. PKCS#11 (Rust) ──────────┼──────────────────────────────────────▶│  la CARTE signe l'empreinte
        │◀──── valeur de signature ───────────────────────────────────────────│  (clé privée jamais exposée)
        │                              │                                       │
        │ 3. /api/sign/assemble ──────▶│  embarque la signature                │
        │    (document + signature)    │  (PAdES / ASiC)                       │
        │◀──── document signé ─────────│                                       │
        ▼                              ▼                                       ▼
```

Niveau de signature par défaut : **PAdES-B-T** (PDF) / **XAdES-B-T** (ASiC, autres formats) ; les niveaux **B / T / LT / LTA** et les empreintes **SHA-256 / 384 / 512** sont pris en charge. L'horodatage (niveau T) utilise une TSA en ligne (par défaut `https://freetsa.org/tsr`).

> Les signatures produites sont des **signatures électroniques avancées** (eIDAS). L'application ne peut pas certifier qu'elles sont qualifiées — cela dépend du certificat porté par le token.

---

## Architecture / modules

L'application se présente à l'utilisateur comme un **installeur unique** qui ne nécessite rien d'autre. En interne, le dépôt contient plusieurs modules :

| Module | Rôle | Stack |
|---|---|---|
| [`eu-dss-ui`](eu-dss-ui) | Application de bureau Tauri : UI React (onglets **Signer** / **Vérifier**, assistant de prérequis, modale PIN) + shell Rust (gestion du backend embarqué, accès PKCS#11 via `eudss-signer`) | Rust (Tauri 2), Vite 6, React 19, TypeScript 5.7 |
| [`eu-dss-server`](eu-dss-server) | Backend de signature/vérification, **embarqué dans l'app** (jpackage app-image, JRE inclus) : workflow PAdES/ASiC (préparer l'empreinte → assembler la signature), validation, trust list (LOTL FR) | Java 21, Spring Boot 3.4, EU DSS 6.4 |
| [`eudss-signer`](eudss-signer) | Crate Rust : accès PKCS#11 bas niveau (lister les slots, signer un digest, gérer la session PIN) | Rust, crate `cryptoki` |

> Les modules `eu-dss-agent` (ancien agent Java local) et les scripts `bin/` / `packaging/linux/` sont des reliques de l'architecture précédente (agent localhost séparé). Ils ne sont **pas utilisés par l'application Tauri** et sont conservés pour référence.

---

## Prérequis utilisateur

| Élément | Détail |
|---|---|
| **Token USB branché** | Carte à puce / clé cryptographique de signature, insérée. |
| **Middleware PKCS#11 du fabricant** | Le pilote de la carte (ex. IDOPTE pour ChamberSign). L'application ne le fournit pas. Voir [`docs/INSTALL.md`](docs/INSTALL.md) pour le lien de téléchargement. |

**C'est tout.** Aucun Java, aucun serveur, aucune configuration à faire : le JRE et le backend EU DSS sont embarqués dans l'installeur.

---

## Installation rapide

### Windows (recommandé)

L'installeur Windows est **signé via Azure Artifact Signing** (pas de blocage SmartScreen). L'UI de l'installeur est en français.

1. Installer le middleware PKCS#11 du fabricant et brancher le token.
2. Télécharger l'installeur depuis la [dernière Release](https://github.com/mmaudet/eu-dss-module/releases/latest) : le `.exe` (NSIS, sans invite UAC) est **recommandé** pour les postes utilisateur ; le `.msi` (signé) convient aux déploiements administrateur. Voir [Téléchargements / Releases](#téléchargements--releases).
3. Double-cliquer et suivre l'assistant d'installation.
4. Lancer **EU-DSS Sign** depuis le menu Démarrer, puis suivre l'assistant de première utilisation (prérequis → test du PIN → prêt à signer).

### Linux (.deb / .rpm)

```bash
# Debian/Ubuntu
sudo apt install ./<eu-dss-sign_version>.deb

# Fedora/RHEL
sudo rpm -i <eu-dss-sign_version>.rpm
```

Installer le middleware PKCS#11 du fabricant, brancher le token, puis lancer **EU-DSS Sign**.

### macOS (arm64, Apple Silicon)

1. Télécharger le `.dmg` depuis la [dernière Release](https://github.com/mmaudet/eu-dss-module/releases/latest) (voir [Téléchargements / Releases](#téléchargements--releases)).
2. Ouvrir le `.dmg` et glisser **EU-DSS Sign** dans Applications.
3. Double-cliquer sur **EU-DSS Sign** : l'app est signée Developer ID **et notarisée par Apple**, Gatekeeper l'ouvre directement.
4. Installer le middleware PKCS#11 du fabricant, brancher le token, suivre l'assistant.

Détails et captures d'écran → **[`docs/INSTALL.md`](docs/INSTALL.md)**.

---

## Développement (monorepo)

### Prérequis développeur

- **Java 21** (Temurin recommandé) — pour compiler et jpackager `eu-dss-server`.
- **Rust stable** + `cargo` — pour `eu-dss-ui/src-tauri` et `eudss-signer`.
- **Node.js 20 + npm** — pour l'UI React (`eu-dss-ui`).

### Compiler le backend embarqué

```bash
mvn -DskipTests package
```

Génère `eu-dss-server/target/eu-dss-server-*.jar`. En CI (`tauri-app.yml`), `jpackage` transforme ce jar en app-image (avec JRE) avant la build Tauri.

### Lancer en mode développement

```bash
cd eu-dss-ui
npm install
npm run tauri dev   # lance Vite + le shell Tauri (le backend embarqué n'est pas stagé en dev)
```

En mode dev, le backend peut être démarré séparément avec `./bin/eu-dss-server.sh` ; l'URL du backend est transmise via `VITE_BACKEND_URL`.

### Tests Java

```bash
mvn test    # tests JUnit 5 (eu-dss-server)
```

### Tests Rust

```bash
cd eudss-signer && cargo test
```

### Variables d'environnement du serveur

Configuré via [`application.yml`](eu-dss-server/src/main/resources/application.yml) :

- `EUDSS_LOTL_ENABLED` (`eudss.lotl.enabled`, défaut `true`) : télécharge la trust list de l'UE au démarrage. À `false`, la validation reste *INDETERMINATE* (utile en dev hors-ligne).
- TSA d'horodatage : `eudss.tsa.url` (défaut `https://freetsa.org/tsr`).

### Disposition du dépôt

```
eu-dss/
├── eu-dss-ui/          # Application Tauri (Rust + React)
│   └── src-tauri/      # Shell Rust : backend.rs (sidecar), commands.rs, signer_state.rs
├── eu-dss-server/      # Backend Spring Boot (embarqué dans l'app via jpackage)
├── eudss-signer/       # Crate Rust PKCS#11
├── .github/workflows/
│   └── tauri-app.yml   # Build CI (Windows/Linux/macOS), déclenché sur main + tags v*
├── bin/                # Scripts de développement (serveur, UI dev) — pas pour l'utilisateur final
├── packaging/          # Artefacts d'anciens installeurs (eu-dss-agent, obsolètes pour l'utilisateur final)
└── docs/               # INSTALL.md + specs/plans
```

---

## Sécurité

- **Clé privée jamais exposée** : l'app ne fait signer qu'un condensat par le token PKCS#11 ; la clé privée ne quitte pas la carte.
- **Backend local uniquement** : le backend embarqué n'écoute que sur `127.0.0.1` ; aucun port n'est ouvert sur le réseau.
- **PIN demandé au moment de signer**, jamais persisté ; effacé de la mémoire après usage.
- **TTL de session** : la session PIN se reverrouille après inactivité (défaut 300 s). Les tentatives de signer en session expirée redemandent le PIN.
- **Mapping d'erreurs PKCS#11** : PIN incorrect (`401`), PIN bloqué (`423`), token indisponible (`503`).

---

## Téléchargements / Releases

**Dernière version : [EU-DSS Sign v1.0.0](https://github.com/mmaudet/eu-dss-module/releases/tag/v1.0.0).**

Téléchargez directement l'installeur correspondant à votre système :

| OS | Installeur | Téléchargement |
|---|---|---|
| **Windows** (utilisateur, **recommandé**) | `.exe` (NSIS) — installation par utilisateur, **sans invite UAC** | [EU-DSS.Sign_1.0.0_x64-setup.exe](https://github.com/mmaudet/eu-dss-module/releases/download/v1.0.0/EU-DSS.Sign_1.0.0_x64-setup.exe) |
| **Windows** (administrateur / entreprise) | `.msi` (signé) — déploiement administrateur | [EU-DSS.Sign_1.0.0_x64_fr-FR.msi](https://github.com/mmaudet/eu-dss-module/releases/download/v1.0.0/EU-DSS.Sign_1.0.0_x64_fr-FR.msi) |
| **macOS** (arm64 / Apple Silicon) | `.dmg` | [EU-DSS.Sign_1.0.0_aarch64.dmg](https://github.com/mmaudet/eu-dss-module/releases/download/v1.0.0/EU-DSS.Sign_1.0.0_aarch64.dmg) |
| **Linux** (Debian / Ubuntu) | `.deb` | [EU-DSS.Sign_1.0.0_amd64.deb](https://github.com/mmaudet/eu-dss-module/releases/download/v1.0.0/EU-DSS.Sign_1.0.0_amd64.deb) |
| **Linux** (Fedora / RHEL) | `.rpm` | [EU-DSS.Sign-1.0.0-1.x86_64.rpm](https://github.com/mmaudet/eu-dss-module/releases/download/v1.0.0/EU-DSS.Sign-1.0.0-1.x86_64.rpm) |

Les installeurs sont **signés** (Windows : Azure Artifact Signing ; macOS : Developer ID + notarisation Apple) et produits automatiquement par le workflow CI [`.github/workflows/tauri-app.yml`](.github/workflows/tauri-app.yml) à chaque tag `v*`.

> Pour les builds de développement (nightly), récupérez les **Artifacts** du dernier run réussi dans l'onglet **Actions → Tauri app** du dépôt.

---

## Documentation

- **[`docs/INSTALL.md`](docs/INSTALL.md)** : guide d'installation et de premiers pas (Windows, macOS, Linux), avec captures d'écran.
- **[`docs/deeplink-integration.md`](docs/deeplink-integration.md)** : intégration `eudss://` — signer / valider un document depuis une application web externe, avec exemples JavaScript.

---

## Statut

Disponible et vérifié :

- **Signature PAdES-B-T (PDF) et XAdES-B-T / ASiC** (autres formats) ; niveaux B / T / LT / LTA, empreintes SHA-256/384/512.
- **Vérification** de documents signés (avec trust list FR via LOTL).
- **Intégration par deep-link** `eudss://` : signer ou valider un document depuis une application web externe (voir [`docs/deeplink-integration.md`](docs/deeplink-integration.md)).
- **PIN saisi au moment de signer** (session PIN avec reverrouillage automatique après inactivité).
- **Assistant de prérequis** dans l'UI (détecte le middleware, la carte, et guide l'utilisateur).
- **Installeurs autonomes** (JRE + backend embarqués, aucun prérequis Java côté utilisateur) : **Windows** (`.msi` / `.exe`, signé Azure) · **Linux** (`.deb` / `.rpm`) · **macOS arm64** (`.dmg`, Developer ID signé **et notarisé Apple**).
- Vérifiés de bout en bout (signature + vérification avec une clé ChamberSign) sur **Windows**, **macOS** et **Linux** (Ubuntu 24.04).

En cours : Firefox/NSS (trust list dans NSS), multi-utilisateur.

---

## Contribuer

Les contributions sont les bienvenues ; ouvrez une **issue** ou une **pull request**. Pour démarrer, voir la section **Développement** ci-dessus (`mvn -DskipTests package`, `npm run tauri dev`, `cargo test`). Merci de vérifier que `mvn test`, `cargo test` et `npm run build` passent avant d'ouvrir une PR.

---

## Licence

Développé par **LINAGORA**. Construit sur la bibliothèque open source [EU DSS](https://ec.europa.eu/digital-building-blocks/sites/display/DIGITAL/Digital+Signature+Service+-++DSS) de la Commission européenne.

Sous licence **[GNU AGPL-3.0](LICENSE)**, © 2026 LINAGORA. Vous pouvez utiliser, étudier, modifier et redistribuer ce logiciel selon les termes de l'AGPL-3.0 ; toute version modifiée mise à disposition via un réseau doit elle aussi être publiée sous AGPL-3.0.
