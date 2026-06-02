# Design : PIN au moment de la signature (session déverrouillée à TTL idle)

Date : 2026-06-01 · Branche : `eu-dss` · Module(s) : `eu-dss-agent`, `eu-dss-ui`

## Problème

Aujourd'hui l'agent lit le PIN de la carte **une fois au démarrage** (`AgentConfig.loadPin()` :
env `EUDSS_AGENT_PIN`, sinon prompt console) et le réutilise en silence via
`PrefilledPasswordCallback` pour toute signature (`TokenService.token()` ouvre le token
paresseusement et le garde ouvert pour toujours). L'utilisateur attend que le PIN soit
demandé **au moment de signer**, pas au lancement de l'agent.

## État actuel (baseline)

- `AgentConfig.load()` → `fromEnv(env, os, loadPin())`. `loadPin()` lève une exception si ni
  `EUDSS_AGENT_PIN` ni console. Champ `pin` (char[]) porté par le record `AgentConfig`.
- `TokenService.token()` : ouvre `Pkcs11SignatureToken(driver, PrefilledPasswordCallback(pin), -1, slot, null)`
  au premier appel, met en cache l'instance (non re-loggée ensuite, jamais fermée sauf shutdown hook).
- `AgentMain` : `GET /rest/health`, `GET /rest/certificates` (→ `listCertificates()` = `getKeys()`,
  nécessite `C_Login`), `POST /rest/sign`. Erreur token → 503 `token_unavailable`.
- Driver Windows par défaut désormais `C:\Program Files\Smart Card Middleware\bin\idoPKCS.dll`
  (commit `cea555d`). Token ouvert sur slot 0 par défaut.

## Décisions (validées 2026-06-01)

1. **Collecte du PIN** : l'UI (navigateur) demande le PIN au moment de signer et l'envoie à
   l'agent local via **HTTPS-localhost** ; l'agent ouvre le token avec ce PIN. (Pas le pavé PIN
   natif du middleware ; pas de saisie stricte par signature.)
2. **Durée de session** : **idle timeout ~300 s** (configurable `EUDSS_PIN_SESSION_TTL`), réarmé
   à chaque usage. Un « sign all » = une seule saisie.
3. **API** : endpoints de session **explicites** (`/rest/unlock`, `/rest/lock`, `/rest/status`) ;
   `/rest/certificates` et `/rest/sign` renvoient **401 `locked`** si verrouillé.
4. **Mauvais PIN** : remonter l'erreur PKCS#11, **jamais de retry automatique**, l'UI avertit du
   risque de blocage carte. Compteur de la carte = source de vérité (pas de compteur agent).
5. **Compat headless** : `EUDSS_AGENT_PIN` **optionnel** (défaut off) → si défini, auto-unlock au
   démarrage + **pas d'idle-lock** (mode `headless`, re-login à la demande). Si absent → verrouillé
   jusqu'à `/rest/unlock` (mode `interactive`). Suppression du prompt console au démarrage.

## API agent (cible)

| Méthode | Endpoint | Corps | Réponses |
|--------|----------|-------|----------|
| POST | `/rest/unlock` | `{ "pin": "1234" }` | `200 {status:"unlocked", expiresInSeconds}` · `401 {error:"pin_incorrect", message}` · `423 {error:"pin_locked", message}` · `503 {error:"token_unavailable", message}` |
| POST | `/rest/lock` | *(aucun)* | `200 {status:"locked"}` |
| GET | `/rest/status` | *(aucun)* | `200 {unlocked:bool, expiresInSeconds:int\|null, mode:"interactive"\|"headless"}` |
| GET | `/rest/certificates` | *(aucun)* | `200 {certificates:[...]}` (réarme le timer) · `401 {error:"locked"}` |
| POST | `/rest/sign` | `{keyId,digestBase64,digestAlgorithm}` | `200 {signatureValueBase64}` (réarme le timer) · `401 {error:"locked"}` · 400/500 inchangés |
| GET | `/rest/health` | *(aucun)* | `200 {status:"ok"}` (inchangé, ne touche jamais le token) |

Nouveaux DTO : `UnlockRequest(String pin)`, `StatusResponse(boolean unlocked, Long expiresInSeconds, String mode)`.
En-tête `Access-Control-Allow-Private-Network: true` et règles CORS s'appliquent aussi aux nouveaux endpoints (le `before`/plugin CORS couvre toutes les routes).

## Session & sécurité (TokenService)

- `unlock(char[] pin)` : ouvre `Pkcs11SignatureToken` avec `PrefilledPasswordCallback(pin)`,
  **force le login** (ex. `getKeys()`), met en cache le token **ouvert+loggé**, enregistre
  `lastUsedAt`, planifie/réarme la tâche d'idle-lock, puis **`Arrays.fill(pin, '\0')`**. Sur PIN
  incorrect/bloqué, l'ouverture échoue → propager l'exception, **ne pas** mettre en cache, **ne pas** retenter.
- `lock()` : `token.close()` (logout + fermeture), `token=null`, annule la tâche d'idle-lock. Idempotent.
- `touch()` : appelé par certificates/sign en cas de succès → met à jour `lastUsedAt` et re-planifie l'idle-lock à `now + TTL`.
- `isUnlocked()` / `expiresInSeconds()` pour `/rest/status`.
- **On ne met JAMAIS en cache le `char[]` du PIN** en mode interactif (on garde le token ouvert,
  pas le secret). Exception : mode `headless` (env-PIN) où l'agent conserve le PIN pour pouvoir
  auto-unlock/re-login sans UI ; dans ce mode l'idle-lock est désactivé.
- Idle-lock : un `ScheduledExecutorService` à 1 thread (daemon). `lock()` exécuté sur expiration.
  Thread-safety : `unlock`/`lock`/`touch`/`token()` synchronisés (le token est `volatile`).

## Config (AgentConfig)

- Supprimer `loadPin()` (plus de prompt console, plus d'exception au démarrage).
- `pin` → optionnel (`char[]` nullable, présent seulement si `EUDSS_AGENT_PIN` non vide).
- Nouveau : `int pinSessionTtlSeconds` depuis `EUDSS_PIN_SESSION_TTL` (défaut `300`).
- `mode` dérivé : `headless` si `EUDSS_AGENT_PIN` présent, sinon `interactive`.
- `AgentMain.main()` : si mode headless → `tokenService.unlock(envPin)` au démarrage (best-effort,
  log un warning si échec mais l'agent démarre quand même verrouillé).

## UI (eu-dss-ui)

- `agentApi` : ajouter `unlock(pin): Promise<...>`, `lock()`, `getStatus()`. Les appels
  `certificates()`/`sign()` qui reçoivent **401 `locked`** déclenchent le prompt PIN.
- **Modale PIN** (nouveau composant) : champ masqué, bouton « Déverrouiller », affiche les erreurs
  `pin_incorrect`/`pin_locked` avec **avertissement explicite « la carte se bloque après ~3 essais »**.
  Le PIN n'est **jamais** stocké au-delà de l'appel `unlock`.
- **Indicateur de session** dans `SignWorkspace` : 🔒 verrouillé / 🔓 déverrouillé (+ minuteur),
  bouton « Verrouiller ». Statut via `getStatus()` (au montage + après actions ; pas de polling agressif).
- Flux « sign all » : avant le lot, si verrouillé → modale PIN → `unlock` → puis le lot s'exécute
  (un seul unlock couvre le lot dans le TTL). Idle-lock en cours → 401 au doc suivant → re-prompt.

## Flux de données (3 round-trips inchangé, unlock préfixé)

```
0. (si verrouillé) UI → agent POST /rest/unlock {pin} → session ouverte (TTL)
1. UI → agent GET /rest/certificates → chaîne de cert (session déverrouillée)
2. UI → backend POST /api/sign/prepare → dataToSign + digest
3. UI → agent POST /rest/sign {keyId, digest, algo} → signatureValue
4. UI → backend POST /api/sign/assemble → document signé
   (étapes 1–4 par document en « sign all » ; unlock une fois pour le lot)
```

## Gestion d'erreur (mapping PKCS#11 → HTTP)

- `CKR_PIN_INCORRECT` → **401** `pin_incorrect`
- `CKR_PIN_LOCKED` (et `CKR_PIN_EXPIRED`/locked) → **423** `pin_locked`
- Autre erreur d'ouverture/token → **503** `token_unavailable`
- Détection best-effort en parsant le message/cause de la `DSSException`→`ProviderException`→
  `PKCS11Exception` (contient le code `CKR_*`). Fallback : 503 générique. **À confirmer** avec
  IDOPTE (formulation possiblement différente) lors d'un test réel.

## Tests

- **Unitaires `TokenService`** (token stubbé, sans vrai PKCS#11) : `unlock`→`isUnlocked()` true ;
  `lock`→ false ; idle-lock après TTL (TTL court injecté) ; `touch` réarme ; double-unlock idempotent ;
  PIN incorrect (stub qui lève) → exception propagée, pas de cache.
- **Unitaires `AgentConfig`** : TTL défaut 300 + override ; `pin` absent par défaut, présent si env ;
  `mode` headless/interactive.
- **Endpoints (`AgentHttpSmokeTest`)** : `/rest/status` → verrouillé par défaut ; `/rest/sign` & 
  `/rest/certificates` → 401 `locked` quand verrouillé ; `/rest/unlock` (stub) → 200 unlocked + status le confirme ;
  `/rest/lock` → 200 + status verrouillé ; mapping mauvais-PIN → 401 `pin_incorrect`.
- **`FullStackE2ETest`** : ajouter un `/rest/unlock` (stub) avant la signature.
- **UI** : `npm run build` vert + smoke navigateur (modale PIN s'affiche quand verrouillé, indicateur
  cadenas, déverrouillage → signature). Token réel = E2E manuel (macOS + Windows ARM64, déjà validés).

## Hors scope (YAGNI)

Pas de cache PIN persistant entre redémarrages de l'agent ; pas de gestion/déblocage PUK ; pas de
sélection multi-slot dans l'UI (slot reste en config `EUDSS_PKCS11_SLOT`) ; pas de pavé PIN natif middleware.

## Critères d'acceptation

1. Agent démarré **sans** `EUDSS_AGENT_PIN` → `/rest/status` `unlocked:false` ; `/rest/sign` → 401 `locked`.
2. `/rest/unlock` avec bon PIN → `unlocked:true` ; `/rest/certificates` puis `/rest/sign` réussissent.
3. Après `EUDSS_PIN_SESSION_TTL` d'inactivité → re-verrouillage auto ; nouvel appel → 401 `locked`.
4. `/rest/lock` → re-verrouillage immédiat.
5. Mauvais PIN → 401 `pin_incorrect`, **aucun** retry auto côté agent.
6. Agent démarré **avec** `EUDSS_AGENT_PIN` → auto-unlock, pas d'idle-lock (headless inchangé).
7. UI : un « sign all » de N documents = **une** saisie de PIN (dans le TTL).
8. Suite de tests verte ; `npm run build` vert.
