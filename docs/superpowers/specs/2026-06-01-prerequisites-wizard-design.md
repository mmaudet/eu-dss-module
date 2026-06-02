# Design : Prerequisites wizard (SP1 of zero-friction onboarding)

Date : 2026-06-01 · Branche : `eu-dss` · Module : `eu-dss-ui` (pur front, zéro changement agent)

## Contexte & problème

Un utilisateur lambda qui ouvre l'app de signature ne sait pas ce qu'il doit installer/lancer
(agent local, middleware ChamberSign/IDOPTE, token branché, certificat de l'agent à accepter).
Aujourd'hui l'UI n'a qu'une carte « première utilisation » minimale (agent injoignable → accepte
le cert). On veut un **panneau de prérequis** qui, à chaque chargement, détecte l'état et guide
l'utilisateur (avec liens de téléchargement des assets).

C'est **SP1** d'un onboarding zéro-friction en 2 sous-projets :
- **SP1 (ce spec)** : wizard/checklist de prérequis côté UI.
- **SP2 (séparé, plus tard)** : auto-bootstrap de l'agent (cert de confiance + auto-start au login),
  par-OS. Hors scope ici.

## État actuel (baseline)

- `eu-dss-ui/src/components/SignWorkspace.tsx` : carte « 1. Agent local » avec, si `agentStatus === 'unavailable'`,
  un encart « accepte le cert » (lien `https://localhost:9795/rest/health`) ; + l'indicateur cadenas
  (🔓/🔒 + bouton Verrouiller) et la modale PIN (`submitPin`) ajoutés par la feature PIN-at-signing.
- `eu-dss-ui/src/services/agentApi.ts` : `isAvailable()`, `getStatus()`, `unlock()`, `lock()`,
  `listCertificates()`, `signDigest()`, type `AgentError {status, code}`, `AgentSessionStatus {unlocked, expiresInSeconds, mode}`.

## Décisions (validées 2026-06-01)

1. **Détection = pur UI, endpoints existants** (`/health` via `isAvailable`, `/status` via `getStatus`).
   Pas de nouvel endpoint agent. Le couple token+middleware n'est **pas** vérifiable positivement ;
   il se **révèle en erreur** si un unlock renvoie `token_unavailable`.
2. **Liens = manifest config par-OS.** Liens directs là où l'asset existe (middleware ChamberSign ;
   MSI Windows une fois **publié en GitHub Release**) ; macOS → guide/doc tant qu'il n'y a pas de `.pkg`.
3. **UX = panneau checklist inline** en haut de l'onglet Signer (étend la carte « première utilisation »),
   **non bloquant** (l'onglet Valider reste accessible). Re-check au montage + bouton « Revérifier » +
   au retour d'onglet (`focus`/`visibilitychange`).

## Composants & fichiers

- **CREATE `eu-dss-ui/src/services/prerequisites.ts`**
  - `export type AgentOs = 'windows' | 'macos' | 'linux' | 'other'`
  - `export function detectOs(): AgentOs` : via `navigator.userAgentData?.platform` sinon `navigator.userAgent`
    (`/win/i`→windows, `/mac/i`→macos, `/linux/i`→linux, sinon other).
  - `export interface PrereqLinks { agentInstaller: { url: string; label: string; isGuide?: boolean }, middleware: { url: string; label: string }, docUrl: string }`
  - `export const PREREQ_MANIFEST: Record<AgentOs, PrereqLinks>` : config éditable :
    - `windows`: agentInstaller url = la GitHub Release du MSI (placeholder constant `WINDOWS_AGENT_MSI_URL` en tête de fichier, à pointer sur la release), label « Télécharger l'agent (MSI) » ; middleware url `https://support.chambersign.fr/pilotes/` ; docUrl `…`.
    - `macos`: agentInstaller `{ url: docUrl, label: 'Guide d’installation (macOS)', isGuide: true }` (pas de pkg) ; middleware `https://support.chambersign.fr/pilotes/` ; docUrl.
    - `linux`: idem macOS (guide) ; middleware ChamberSign.
    - `other`: tout en lien vers docUrl.
  - Le manifest est **la seule source à éditer** quand les assets bougent (URLs).
- **CREATE `eu-dss-ui/src/components/PrerequisitesPanel.tsx`** : la checklist (voir « États » plus bas).
  Props : l'état agent/session courant + callbacks (`onRecheck`, `onUnlock`, `onLock`).
- **MODIFY `eu-dss-ui/src/components/SignWorkspace.tsx`** : remplace le corps de la carte « Agent local »
  par `<PrerequisitesPanel/>` ; ajoute le re-check `focus`/`visibilitychange` ; mappe `token_unavailable`
  dans `submitPin` vers la guidance middleware.
- (Pas de changement à `agentApi.ts` : tout est déjà exposé.)

## Logique de check (dans SignWorkspace, alimente le panneau)

Un seul appel réseau : `agentApi.getStatus()`.
- **succès** → agent **joignable + cert accepté** ; on stocke `status` (→ `unlocked`).
- **rejette** (réseau/TLS) → agent **non prêt** : éteint, pas installé, OU cert non accepté
  (indistinguables en pur UI → guidance combinée).

Déclencheurs du check : `useEffect` au montage (déjà présent via `checkAgent`), bouton « Revérifier »,
et un listener `window` `focus`/`visibilitychange` (couvre « j'installe puis je reviens »). Garde anti-rafale :
ignorer un re-check si un autre est en cours.

## États rendus par le panneau

| Prérequis | Détection | Rendu |
|-----------|-----------|-------|
| **1. Agent local** | `getStatus()` ok ? | ✓ « Agent connecté » · ✗ « Agent non détecté » → boutons **[Télécharger l'agent]** (manifest OS), **[Accepter le certificat]** (`https://localhost:9795/rest/health`, nouvel onglet), **[Revérifier]** |
| **2. Carte / session** (si agent ok) | `status.unlocked` | ✓ « Carte déverrouillée » (+ minuteur `expiresInSeconds` libellé « re-verrou ~Ns » + bouton **Verrouiller**) · ○ « Verrouillée : clique Signer et saisis ton PIN » (état normal, pas une erreur) |
| **3. Middleware & token** | non vérifiable (Q1) | Ligne d'info passive : « Carte branchée + middleware ChamberSign requis » + **[Télécharger le middleware]** + **[Guide]**. **Révélé en erreur** si unlock → `token_unavailable` (voir ci-dessous). |

Le panneau est non bloquant : le reste de l'UI (upload docs, Valider) reste utilisable. Le bouton
« Signer » reste actif (déclenche la modale PIN si verrouillé, comportement déjà en place).

## Reveal `token_unavailable`

Dans `SignWorkspace.submitPin`, le mapping d'erreur passe de (pin_locked / pin_incorrect / autre) à :
- `pin_incorrect` → « PIN incorrect. » (inchangé)
- `pin_locked` → « Carte bloquée (PUK nécessaire). » (inchangé)
- **`token_unavailable` → « Carte non détectée ou middleware ChamberSign manquant. Branche la carte / installe le middleware. » + lien middleware (manifest OS).** (NOUVEAU)
- autre → message brut (inchangé)

(L'agent renvoie 503 `token_unavailable` au `/rest/unlock` quand `doOpenAndLogin` échoue faute de
driver/token ; c'est là que le besoin middleware/token se révèle, conformément à Q1.)

## Détection d'OS

`detectOs()` : `navigator.userAgentData?.platform` (Chromium récent) en priorité, fallback
`navigator.userAgent`. Mappe sur `windows|macos|linux|other`. Sert uniquement à choisir l'entrée du
manifest (liens). Aucune dépendance critique : `other` → tout pointe vers la doc.

## Étape ops (dans le plan, hors code UI)

Publier le **MSI Windows en GitHub Release** (asset public) → renseigner `WINDOWS_AGENT_MSI_URL` dans
`prerequisites.ts`. Tant que ce n'est pas fait, le lien Windows pointe vers `docUrl` (même motif que macOS).

## Tests

- **Unitaire** `prerequisites.ts` : `detectOs()` sur des `userAgent` stubés (win/mac/linux/other) ;
  le manifest expose bien une entrée par OS avec des URLs non vides.
- **Build** : `npm run build` vert (tsc + vite), 0 erreur TS.
- **Smoke manuel** : (a) agent éteint → panneau « Agent non détecté » + bouton Télécharger correspondant à l'OS + lien cert ; (b) agent up + verrouillé → « connecté / verrouillée » ; (c) après install agent → revenir sur l'onglet déclenche un re-check auto ; (d) unlock sans token → message middleware + lien.

## Critères d'acceptation

1. Au chargement, sans agent : le panneau affiche « Agent non détecté » + **[Télécharger l'agent]** pointant le bon asset selon l'OS + **[Accepter le certificat]** + **[Revérifier]**.
2. Agent up + verrouillé : « Agent connecté », « Carte verrouillée », bouton Signer fonctionnel (→ modale PIN).
3. Agent up + déverrouillé : « Carte déverrouillée » + minuteur + bouton Verrouiller.
4. Revenir sur l'onglet (focus) après avoir lancé/installé l'agent → re-check automatique sans recharger.
5. Échec unlock `token_unavailable` → message « carte/middleware manquant » + lien middleware.
6. `detectOs()` renvoie le bon OS pour des UA Windows/macOS/Linux ; `other` → liens vers la doc.
7. `npm run build` vert.
8. Aucun changement au module agent.

## Hors scope (YAGNI / SP2)

Cert de confiance (suppression de l'acceptation manuelle), auto-start de l'agent au login, installeur
macOS `.pkg`, détection positive du token (probe agent sans login), page de doc détaillée (deliverable
séparé qui partagera le contenu du manifest).
