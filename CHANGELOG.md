# Journal des modifications

Toutes les évolutions notables de **EU-DSS Sign** sont consignées dans ce fichier.

Le format s'inspire de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet suit le [versionnage sémantique](https://semver.org/lang/fr/).

## [1.2.0] — 2026-06-23

### Ajouté
- **Vérification des signatures détachées.** L'onglet *Vérifier* valide désormais une
  signature détachée avec son document source. Une zone de dépôt unique « intelligente »
  classe le fichier déposé (côté backend) et ne réclame le second fichier que si
  nécessaire, avec détection automatique du rôle (signature déposée d'abord → demande le
  document source ; document déposé d'abord → demande le fichier de signature).
- Champ **`overallIndication`** dans la réponse `POST /api/validate` — le verdict
  cryptographique (`TOTAL_PASSED` / `TOTAL_FAILED` / `INDETERMINATE`) est maintenant
  explicite dans l'API, et plus seulement dérivé dans l'interface.

### Supprimé
- **Génération de signatures XAdES détachées.** L'application ne produit plus que des
  signatures auto-suffisantes (PAdES / ASiC-E / XAdES enveloppant) ; toute demande de
  signature détachée via l'API est rejetée (HTTP 400). Les signatures détachées produites
  par d'autres outils restent *vérifiables* (voir « Ajouté »).

### Sécurité
- Le validateur ne récupère plus les données de révocation (OCSP / CRL / AIA) pour les
  chaînes de certificats **non fiables** (`setCheckRevocationForUntrustedChains(false)`),
  fermant un vecteur SSRF où une signature fournie (non fiable) pouvait déclencher des
  requêtes sortantes arbitraires.
- Les réponses d'erreur de l'API renvoient des messages statiques au lieu d'exposer le
  texte d'exception interne.

### Corrigé
- Une entrée vide ou malformée est classée « pas une signature » au lieu de renvoyer un
  HTTP 500.
- La vérification par deep-link (`eudss://verify`) signale clairement les signatures
  détachées (non prises en charge par le lien) et les documents non signés, au lieu de
  poster un résultat vide.
- L'interface de vérification est protégée contre les conditions de course lorsqu'un
  fichier est changé ou retiré en cours de validation.

### CI
- La version de release est lue depuis `tauri.conf.json` (source de vérité unique) ;
  plus aucune version n'est codée en dur dans le workflow de build.

## [1.1.0] — 2026-06-21

### Ajouté
- **Mode callback « passthrough » Twake Drive (cozy-stack)** pour les deep-links
  `eudss://` : auto-détecté par un paramètre `token` dans l'URL de callback, le
  rapport/résultat est envoyé en corps brut (raw bytes) avec un jeton `Bearer` et le nom
  porté dans l'URL (les callbacks JSON génériques restent inchangés).

### Modifié
- Branche par défaut renommée `eu-dss` → `main` (la CI construit sur `main` et les tags
  `v*`).

## [1.0.0] — 2026-06-21

Première version stable autonome.

### Ajouté
- **Application de bureau autonome** (Tauri) pour **signer et vérifier** des documents
  PAdES / XAdES / ASiC avec un token **PKCS#11**. Le backend EU DSS est embarqué en
  sidecar local — aucun serveur séparé à installer ni à lancer.
- **Deep-links `eudss://`** pour signer (`eudss://sign`) et vérifier (`eudss://verify`)
  des documents externes.
- **Installeurs signés** pour Windows (Azure Artifact Signing — `.exe` NSIS / `.msi`),
  macOS (signé Developer-ID + notarisé `.dmg`) et Linux (`.deb` / `.rpm`).
- Interface de marque (bouclier + coche), assistant de prérequis, pré-sélection du format
  de signature selon le type de fichier, PIN saisi au moment de signer, et retours de
  téléchargement.

[1.2.0]: https://github.com/mmaudet/eu-dss-module/releases/tag/v1.2.0
[1.1.0]: https://github.com/mmaudet/eu-dss-module/releases/tag/v1.1.0
[1.0.0]: https://github.com/mmaudet/eu-dss-module/releases/tag/v1.0.0
