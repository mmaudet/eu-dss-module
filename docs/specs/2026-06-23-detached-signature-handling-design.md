# Conception — Gestion des signatures détachées

**Date :** 2026-06-23
**Statut :** Conception validée (en attente de revue du spec)
**Périmètre :** `eu-dss-ui` (UI React + Tauri), `eu-dss-server` (backend Java/DSS), documentation

---

## 1. Contexte et problème

Deux fichiers de signature d'un même `.xlsx` ont révélé deux défauts de l'application :

- Un `.xml` **XAdES détaché** produit par eu-dss (via le choix explicite « XAdES détaché ») : il ne contient que le **nom** du fichier source (`URI="…xlsx"`) et son **empreinte SHA-256**. Le contenu n'y est pas → il faut le **couple** (document source + fichier de signature) pour vérifier.
- Un `.p7s` **CAdES attaché** produit par **un autre outil** (eu-dss n'a aucun chemin CAdES) : le fichier source y est embarqué → il se vérifie avec **un seul** fichier.

Deux problèmes en découlent :

1. **Génération** — l'app offre « XAdES détaché », qui crée un artefact fragile à deux fichiers (le lien n'est qu'un nom dans l'attribut `URI=`), **et qu'elle est incapable de re-vérifier**.
2. **Vérification** — l'écran « Vérifier » n'accepte qu'un seul fichier. Le manque est sur 3 couches :
   - UI : une seule zone de dépôt (`ValidatePage.tsx:347-529`).
   - API : `POST /api/validate` en JSON, un seul champ `documentBase64` (`ValidationController.java:14-28`).
   - Moteur : `SignedDocumentValidator.fromDocument(...)` → `validateDocument()` **sans jamais appeler `setDetachedContents()`** (`DocumentValidationService.java:30-51`).

**Constat clé :** l'app **produit des signatures qu'elle ne sait pas vérifier**, et elle **reçoit** des signatures de l'extérieur (le `.p7s`). La vérification du détaché est donc nécessaire **indépendamment** de la politique de génération.

**Nuance technique structurante :** l'extension ne dit rien du format (`.p7s` peut être attaché *ou* détaché ; `.xlsx` et `.asice` sont **tous deux** des ZIP). La détection doit se faire **par le contenu**, jamais par l'extension.

---

## 2. Objectifs / Non-objectifs

**Objectifs**
- L'app ne produit plus que des signatures **auto-suffisantes**.
- L'écran « Vérifier » gère le **couple détaché** via une **zone unique intelligente**.
- La documentation API reflète les changements.

**Non-objectifs (YAGNI)**
- Production de signatures CAdES (`.p7s`) — on sait les *vérifier*, pas besoin de les *produire*.
- Auto-découverte du fichier voisin (même nom dans le dossier) — possible en Tauri, reporté.
- Support du détaché via le deep-link `eudss://verify` — reste **mono-fichier** ; limite documentée.

---

## 3. Décisions

| # | Décision | Justification |
|---|---|---|
| D1 | **Retirer « XAdES détaché »** du menu de signature + des options offertes. Conserver « XAdES enveloppant » (auto-suffisant). Défense backend : rejeter `XADES_DETACHED` s'il arrive par l'API. | Plus aucun chemin ne produit un artefact non re-vérifiable par l'app. |
| D2 | Vérification : **zone unique intelligente** + **détection pilotée par le backend** (DSS = source de vérité), pas de sniffing JS. | Garder la connaissance des formats dans DSS uniquement ; le sniffing JS serait fragile (ex. `.xlsx`/`.asice` = ZIP). |
| D3 | API REST `/api/validate` : ajouter `detachedContentBase64` (+ noms) et un champ de cas en réponse. **Deep-link `eudss://verify` inchangé.** | Changement minimal, rétro-compatible ; le détaché reste in-app. |
| D4 | Mettre à jour `README.md` et `docs/deeplink-integration.md`. | Demande explicite « màj doc api ». |
| D5 | (micro) **Garder** « XAdES enveloppant ». | Auto-suffisant, vérifiable avec 1 fichier, inoffensif. *À reconfirmer en revue : ASiC-E seul format non-PDF ?* |

---

## 4. Conception détaillée

### 4.1 Génération — retrait du détaché
- **UI** : retirer l'entrée « XAdES détaché » du menu `SignWorkspace.tsx:27-33` (conserver auto / PAdES / ASiC-E / XAdES enveloppant).
- **Backend (défense)** : si `XADES_DETACHED` est demandé via l'API, renvoyer une **erreur 400 explicite** au point de résolution (`SigningFormat.resolve()` / `DocumentSigningService.signerFor()` `:74-81`). Option : retirer la valeur de l'enum `SignatureFormDto` (`SignatureParamsDto.java:42-61`).
- **Deep-link** : `DeepLinkSignModal.tsx:184` utilise `defaultSignatureForm` (→ ASiC-E pour non-PDF) ; aucune exposition du détaché attendue — **à confirmer**.
- Le bean `xadesDetachedSigner` (`DssConfig.java:172-174`) et `XadesSigningService` restent (utilisés par l'enveloppant) mais ne sont plus atteignables pour le détaché.

### 4.2 Vérification — modèle de détection (backend)
Le backend classe le fichier déposé en **3 cas**, par inspection de structure (pas par extension) :

| `kind` | Quand | Exemples |
|---|---|---|
| `VALIDATED` | signature auto-suffisante (ou couple complet fourni) | PAdES (PDF), ASiC (`.asice`/`.asics`), XAdES enveloppant, **CAdES attaché** (`eContent` présent) |
| `DETACHED_CONTENT_REQUIRED` | signature détachée sans contenu fourni | XAdES détaché (Reference externe, pas d'`<ds:Object>`), CAdES détaché (`eContent` absent) |
| `NOT_A_SIGNATURE` | aucun signataire trouvé (probable document source) | `.xlsx`, `.pdf` non signé… |

**Note d'implémentation (matching DSS) :** pour le **XAdES détaché**, la `Reference URI` cible le **nom de fichier** → le document détaché doit être fourni avec le **bon nom** (`detachedContentName`) à `setDetachedContents(...)`. Pour le **CAdES détaché**, le matching se fait par empreinte (le nom importe peu). La méthode DSS exacte de classification (inspection structurelle vs interprétation du rapport) est une **tâche d'implémentation**.

### 4.3 Backend — `DocumentValidationService` (`:30-51`)
- Si un contenu détaché est fourni : construire un `DSSDocument` (`InMemoryDocument` avec le nom) et appeler `validator.setDetachedContents(List.of(source))` **avant** `validateDocument()`.
- Sinon : classer le document (`VALIDATED` / `DETACHED_CONTENT_REQUIRED` / `NOT_A_SIGNATURE`).
- Empreinte non concordante (mauvaise source) → exploiter le rapport DSS (référence non intacte) pour un message clair.

### 4.4 API REST — `POST /api/validate` (`ValidationController.java:14-28`)
- **Requête** (JSON `ValidateRequest`) : `documentBase64` (existant) + **`documentName?`** + **`detachedContentBase64?`** + **`detachedContentName?`**.
- **Réponse** (`ValidationResponseDto`) : ajouter **`kind`** ∈ { `VALIDATED`, `DETACHED_CONTENT_REQUIRED`, `NOT_A_SIGNATURE` } ; le rapport DSS reste présent quand `VALIDATED`.
- **Rétro-compatible** : un POST mono-fichier existant continue de fonctionner (le `kind` est dérivé).

### 4.5 UI — `ValidatePage.tsx` (`:347-529`)
Machine à états sur une **zone unique** :
1. Dépôt fichier **A** → `validate(A)`.
2. `VALIDATED` → afficher le rapport.
3. `DETACHED_CONTENT_REQUIRED` → bandeau « Signature détachée : ajoutez le **document source** » → dépôt **B** → `validate(document=A, detachedContent=B, detachedContentName=B.name)`.
4. `NOT_A_SIGNATURE` → bandeau « Ce fichier n'est pas une signature : ajoutez le **fichier de signature** (.p7s, .xml, …) » → dépôt **B** → `validate(document=B, detachedContent=A, detachedContentName=A.name)` (**inversion des rôles**).
5. Échec d'empreinte → « Le document fourni ne correspond pas à la signature ».
- `DeepLinkVerifyModal` (`:179`) : réutilise la logique **uniquement** pour l'auto-suffisant ; si `DETACHED_CONTENT_REQUIRED` reçu via deep-link → message « non supporté par le lien, utilisez l'écran Vérifier » (limite documentée).
- `fileKind()` (`ui.tsx:183-187`) reste **cosmétique** ; la vérité vient du backend.

### 4.6 Documentation API
- **`README.md`** : préciser que `/api/validate` accepte un document **auto-suffisant** *ou* un **couple** (signature + source) pour le détaché.
- **`docs/deeplink-integration.md`** (section `eudss://verify`, ~ligne 76) : **documenter explicitement** que le deep-link valide uniquement des signatures **auto-suffisantes** (PAdES / ASiC / enveloppant / CAdES attaché) et **pas** le couple détaché → renvoyer vers l'écran « Vérifier ». Ajuster les exemples JS si nécessaire.

---

## 5. Critères d'acceptation (tests)

Fichiers réels de test disponibles : le `.xlsx`, le `.xml` (XAdES détaché) et le `.p7s` (CAdES attaché) du dossier CANUT.

1. `.p7s` attaché seul → `VALIDATED` (**régression** : marche déjà aujourd'hui).
2. `.xml` détaché seul → `DETACHED_CONTENT_REQUIRED` → l'UI réclame la source.
3. `.xml` détaché + bon `.xlsx` → `VALIDATED` (rapport eIDAS).
4. `.xml` détaché + **mauvais** document → invalide, message « ne correspond pas ».
5. `.xlsx` nu seul → `NOT_A_SIGNATURE` → l'UI réclame le fichier de signature.
6. `.xlsx` nu + son `.xml` (ajouté en 2ᵉ) → `VALIDATED` (inversion des rôles OK).
7. PAdES (PDF) / ASiC (`.asice`) seul → `VALIDATED` (**régression**).
8. Signer un `.xlsx` → produit un `.asice` (**régression**) ; « XAdES détaché » **absent** du menu.
9. `XADES_DETACHED` envoyé à l'API de signature → **rejeté** avec erreur explicite.

---

## 6. Hors périmètre
- Production de CAdES (`.p7s`).
- Auto-découverte du fichier voisin (même dossier).
- Détaché via deep-link `eudss://verify` (mono-fichier ; limite documentée).

---

## 7. Questions ouvertes
- Aucune bloquante. Seul point à reconfirmer en revue (D5) : garder « XAdES enveloppant », ou faire d'ASiC-E le **seul** format non-PDF.
