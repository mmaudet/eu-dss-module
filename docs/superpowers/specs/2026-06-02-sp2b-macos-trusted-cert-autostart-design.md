# Design — SP2b macOS : cert de confiance + auto-start (piloté par le .pkg)

Date : 2026-06-02 · Branche : `eu-dss` · Modules : build macOS (nouveau `packaging/macos/` + workflow CI) ; **l'agent Java n'est PAS modifié**.

## Contexte & problème

Onboarding zéro-friction = SP1 (wizard, FAIT) + SP2 (auto-bootstrap de l'agent). SP2 Windows (FAIT, vérifié sur la VM) supprime les deux dernières frictions via le MSI : (a) « accepter le certificat auto-signé », et (b) lancer l'agent à la main. **SP2b porte le même résultat sur macOS** : un `.pkg` qui, à l'installation, fait confiance au cert `localhost` machine-wide (Safari/Chrome) et installe un démarrage automatique en session utilisateur. C'est le pendant macOS de SP2 ; il en reprend les décisions, adaptées aux mécanismes Apple.

## État actuel (baseline)

- Agent : `AgentTls` génère un cert auto-signé `CN=localhost` (+ SAN localhost/127.0.0.1, BouncyCastle) ; sert `https://localhost:9795` (Javalin SSL). Sur macOS le keystore par défaut est `~/.eudss-agent/agent-keystore.p12`.
- `AgentMain --provision-cert` (déjà présent, OS-agnostique) : génère le keystore s'il manque, exporte le cert public en DER `agent.cer` à côté, puis sort sans écouter. Honore `EUDSS_AGENT_KEYSTORE` (override du chemin keystore).
- macOS : pas de packaging. Lancement dev via `bin/eu-dss-agent-macos.sh` (jar sur le JDK système). Aucun cert trusté, aucun auto-start.
- Middleware ChamberSign/IDOPTE sur macOS : `/Library/SCMiddleware/libidop11.dylib` — **binaire universel (x86_64 + arm64)** : un JRE arm64 (ou x64) le charge sans souci d'architecture (contraste avec Windows où le idoPKCS ARM64 ne chargeait pas dans le JRE x64).

## Décisions (validées 2026-06-02)

1. **Cert de confiance machine-wide dans le System keychain** (`security add-trusted-cert … -k /Library/Keychains/System.keychain`), parallèle au `LocalMachine\Root` de Windows. Couvre **Safari + Chrome** (qui utilisent le keychain système sur macOS). **Firefox = NSS séparé → hors scope** (comme Windows).
2. **Auto-start = LaunchAgent** dans `/Library/LaunchAgents/` (session GUI de chaque utilisateur), **PAS un LaunchDaemon** (root, contexte non-GUI : ne verrait pas le smart-card de l'utilisateur — même raison que « pas de service Windows » en SP2).
3. **.pkg NON SIGNÉ pour l'instant** (pas de cert « Developer ID Installer » ; le compte Apple Linagora `KUT463DS29` n'a qu'une identité « Apple Distribution », réservée à l'App Store). L'utilisateur contourne Gatekeeper une fois (clic droit → Ouvrir). **Signature + notarisation = follow-up.**
4. **Aucune modification du code Java de l'agent.** On réutilise `--provision-cert` + `EUDSS_AGENT_KEYSTORE`. Le chemin keystore machine-wide `/Library/Application Support/eudss-agent/agent-keystore.p12` est passé **en variable d'environnement** au provisioning ET dans le plist. (Divergence assumée vs Windows, où il a fallu changer le défaut de `defaultKeystorePath` parce que l'env ne pouvait pas être injecté à la fois dans la CustomAction SYSTEM et dans le `.exe` lancé par l'utilisateur ; sur macOS on contrôle les deux côtés, donc le défaut `~/.eudss-agent` reste inchangé et le flux dev manuel n'est pas touché.)
5. **Cert généré par-machine, jamais embarqué** (clé privée shippée = MITM si fuite) — identique à SP2.
6. **Build : jpackage `app-image` puis `pkgbuild`/`productbuild`**, et non `jpackage --type pkg` (qui ne permet pas d'injecter le script postinstall dont on a besoin). C'est l'analogue macOS de l'override `--resource-dir`/`main.wxs` côté Windows.

## Composants

### A. Agent (`eu-dss-agent`) — INCHANGÉ

Aucun changement de code. Capacités déjà en place et réutilisées telles quelles :
- `AgentMain --provision-cert` → crée le keystore (s'il manque) + exporte `agent.cer` à côté, puis sort.
- `AgentTls.defaultKeystorePath()` honore `EUDSS_AGENT_KEYSTORE` → on lui passe `/Library/Application Support/eudss-agent/agent-keystore.p12` côté provisioning et côté runtime.
- Le défaut macOS `~/.eudss-agent/agent-keystore.p12` reste pour le flux dev (`bin/eu-dss-agent-macos.sh`).

### B. Build du .pkg (`packaging/macos/`) — nouveau

`packaging/macos/build-agent-pkg.sh` (lancé en CI macOS et localement) :
1. Stage le jar de l'agent dans un dossier d'input.
2. `jpackage --type app-image --name "EU-DSS Agent" --app-version 0.1.0 --vendor LINAGORA --input <staging> --main-jar <jar> --main-class com.linagora.eudss.agent.AgentMain --dest <appdir>` → `<appdir>/EU-DSS Agent.app` (JRE arm64 embarqué ; launcher = `EU-DSS Agent.app/Contents/MacOS/EU-DSS Agent`, accepte les args comme `--provision-cert`).
3. `pkgbuild --component "<appdir>/EU-DSS Agent.app" --install-location /Applications --scripts packaging/macos/scripts --identifier com.linagora.eudss.agent --version 0.1.0 <component>.pkg`.
4. `productbuild --package <component>.pkg dist/EU-DSS-Agent-0.1.0.pkg` (distributable final, non signé).

### C. Scripts d'install (`packaging/macos/scripts/postinstall`) — nouveau

`postinstall` (exécuté **root** par l'installeur, après la copie de l'app) :
1. `mkdir -p "/Library/Application Support/eudss-agent"` (755).
2. **Provision** : `EUDSS_AGENT_KEYSTORE="/Library/Application Support/eudss-agent/agent-keystore.p12" "/Applications/EU-DSS Agent.app/Contents/MacOS/EU-DSS Agent" --provision-cert` → crée `agent-keystore.p12` + `agent.cer`. `chmod 644` sur les deux (le keystore ne protège qu'un listener localhost ; cert régénéré par-machine).
3. **Trust** : `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "/Library/Application Support/eudss-agent/agent.cer"`.
4. **SHA pour la désinstallation** : `openssl x509 -inform der -in agent.cer -noout -fingerprint -sha1` → hash nettoyé écrit dans `/Library/Application Support/eudss-agent/trusted-sha.txt`.
5. **LaunchAgent** : écrit `/Library/LaunchAgents/com.linagora.eudss.agent.plist` (root:wheel, 644) avec :
   - `ProgramArguments` = `["/Applications/EU-DSS Agent.app/Contents/MacOS/EU-DSS Agent"]`
   - `EnvironmentVariables` = `EUDSS_AGENT_KEYSTORE=/Library/Application Support/eudss-agent/agent-keystore.p12`, `EUDSS_PKCS11_DRIVER=/Library/SCMiddleware/libidop11.dylib`
   - `RunAtLoad = true`, `KeepAlive = false`
6. **Démarrage immédiat** pour l'utilisateur de la console : `consoleUser=$(stat -f%Su /dev/console)` ; `uid=$(id -u "$consoleUser")` ; si l'utilisateur est réel (pas `root`/`loginwindow`) : `launchctl bootstrap gui/$uid /Library/LaunchAgents/com.linagora.eudss.agent.plist` (sinon l'agent démarrera au prochain login). Échec non bloquant.

`packaging/macos/uninstall.sh` (copié dans le data dir à l'install ; macOS n'a pas d'uninstaller .pkg natif — à lancer avec `sudo`) :
1. `uid=$(id -u "$(stat -f%Su /dev/console)")` ; `launchctl bootout gui/$uid/com.linagora.eudss.agent` (best-effort) ; `rm -f /Library/LaunchAgents/com.linagora.eudss.agent.plist`.
2. `sha=$(cat /Library/Application Support/eudss-agent/trusted-sha.txt)` ; `security delete-certificate -Z "$sha" /Library/Keychains/System.keychain` (suppression ciblée par hash).
3. `rm -rf "/Applications/EU-DSS Agent.app" "/Library/Application Support/eudss-agent"`.

### D. CI (`.github/workflows/macos-installer.yml`) — nouveau

Sur `macos-latest` (**arm64**) : `actions/checkout` → `actions/setup-java` (Temurin 21) → `mvn -B -pl eu-dss-agent -am -DskipTests package` → `packaging/macos/build-agent-pkg.sh` → `upload-artifact` du `dist/*.pkg`. (Runners macOS = arm64 → app + JRE arm64 ; le middleware universel charge sans souci. Build Intel/universal = follow-up.)

## Flux d'install (résultat attendu)

```
Ouverture du .pkg (Gatekeeper : clic droit → Ouvrir car non signé) → installeur (mot de passe admin)
  └─ après copie de /Applications/EU-DSS Agent.app, postinstall (root) :
       EU-DSS Agent --provision-cert            → /Library/Application Support/eudss-agent/{agent-keystore.p12,agent.cer}
       security add-trusted-cert … System.keychain (trustRoot) → cert localhost de confiance (Safari + Chrome)
       /Library/LaunchAgents/com.linagora.eudss.agent.plist (RunAtLoad)  + launchctl bootstrap gui/<uid>
Au login (ou immédiatement via bootstrap) : l'agent tourne en session utilisateur, sert https://localhost:9795
  avec un cert DE CONFIANCE → plus d'avertissement → le wizard SP1 passe direct à « ✓ Agent connecté ».
```

## Tests (en local sur le Mac arm64 de dev — middleware déjà présent, pas de VM)

1. **Build** : `build-agent-pkg.sh` produit `dist/EU-DSS-Agent-0.1.0.pkg` (jpackage app-image + pkgbuild + productbuild OK).
2. **Install** : `sudo installer -pkg dist/EU-DSS-Agent-0.1.0.pkg -target /` (équivaut au double-clic, sans l'UI Gatekeeper). Vérifier :
   - `/Library/Application Support/eudss-agent/agent-keystore.p12` + `agent.cer` présents ;
   - `security find-certificate -c localhost /Library/Keychains/System.keychain` trouve le cert ; `trusted-sha.txt` renseigné ;
   - `/Library/LaunchAgents/com.linagora.eudss.agent.plist` présent ; `launchctl print gui/$(id -u)/com.linagora.eudss.agent` montre l'agent chargé ;
   - `security verify-cert -c "/Library/Application Support/eudss-agent/agent.cer"` atteste la confiance ; **test faisant autorité : `https://localhost:9795/rest/health` s'ouvre sans avertissement dans Safari ET Chrome** (le `curl` macOS ne consulte pas forcément le keychain — ne pas s'y fier comme preuve) ;
   - signature de bout en bout avec le **vrai token** (PIN saisi dans l'app au moment de signer).
3. **Désinstallation** : `sudo /Library/Application\ Support/eudss-agent/uninstall.sh` → cert retiré du System keychain, plist supprimé + LaunchAgent déchargé, app + data dir effacés.
4. Régression : la suite de tests agent reste verte (aucun code Java touché) ; le flux dev `bin/eu-dss-agent-macos.sh` (keystore `~/.eudss-agent`) inchangé.

> ⚠️ Les tests modifient le **System keychain** et `/Library` de la machine de dev. Entièrement réversible via `uninstall.sh` ; à exécuter en connaissance de cause.

## Critères d'acceptation

1. `.pkg` installé → `agent.cer` présent dans le **System keychain** (trustRoot) + `com.linagora.eudss.agent.plist` dans `/Library/LaunchAgents`.
2. Agent en cours en session utilisateur, `/rest/health` 200, **sans lancement manuel** (au login ou via bootstrap).
3. `https://localhost:9795` **sans avertissement de cert** dans **Safari + Chrome** ; le wizard SP1 saute l'étape « accepter le cert ».
4. `uninstall.sh` → cert retiré (par SHA), plist + LaunchAgent retirés, app + `/Library/Application Support/eudss-agent` supprimés (pas de cert trusté orphelin).
5. Aucun code Java modifié ; suite agent verte ; flux dev macOS (`~/.eudss-agent`) inchangé.

## Hors scope (follow-ups)

- **Signature + notarisation** du .pkg (cert « Developer ID Installer » sous le compte Linagora + notarytool + secrets CI) — supprimerait le contournement Gatekeeper.
- **Confiance Firefox** (magasin NSS séparé — l'ajout au System keychain ne le couvre pas).
- **Build Intel / universal** (arm64 d'abord).
- **Linux/Ubuntu (SP2c)** : sous-projet distinct (.deb, magasin de confiance + autostart différents ; piège connu : Chrome/Firefox utilisent des bases NSS par profil, pas le magasin système) — à l'étude séparément.
