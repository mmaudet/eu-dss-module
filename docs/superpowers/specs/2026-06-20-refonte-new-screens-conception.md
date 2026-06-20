# Conception : nouveaux écrans de la refonte (Phase 2)

Date : 2026-06-20 · Branche : `feat/ui-refonte` · Portée : les écrans présents dans la maquette (`eu-dss-ui/design-ref/EU-DSS-Sign.dc.html`) mais absents de l'app. Complète le plan `2026-06-20-ui-refonte.md` (cette note couvre le COMMENT ça marche, pas seulement le visuel). Priorité : l'onboarding.

## Avertissement d'architecture (important)

La maquette a été dessinée AVANT le pivot Tauri (Plan 2). Elle parle encore d'un « agent local · localhost:9795 ». Dans l'app réelle, **il n'y a plus d'agent localhost** : le coeur de signature PKCS#11 est dans l'app (IPC), et le DSS est un backend hébergé. Donc tout contrôle de prérequis qui dit « agent local » doit être **re-mappé** :

- ancien modèle (maquette) : middleware + agent(localhost:9795) + clé.
- modèle réel (Tauri) : **(1) middleware / module PKCS#11 chargeable**, **(2) token présent + certificat lisible** (commande IPC `list_certificates`, sans PIN), **(3) backend DSS hébergé joignable** (nécessaire pour `prepare`/`assemble`/`validate`, donc pour le test de signature).

Le « localhost:9795 » de la maquette devient « coeur de signature in-app (toujours présent) » ; on le remplace par le contrôle (3) backend, qui est le vrai prérequis réseau.

---

## 1. Onboarding : wizard de premier lancement (priorité)

### Objectif

Imposé au tout premier démarrage. Il ne se contente PAS de détecter les prérequis : il **teste réellement toute la boucle** en signant un document interne de test (déverrouillage + signature sur la carte + assemblage + validation eIDAS), puis ne réapparaît plus, sauf si un problème est détecté à un lancement ultérieur. C'est la version produit du self-test carte réelle (`eudss-signer/oracle`).

### Flux (4 frames, maquette `WIZARD PREMIER LANCEMENT`)

1. **Prérequis détectés** : auto-détection des 3 contrôles re-mappés ci-dessus. Chaque ligne : icône + libellé + état (OK / Détecté / En attente). Bouton « Continuer vers le test du PIN » actif seulement si les 3 sont au vert.
2. **Test du PIN** : « Testons la boucle de signature ». L'app signe un **document de test interne** (jamais conservé, PIN jamais enregistré). L'utilisateur saisit son PIN via le pavé. Bouton « Tester la signature ».
3. **Vérification de la boucle** : spinner + checklist live : « Carte déverrouillée (PIN correct) » → « Empreinte signée par la carte » → « Validation eIDAS du test ».
4. **Terminé** : « Tout fonctionne ». Persiste le flag d'onboarding réussi. Mention « aux prochains lancements vous arriverez directement sur l'écran principal ». Bouton « Entrer dans EU-DSS Sign ».

### Le « document de test interne »

Un petit PDF d'1 page bundlé dans l'app (`eu-dss-ui/src/assets/test-doc.pdf`, ou généré en mémoire). Signé via le **flux réel exact** : `backendApi.prepare` (HTTP plugin) → `agentApi.signDigest` (IPC, carte) → `backendApi.assemble` → `backendApi.validate`. Le résultat n'est jamais affiché ni enregistré ; on garde seulement le verdict (TOTAL_PASSED ou non). Cela prouve la boucle complète sans demander de document à l'utilisateur. Réutilise tel quel le `signOne`/`runBatch` existant (un doc, niveau B-T).

### Sécurité PIN (réutiliser les garanties existantes)

Le test de signature passe par le même chemin `unlock` + `sign` que l'app : **une seule tentative de login, aucun retry automatique** (le coeur Rust le garantit déjà). La carte a un nombre d'essais limité : un PIN faux dans le wizard coûte AU PLUS une tentative, comme partout ailleurs. Afficher l'avertissement carte-lock et, sur `pin_locked`, router vers l'écran PUK (section 5).

### Gating + persistance

L'app est aujourd'hui SANS état. Ajouter un petit store local persistant (`@tauri-apps/plugin-store` dans l'app, `localStorage` en fallback web) avec un flag `onboarding.passed = true|false` et la date. Logique de réapparition : au démarrage, si `!passed` OU si un prérequis critique manque (module/token/backend), montrer le wizard ; sinon, écran principal. Le wizard est aussi rouvrable depuis l'écran Prérequis.

### États d'échec (à concevoir explicitement)

- **Un prérequis manque** (frame 1) : la ligne passe en orange « En attente » + actions « Réessayer la détection » / « Besoin d'aide » (lien doc d'install). Le bouton Continuer reste désactivé.
- **Backend injoignable** au test (frame 2/3) : `prepare` échoue. Afficher « Service de signature indisponible » (pas une erreur de carte), proposer Réessayer. NE PAS brûler de tentative PIN (le `prepare` échoue avant tout login ; ordonner prepare AVANT le unlock pour garantir ça, comme `oracle/compare.sh`).
- **PIN incorrect** : 1 essai consommé, re-prompt, avertissement essais restants.
- **Carte bloquée** (`pin_locked`) : router vers l'écran PUK (section 5).

### Machine d'état

`detecting → ready → testing(prepare → unlock → sign → assemble → validate) → passed | failed(reason)`. `reason ∈ {prereq, backend, pin_incorrect, pin_locked, validate_failed}`. Composant `components/FirstRunWizard.tsx`, monté au-dessus du shell quand `!passed`, consommant `AgentContext` + `backendApi` (aucune logique nouvelle de signature, on réutilise l'existant).

---

## 2. Écran Prérequis (rouvrable)

Version autonome et rouvrable de la frame 1 du wizard, accessible depuis la sidebar (« Prérequis »). Même détection re-mappée (module / token+cert / backend), barre de progression, lignes d'état, « Continuer vers Signer » actif quand tout est prêt. S'ouvre auto au 1er lancement (c'est le wizard), rouvrable à tout moment. Promeut `services/prerequisites` + `PrerequisitesPanel` existants en écran plein. Mostly réutilisation ; pas de capacité nouvelle.

---

## 3. Écran Clé & certificat

- **Carte token (gauche)** : illustration USB, pastille « Connectée · verrouillée|déverrouillée » (depuis `useAgent().locked`), Modèle (ChamberSign IAS-ECC), Slot · interface (`0 · PKCS#11`), Session (PIN requis / active). Actions : **Déverrouiller** (= flux unlock existant, OK) ; **Changer le PIN** (HORS PÉRIMÈTRE app : c'est le domaine du middleware IDOPTE / de l'émetteur ; masquer ou rediriger vers l'outil middleware, ne PAS prétendre le faire).
- **Détails certificat (droite)** : Titulaire / Organisation / Émetteur / Validité / Usage / N° de série / Empreinte SHA-256, badge « QC · eIDAS ». Toutes ces données viennent du `selectedCert` (`CertEntry`) déjà fourni par l'IPC. Actions : **Exporter (.cer)** (FAISABLE : le cert est dans `certificate_base64`, écrire via le fs plugin / la sauvegarde native) ; **Chaîne de confiance** (PARTIEL : le token ne renvoie que le leaf ; la chaîne complète est côté backend via AIA/LOTL ; soit afficher juste le leaf + émetteur, soit un appel backend dédié plus tard).

Écran surtout en lecture. Drapeaux de périmètre : « Changer le PIN » hors périmètre, « Chaîne de confiance » à approfondir.

---

## 4. Accueil / tableau de bord (caveat persistance)

L'écran montre des **stats** (« 24 documents signés ce mois », « 18/18 vérifications ») et une **activité récente**. L'app est SANS état : elle signe et oublie. Donc ces chiffres impliquent une **fonctionnalité d'historique qui n'existe pas**. Conception :

- **Réel maintenant** : la carte hero (cert depuis `AgentContext`) + les 2 actions rapides (Signer / Vérifier). On les branche.
- **Stats + activité récente** : deux options. (a) états vides honnêtes (« Aucune activité enregistrée pour le moment ») ; (b) ajouter un **historique local léger** : à chaque signature/vérification terminée, enregistrer une entrée (nom, date, format, verdict) dans le store local (section Cross-cutting). Recommandation : (b) light pour rendre l'écran vivant et vrai, avec état vide tant qu'il n'y a pas de données. **Ne jamais afficher de chiffres fabriqués.** Décision à valider avec l'utilisateur avant d'implémenter l'Accueil.

---

## 5. Écran PUK / carte bloquée

Déclenché quand le coeur renvoie `pin_locked` (essais PIN épuisés). L'app **ne peut pas débloquer** la carte : le PUK relève de l'émetteur / du middleware IDOPTE, pas de PKCS#11 côté app. Conception : un écran qui **explique** (carte bloquée, déblocage par PUK nécessaire) et **guide** (ouvrir l'outil middleware IDOPTE, contacter ChamberSign), sans prétendre exécuter le déblocage. Drapeau de périmètre clair : guider, pas exécuter.

---

## 6. Thème sombre + langue (rappel)

- **Sombre** : un second bloc de variables CSS `[data-theme="dark"]` (maquette `15/17 THEME SOMBRE`) + le toggle sidebar (persisté dans le store). Trivial une fois la Phase 1 entièrement tokenisée.
- **Langue FR/EN** : i18n derrière le toggle (stretch). Tous les libellés sont en français aujourd'hui ; extraire dans un dictionnaire.

---

## Cross-cutting : ce qu'il faut introduire

- **Couche de persistance locale** (nouveau pour l'app, aujourd'hui stateless) : `@tauri-apps/plugin-store` (app) + `localStorage` (web). Porte : (1) flag onboarding `passed`+date, (2) préférences thème/langue, (3) optionnel : historique signatures/vérifs pour l'Accueil. Petit, mais c'est un vrai ajout (pas que du CSS).
- **Asset de test** : le PDF interne de test du wizard.
- **Drapeaux de périmètre** (capacités qui n'existent pas et qu'on ne doit pas simuler) : Changer le PIN, déblocage PUK, stats/historique (sans la couche persistance), chaîne de confiance complète. Pour chacun : ou bien on construit la vraie capacité, ou bien on guide/masque honnêtement, jamais on ne fabrique.

## Ordre suggéré (Phase 2)

1. Couche persistance locale (socle de l'onboarding + thème + historique).
2. **Onboarding** (le plus de valeur : il fiabilise le premier lancement et réutilise tout le flux existant).
3. Écran Prérequis (rouvrable, partage la détection de l'onboarding).
4. Clé & certificat (lecture + Exporter .cer).
5. Accueil (après décision sur l'historique).
6. Thème sombre, puis PUK, puis i18n.
