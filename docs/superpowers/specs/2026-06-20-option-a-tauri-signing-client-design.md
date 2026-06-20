# Design : Option A : client de signature natif (Tauri) en remplacement de l'agent localhost

Date : 2026-06-20 · Branche : `eu-dss` · Modules : nouveau client Tauri (Rust + UI embarquée) · `eu-dss-server` (ajouts) · `eu-dss-agent` (conservé comme oracle pendant la transition)

## Contexte & problème

L'architecture actuelle a trois composants : une UI React servie dans le navigateur, un agent Java local (Javalin sur `https://localhost:9795`, pont PKCS#11), et un backend DSS hébergé (Spring Boot : `prepare` / `assemble` / `validate`). La signature suit le flux externe DSS en trois allers-retours : le token ne voit jamais que le digest.

Ce modèle fonctionne et est validé sur carte réelle (macOS, Windows 11 ARM64, Linux). Mais le pont navigateur vers `https://localhost` concentre trois problèmes, confirmés comme moteurs de ce redesign :

1. Friction d'installation pour le signataire (installer l'agent, accepter ou auto-truster un certificat, aller sur le site).
2. Fragilité du pont localhost : certificat auto-signé, CORS, mixed-content, et le durcissement de Private Network Access dans les navigateurs (risque stratégique à terme).
3. Trop de composants à livrer et versionner.

Contrainte forte : on garde le cap webapp multi-utilisateur. Le backend DSS reste hébergé (mise à jour poussée une fois, hébergement central). On ne bascule pas vers un produit « app à télécharger » autonome au sens identité nationale.

## Décision

Remplacer l'agent localhost et le pont navigateur par une application native fine (Tauri) qui embarque son UI dans une webview et possède directement l'accès PKCS#11. Le backend DSS reste hébergé et inchangé dans ses responsabilités.

Options écartées :
- Tout embarquer en local, DSS compris (offline complet) : casse le cap multi-utilisateur hébergé, binaire lourd, mises à jour binaires de la logique de signature. Rejeté.
- Garder le navigateur et seulement fusionner UI et agent : ne supprime pas la fragilité localhost (le navigateur charge toujours `https://localhost`). Demi-mesure.

Pourquoi Tauri plutôt qu'Electron ou jpackage : le cœur local n'a besoin que de PKCS#11 (lister un certificat, signer un digest), pas de DSS. Donc pas de JRE dans l'app. Tauri donne une webview système (pas de Chromium embarqué) et un binaire petit. Le coût assumé : réécrire la partie PKCS#11 en Rust et la revalider sur carte réelle.

## Périmètre & forme

L'app EU-DSS est un client de signature et de validation natif, à UI embarquée, qui fonctionne selon deux modes :

- Mode autonome : l'utilisateur ouvre l'app, choisit un fichier local, signe ou valide.
- Mode déclenché depuis le web : une page web (par exemple un Drive) ouvre un deep-link `eudss://sign?...` ou `eudss://validate?...` qui lance ou réveille l'app pour une opération ciblée.

Répartition des rôles :
- Tout ce qui ne touche pas au token reste dans le web hébergé : parcourir, gérer, valider en direct, initier une signature.
- L'app ne détient localement qu'une seule capacité : PKCS#11 (accès au token). Le reste (préparer, assembler, valider) est délégué au backend hébergé.
- La validation ne nécessite pas de token : une page web peut valider en direct via le backend sans lancer l'app. L'app expose quand même la validation, pour une UX unifiée et pour les fichiers locaux.

L'apparence et l'ergonomie de l'UI embarquée sont hors de cette spec : elles font l'objet d'une passe de design UX/UI dédiée. Cette spec définit seulement ce que l'UI doit exposer (les opérations et leurs états).

## Architecture cible

### App EU-DSS (Tauri)

Deux couches dans un seul binaire :

- Webview (UI embarquée) : le React actuel, réutilisé. Aperçu du document, choix du niveau et du format, saisie du PIN, états et résultats. Code chargé localement depuis le bundle de l'app (pas une page distante), donc le pont IPC reste en même origine et on n'injecte aucun pouvoir de signature dans une page venue du réseau.
- Cœur Rust :
  - PKCS#11 via la crate `cryptoki` : charger la librairie du middleware, ouvrir une session, login PIN, trouver le certificat et la clé de signature, signer le digest.
  - Client HTTPS sortant vers le backend hébergé (appels normaux, pas de serveur local en écoute).
  - Handler de deep-link `eudss://` avec instance unique (router une nouvelle invocation vers l'app déjà ouverte).
  - Pont IPC entre la webview et le Rust (les commandes de la section « Cœur de signature »).

Dépendance externe inchangée : le middleware du fournisseur (IDOPTE / ChamberSign) doit être installé sur la machine. L'app le détecte et guide si absent.

### Backend DSS hébergé (Spring Boot)

Inchangé dans ses responsabilités existantes :
- `POST /api/sign/prepare` et `POST /api/sign/assemble` (interface `DocumentSigner` : `dataToSign` puis `sign`), dispatch par `SigningFormat`.
- `POST /api/validate`.

Ajouts (section « Backend : ajouts ») :
- Une API de jobs pour le déclenchement depuis le web.
- Un `DocumentSigner` pour le XAdES détaché et un sélecteur de format explicite.

### Web app hébergé (navigateur)

Inchangé dans son rôle, mais le déclenchement de signature passe désormais par la création d'un job puis l'ouverture d'un deep-link, au lieu d'appeler `https://localhost`.

## Flux de données

Invariant général : le document monte vers le backend hébergé (comme aujourd'hui). Le PIN et le token restent strictement locaux. Le token ne voit que le digest. Aucun pont navigateur vers localhost.

### Signer (mode autonome)

1. App : lister les certificats (local, PKCS#11).
2. App vers backend : `POST /api/sign/prepare` (document, chaîne de certificats, paramètres) renvoie le digest à signer.
3. App : saisie PIN, login, `C_Sign` du digest sur le token (local).
4. App vers backend : `POST /api/sign/assemble` (document, signature, mêmes paramètres) renvoie le document signé.
5. App : enregistrer le document signé en local.

### Signer (déclenché depuis le web)

1. Page web : l'utilisateur clique « Signer ». La page demande au backend de créer un job, qui renvoie un identifiant de job et un jeton d'accès à usage unique.
2. Page web : ouvre `eudss://sign?job=<id>&token=<jeton>`. L'OS lance ou réveille l'app.
3. App vers backend : récupère le job (document à signer, contexte) en HTTPS normal.
4. App : même chaîne prepare, signature locale, assemble que le mode autonome.
5. App vers backend : soumet le document signé au job. Le backend le stocke et notifie l'initiateur (webhook ou polling de la page).

### Valider

- Depuis le web en direct : page vers backend `POST /api/validate`. Pas d'app, pas de token.
- Depuis l'app (autonome ou via `eudss://validate`) : app vers backend `POST /api/validate`. Pas de token.

## Types de signature supportés

Tout est géré côté backend DSS. L'app est agnostique au format : elle ne fait que signer le digest que le backend lui renvoie.

| Entrée | Format de signature | Niveau | Notes |
| --- | --- | --- | --- |
| PDF | PAdES (dans le PDF) | BASELINE B, T | Signature invisible (MVP). |
| docx, xlsx, pptx, ODF, autres | XAdES dans ASiC-E (.asice) | BASELINE B, T | Conteneur signé. |
| Fichier quelconque (XML ou binaire) | XAdES détaché (.xml séparé) | BASELINE B, T | NOUVEAU. Référence le fichier par URI, ne le modifie pas. Validation = signature plus fichier d'origine. |
| Co-signature | N signatures indépendantes (PDF incrémental, ASiC ou XAdES détaché add-signature) | idem | Signer un document déjà signé. Batch « tout signer » en une session token. |
| Validation | Tous les formats ci-dessus | s.o. | Délègue au backend. Pas de token. |

Périmètre figé : parité avec l'incrément A (PAdES-B-T et ASiC-E/XAdES-B-T, co-signature, signature invisible), plus le XAdES détaché. Les niveaux LT et LTA, et les signatures visibles, sont des incréments futurs séparés (travail backend, indépendant de l'app).

Crypto : pas de hardcode. Le cœur Rust signe avec le mécanisme impliqué par la clé du certificat (le `keyId` choisi) et le digest fourni par le backend, parmi ce qu'expose le middleware IDOPTE : RSA PKCS#1 v1.5, RSA-PSS, ECDSA, avec SHA-256, 384 ou 512. Le cœur interroge `C_GetMechanismList` pour échouer proprement si un algo demandé n'est pas disponible. Cartes réelles actuelles : RSA-2048 et SHA-256.

## Cœur de signature en Rust (PKCS#11)

C'est la partie critique pour l'eIDAS et le seul vrai risque technique. Elle doit reproduire fidèlement le comportement de l'agent Java actuel.

### Contrat à reproduire (identique à l'agent actuel)

L'agent expose aujourd'hui `GET /rest/status` et `/rest/certificates`, `POST /rest/unlock`, `/rest/lock` et `/rest/sign`, où `/rest/sign` prend `{keyId, digestBase64, digestAlgorithm}` et renvoie `{signatureValueBase64}`. Le cœur Rust reproduit ce contrat opération par opération, mais via IPC au lieu de HTTP.

### Surface IPC exposée à la webview

Mêmes opérations, mêmes formes de données que `agentApi.ts` aujourd'hui, pour que le React change à peine (`agentApi.ts` devient une implémentation IPC Tauri) :

- `status()` renvoie l'état de session (déverrouillé, secondes restantes, mode).
- `unlock(pin)` ouvre la session (login token).
- `lock()` reverrouille.
- `list_certificates()` renvoie les certificats du token (keyId, certificat et chaîne en base64, DN, numéro de série, validité).
- `sign(keyId, digestBase64, digestAlgorithm)` renvoie la valeur de signature.

### Algorithme de signature

Le `keyId` désigne une clé dont le type (RSA ou EC) détermine le mécanisme. Pour RSA PKCS#1 v1.5, signer la structure DigestInfo construite à partir du digest et de l'algorithme (mécanisme `CKM_RSA_PKCS`). Pour ECDSA, signer le digest brut (`CKM_ECDSA`). Le digest et son algorithme viennent du backend (déjà paramétré en SHA-256, 384, 512). Le but est de produire exactement la même valeur de signature que DSS aujourd'hui.

### Garde-fous à reproduire à l'identique

Comportements de sécurité durement acquis côté Java, à porter tels quels :
- PIN demandé au moment de signer, jamais au démarrage.
- PIN remis à zéro en mémoire (zeroization) après usage.
- Session à TTL d'inactivité avec re-verrouillage automatique.
- Aucun retry automatique sur PIN incorrect (sécurité anti-blocage de la carte).
- Codes d'erreur structurés équivalents : `pin_incorrect`, `pin_locked`, `token_unavailable`, `locked`.

### Dérisquage par oracle

L'agent Java reste l'oracle de référence pendant tout le développement :
- Pour les mécanismes déterministes (RSA PKCS#1 v1.5) : signer le même digest sur la même carte via Java et via Rust, comparer octet à octet.
- Pour les mécanismes aléatoires (RSA-PSS, ECDSA) : vérifier cryptographiquement que la signature Rust valide bien contre la clé publique, et qu'un aller-retour DSS complet (prepare, sign, assemble, validate) retourne TOTAL_PASSED.
- Validation sur les trois OS avant de retirer l'agent.

## Backend : ajouts

### API de jobs (déclenchement web)

- Créer un job : appelé par l'initiateur web. Corps : le document (inline en base64) ou une référence récupérable par le backend, plus les paramètres de signature (format, niveau, raison, lieu) et un callback de notification. Réponse : identifiant de job, jeton d'accès à usage unique, date d'expiration.
- Récupérer un job : appelé par l'app avec le jeton du deep-link. Renvoie le document à signer et le contexte.
- Compléter un job : appelé par l'app, soumet le document signé. Le backend le stocke et notifie l'initiateur.

Sécurité des jobs :
- Identifiant non devinable et jeton à usage unique, courte durée de vie, lié à l'utilisateur ou à la session initiatrice.
- Le jeton transite dans le deep-link (une URL visible) : il doit être à usage unique et expirer vite. Option à trancher au plan : échanger le jeton du deep-link contre un jeton de session côté app, plutôt que de le réutiliser tel quel.

### XAdES détaché et sélecteur de format

- Nouveau `DocumentSigner` pour le XAdES détaché (`SignaturePackaging.DETACHED`), à côté de PAdES et ASiC-E/XAdES.
- Le `SigningFormat` actuel se dérive du seul nom de fichier (PDF vers PADES, sinon ASIC). Ce n'est plus suffisant : un fichier non PDF peut viser ASiC ou XAdES détaché. Ajouter un sélecteur de format explicite dans la requête (avec défaut sur le comportement actuel) pour distinguer les deux.

Le reste (`prepare`, `assemble`, `validate`) est inchangé.

## UI embarquée

- Réutilise le React actuel. Le seul point d'intégration technique est le remplacement de `agentApi.ts` (qui appelle `https://localhost:9795`) par une implémentation IPC Tauri de même interface. `backendApi.ts` est inchangé (appels HTTPS normaux vers le backend hébergé).
- Doit exposer : connexion au token et liste de certificats, saisie PIN et état de session, signature d'un ou plusieurs fichiers avec choix du format et du niveau, batch « tout signer » en une session, validation, et le rendu d'un job entrant via deep-link.
- Le wizard de prérequis (détecter et guider si le middleware est absent) est conservé, intégré dans l'app.
- L'apparence et le parcours fin relèvent de la passe de design UX/UI dédiée, hors de cette spec.

## Packaging, signature de code, mises à jour

- Bundles Tauri par OS et architecture : `.msi` ou `.exe` (Windows), `.dmg` ou `.app` (macOS), `.deb` et `.AppImage` (Linux), x64 et arm64 selon la matrice actuelle.
- Signature de code (même exigence qu'aujourd'hui pour le natif, pas un coût propre à l'option A) :
  - Windows : Authenticode. Viser une réputation SmartScreen immédiate via EV ou un service de signature cloud (Azure Trusted Signing). Depuis juin 2023, la clé doit être sur matériel ou service cloud.
  - macOS : Developer ID plus notarisation (obligatoire, sinon Gatekeeper bloque). Via l'équipe Apple Linagora. Tauri sait notariser dans son bundler.
  - Linux : pas requis pour éviter un avertissement. Signature GPG du dépôt en bonne pratique.
- Ce qui disparaît par rapport à aujourd'hui : provisionnement et trust du certificat localhost auto-signé (tout le mécanisme SP2), CORS, Private Network Access, et l'autostart en service de fond. L'app se lance à la demande ou via deep-link.
- Mises à jour : auto-updater Tauri, artefacts signés avec une clé minisign dédiée (indépendante de la signature OS).
- L'installeur enregistre le scheme `eudss://` auprès de l'OS.

## Migration & coexistence

- L'app Tauri est additive. L'agent Java et le flux web actuels restent fonctionnels pendant la transition (ils sont validés sur carte réelle et servent d'oracle).
- Séquence : livrer l'app A, valider le cœur Rust contre l'oracle Java sur les trois OS, puis basculer la documentation et l'onboarding vers l'app, puis déprécier l'agent.
- Le backend sert les deux pendant la transition, sans changement cassant pour `prepare`, `assemble`, `validate`.

## Hors périmètre

- Embarquer DSS en local (offline complet). Rejeté.
- Niveaux LT et LTA, et signatures visibles. Incréments futurs séparés.
- Parapheur ou workflow d'approbation. Non requis.
- Signature de mail S/MIME et signature serveur à la DocuSign. Déjà exclus du projet.
- Conception visuelle de l'UI embarquée. Passe de design UX/UI dédiée.

## Risques & mitigations

- Réécriture PKCS#11 sur la partie eIDAS critique. Mitigation : oracle Java, comparaison octet à octet pour le déterministe, vérification cryptographique pour l'aléatoire, sur trois OS.
- Rust nouveau pour l'équipe. Mitigation : la partie risquée (PKCS#11) est petite et bornée ; le reste du cœur Rust est de la glue (HTTPS, deep-link, IPC).
- Middleware arm64. Déjà un point ouvert du projet ; à vérifier comme bloquant éventuel par OS et architecture.
- Sécurité du deep-link et des jobs. Mitigation : identifiants non devinables, jetons à usage unique et à courte vie, portée utilisateur ; option d'échange de jeton côté app.
- Injection IPC. Écartée par conception : l'UI est embarquée, on n'injecte aucune capacité native dans une page distante.

## Critères d'acceptation

- Sur les trois OS (Windows, macOS, Linux), avec une carte ChamberSign réelle : connexion au token, liste du certificat qualifié, signature d'un PDF en PAdES-B-T, validation TOTAL_PASSED.
- Égalité octet à octet entre la signature Rust et la signature de l'agent Java pour le même digest sur la même carte (RSA PKCS#1 v1.5).
- Signature ASiC-E/XAdES-B-T d'un fichier office, et XAdES détaché d'un fichier quelconque, validés TOTAL_PASSED.
- Déclenchement depuis une page web : `eudss://sign?job=...` lance l'app, qui récupère le job, signe, et renvoie le document signé ; la page est notifiée.
- Validation déclenchée depuis le web en direct (sans app) et depuis l'app.
- Aucune dépendance à un pont navigateur vers localhost : pas de certificat localhost, pas de CORS, pas de Private Network Access dans la boucle de signature.
- App pas installée : le deep-link ne fait rien, la page détecte le timeout et propose le téléchargement.
