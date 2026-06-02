# Design : SP2 Windows : cert de confiance + auto-start (piloté par le MSI)

Date : 2026-06-01 · Branche : `eu-dss` · Modules : `eu-dss-agent` (petits changements) + le build MSI (`.github/workflows/windows-installer.yml` + ressources WiX)

## Contexte & problème

Onboarding zéro-friction = SP1 (wizard, FAIT) + **SP2 (auto-bootstrap de l'agent)**. SP2 supprime les
deux dernières frictions : (a) l'étape « accepter le certificat auto-signé » de l'agent, et (b) avoir à
lancer l'agent manuellement. Ce spec couvre **SP2 pour Windows** (le MSI jpackage existe + VM de test prête).
**macOS = SP2b** (séparé : pkg + keychain + LaunchAgent) ; **Linux** plus tard.

## État actuel (baseline)

- Agent : `AgentTls` génère un cert auto-signé `CN=localhost` (+ SAN localhost/127.0.0.1, BouncyCastle) dans
  `~/.eudss-agent/agent-keystore.p12` (mot de passe `eudss-agent` ou `EUDSS_AGENT_TLS_PASSWORD`), réutilisé s'il
  existe ; Javalin SSL le sert sur `https://localhost:9795`. Le navigateur ne le connaît pas → étape « accepter le cert ».
- Windows : MSI via **jpackage** (CI `.github/workflows/windows-installer.yml`) ; launcher `EU-DSS Agent.exe`. Pas d'auto-start, pas de cert trusté.
- Release publiée : `eu-dss-agent-v0.1.0` (MSI x64) ; lien dans le wizard SP1.

## Décisions (validées 2026-06-01)

1. **Cert de confiance = CA/cert local trusté dans le magasin OS** (mkcert-style), pas de cert public sur domaine, pas de HTTP.
2. **Windows d'abord** ; macOS = SP2b.
3. **Piloté par l'installeur MSI** (admin à l'install, machine-wide), pas d'auto-bootstrap agent runtime.
4. **Cert généré par-machine, jamais embarqué** (clé privée shippée = MITM si fuite).
5. **Auto-start = lancement en session UTILISATEUR via `HKLM\…\Run`, PAS un service Windows.** Un service tourne
   en session 0 et ne verrait pas la carte (bug PC/SC débuggé 2026-06-01 : l'agent doit être dans la session de l'utilisateur).
6. On **trustе directement le cert auto-signé `localhost`** (pas de hiérarchie CA séparée) : un seul host, plus simple, suffisant.

## Composants

### A. Agent (`eu-dss-agent`) : petits changements

1. **Chemin keystore machine-wide sur Windows.** `AgentTls.defaultKeystorePath()` : si OS Windows →
   `C:\ProgramData\eudss-agent\agent-keystore.p12` ; sinon `~/.eudss-agent/agent-keystore.p12` (inchangé). Override possible via
   `EUDSS_AGENT_KEYSTORE`. Raison : l'install (SYSTEM) provisionne le cert et l'agent (lancé par l'utilisateur) doit lire le même fichier ;
   `~` diffère entre SYSTEM et l'utilisateur.
2. **Mode `--provision-cert`.** `AgentMain` : si `args` contient `--provision-cert`, l'agent **génère le keystore** (via
   `AgentTls.ensureKeystore`) s'il manque, **imprime le SHA-1 thumbprint + exporte le cert public en .cer** à côté du keystore
   (`C:\ProgramData\eudss-agent\agent.cer`), puis **sort** (n'écoute pas). Sert à l'install pour créer le cert AVANT de le truster.
   (En run normal, l'agent réutilise le keystore existant comme aujourd'hui.)
3. Aucune autre logique TLS ne change (le cert reste auto-signé localhost ; on ne fait que (1) le ranger machine-wide et (2) permettre à l'install de le générer/exporter).

### B. Installeur MSI : custom action (install + uninstall)

jpackage rend les custom actions pénibles → on customise via **`--resource-dir <dir>`** :
- Override du `main.wxs` généré par jpackage (jpackage lit les overrides nommés dans le resource-dir) pour déclarer :
  - une **CustomAction différée, non-impersonnée (donc élévée/SYSTEM), exécutée après `InstallFiles`** (install) ;
  - une **CustomAction au `Remove`** (uninstall).
- Scripts PowerShell bundlés dans l'app (`app\` ou dossier ressources), appelés par les custom actions :
  - **`provision-install.ps1`** :
    1. `& "C:\Program Files\EU-DSS Agent\EU-DSS Agent.exe" --provision-cert` → crée `C:\ProgramData\eudss-agent\agent-keystore.p12` + `agent.cer`.
    2. `certutil -addstore -f Root "C:\ProgramData\eudss-agent\agent.cer"` → truste le cert dans `LocalMachine\Root`.
    3. Écrit le thumbprint dans `C:\ProgramData\eudss-agent\trusted-thumbprint.txt` (pour un uninstall ciblé).
    4. `reg add "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "EU-DSS Agent" /t REG_SZ /d "\"C:\Program Files\EU-DSS Agent\EU-DSS Agent.exe\"" /f`.
  - **`provision-uninstall.ps1`** :
    1. `certutil -delstore Root <thumbprint>` (lu depuis trusted-thumbprint.txt).
    2. `reg delete "HKLM\…\Run" /v "EU-DSS Agent" /f`.
    3. Supprime `C:\ProgramData\eudss-agent\`.
- **Fallback si l'injection WiX dans le MSI jpackage est trop tordue** : un mini-wrapper (`.exe` Inno/bootstrapper) qui lance le MSI jpackage normal puis exécute `provision-install.ps1` en élévé, à la façon de `chambersign_smartcard.exe`. Décision à l'implémentation selon la faisabilité du `--resource-dir`.

### C. CI (`.github/workflows/windows-installer.yml`)

Passer `--resource-dir packaging/windows/wix-resources` (override `main.wxs` + bundle des `.ps1`) à l'appel jpackage. Versionner les ressources WiX + scripts sous `packaging/windows/`.

## Flux d'install (résultat attendu)

```
MSI install (admin)
  └─ après copie des fichiers, CustomAction élévée :
       EU-DSS Agent.exe --provision-cert         → C:\ProgramData\eudss-agent\agent-keystore.p12 + agent.cer
       certutil -addstore -f Root agent.cer       → cert localhost trusté (LocalMachine\Root)
       HKLM\Run += "EU-DSS Agent"                 → auto-start au login (session utilisateur)
Au login suivant : l'agent démarre tout seul, sert https://localhost:9795 avec un cert DE CONFIANCE
  → le navigateur n'affiche PLUS d'avertissement → le wizard SP1 passe direct à « ✓ Agent connecté ».
```

## Tests

- **Agent (unit)** : `AgentTls.defaultKeystorePath()` → `C:\ProgramData\eudss-agent\agent-keystore.p12` quand os.name contient "win" (sinon `~/.eudss-agent`) ; respecte `EUDSS_AGENT_KEYSTORE`. `--provision-cert` : crée un keystore (CN=localhost, SAN) + un `.cer`, puis sort sans écouter (exit 0).
- **Install (manuel, VM Windows ARM)** : installer le MSI (rebuild via le workflow modifié) → vérifier :
  (a) `certutil -store Root` contient le cert `CN=localhost` ; (b) `HKLM\…\Run` a « EU-DSS Agent » ;
  (c) après un logoff/login (ou reboot) l'agent tourne (`/rest/health` 200) **sans lancement manuel** ;
  (d) **dans Edge : `https://localhost:9795/rest/health` n'affiche AUCUN avertissement de cert** ; le wizard SP1 montre « ✓ Agent connecté » directement (plus d'étape « accepter le cert ») ;
  (e) **uninstall** → cert retiré de Root, `HKLM\Run` nettoyé, `C:\ProgramData\eudss-agent\` supprimé.
- Régression : la suite agent reste verte ; les autres OS (macOS via `~/.eudss-agent`) inchangés.

## Critères d'acceptation

1. MSI installé → cert `localhost` présent dans `LocalMachine\Root` + entrée `HKLM\Run` « EU-DSS Agent ».
2. Après login → agent en cours, `/rest/health` 200, **sans action manuelle**.
3. `https://localhost:9795` **sans avertissement de cert** dans Edge/Chrome ; le wizard SP1 saute l'étape cert.
4. Uninstall → Root + Run + ProgramData nettoyés (pas de cert trusté orphelin).
5. Agent hors-Windows inchangé (keystore `~/.eudss-agent`, pas d'auto-trust).
6. Suite de tests agent verte.

## Hors scope (follow-ups / SP2b)

Firefox (magasin NSS séparé, l'auto-trust Root ne le couvre pas) ; **macOS = SP2b** (pkg + `security add-trusted-cert` System keychain + LaunchAgent `~/Library/LaunchAgents`) ; Linux ; hiérarchie CA séparée + rotation ; code-signing du MSI lui-même.
