# Design : SP2c-core Linux/Ubuntu : cert de confiance + auto-start (piloté par le .deb)

Date : 2026-06-02 · Branche : `eu-dss` · Modules : `eu-dss-agent` (petits changements Java) + un nouveau build `.deb` (`packaging/linux/` + workflow CI).

## Contexte & problème

Onboarding zéro-friction : SP1 (wizard, FAIT) + SP2 Windows (MSI, FAIT) + SP2b macOS (.pkg, FAIT, E2E). **SP2c porte le même résultat sur Linux/Ubuntu** : un `.deb` qui, à l'installation, fait confiance au cert `localhost` et installe un démarrage automatique en session utilisateur, pour supprimer les deux frictions (« accepter le certificat » + lancer l'agent à la main). Pendant de SP2/SP2b, adapté aux mécanismes Linux. Étude amont : `docs/superpowers/research/2026-06-02-sp2c-linux-feasibility.md`.

**Particularité Linux (le point dur)** : Linux n'a pas de magasin de confiance universel. Le magasin système (`update-ca-certificates`) est lu par curl/Java mais **pas** par les navigateurs. Chrome/Chromium lisent une base NSS par utilisateur (`~/.pki/nssdb`), Firefox une base par profil. La confiance zéro-friction n'est donc atteignable que pour la famille Chromium, par utilisateur.

## État actuel (baseline)

- Agent : `AgentMain --provision-cert` (OS-agnostique) génère le keystore + exporte `agent.cer` à côté, puis sort ; honore `EUDSS_AGENT_KEYSTORE`. `AgentTls.defaultKeystorePath` : Windows machine-wide (`C:\ProgramData\eudss-agent`), sinon `~/.eudss-agent/agent-keystore.p12`.
- Linux : pas de packaging. Lancement dev via `bin/eu-dss-agent-linux.sh` (jar sur le JDK système). Aucun cert trusté, aucun auto-start.
- **Bug confirmé (recherche middleware)** : le driver Linux par défaut est codé `/usr/lib/libidop11.so` (`AgentConfig.DEFAULT_DRIVER_LINUX`), or le vrai chemin IDOPTE Linux est **`/usr/lib/SCMiddleware/libidop11.so`** (à corriger).
- Middleware : ChamberSign/IDOPTE publie un `.deb` Ubuntu **amd64 uniquement** (pas de build arm64). Reader stack : `pcscd` + `libccid` (standard Ubuntu). NSS : `certutil` fourni par `libnss3-tools`.

## Décisions (validées 2026-06-02)

1. **Périmètre : amd64 uniquement.** Cible le `.deb` amd64 (middleware IDOPTE amd64). **Différé** : Firefox (NSS par profil), `.rpm`, arm64 (pas de middleware vendeur ; OpenSC `iasecc` non vérifié avec cette carte), vérification de **signature réelle** sur amd64 (pas d'environnement Linux amd64 + token + middleware dispo maintenant → follow-up).
2. **Confiance en deux couches** :
   a. `postinst` (root) ajoute `agent.cer` au **magasin système** (`/usr/local/share/ca-certificates/eudss-agent.crt` + `update-ca-certificates`) : couvre curl/Java/diagnostics.
   b. **L'agent, au 1er lancement en session utilisateur** (via autostart XDG), exécute un `certutil` idempotent dans `~/.pki/nssdb` : couvre Chrome/Chromium **sans friction**. Firefox = « accepter une fois » (différé).
3. **Auto-start = XDG autostart** (`/etc/xdg/autostart/eu-dss-agent.desktop`), session GUI de chaque utilisateur. **PAS un service systemd système** (session non-GUI : ne verrait pas la carte ; même leçon que « pas de service Windows » en SP2). XDG préféré à `systemd --user` car un seul fichier root l'active pour tous les utilisateurs.
4. **Keystore machine-wide Linux** : `/var/lib/eudss-agent/agent-keystore.p12` (+ `agent.cer`), parallèle à `C:\ProgramData` (Windows) et `/Library/Application Support` (macOS). Nouvelle branche dans `AgentTls.defaultKeystorePath`.
5. **Cert généré par-machine, jamais embarqué** (identique à SP2/SP2b).
6. **Packaging** : `jpackage --type app-image` (JRE embarqué) puis **assemblage `.deb` à la main via `dpkg-deb`** (jpackage `--type deb` ne permet pas d'injecter les scripts `postinst`/`prerm`/`postrm`). Analogue de l'override WiX (Windows) / pkgbuild-scripts (macOS).

## Composants

### A. Agent (`eu-dss-agent`) : petits changements Java

1. **Corriger le driver Linux** : `AgentConfig.DEFAULT_DRIVER_LINUX` `/usr/lib/libidop11.so` -> `/usr/lib/SCMiddleware/libidop11.so`. Mettre à jour `AgentConfigDefaultsTest` et `bin/eu-dss-agent-linux.sh`.
2. **Keystore machine-wide Linux** : dans `AgentTls.defaultKeystorePath(osName, userHome, programData, envKeystore)`, si `osName` contient "linux" (ou "nux") et pas d'override `EUDSS_AGENT_KEYSTORE` -> `Path.of("/var/lib/eudss-agent/agent-keystore.p12")`. Sinon inchangé. Étendre `AgentTlsTest` (Linux -> `/var/lib/eudss-agent/...` ; override toujours prioritaire ; macOS/Windows inchangés).
3. **Trust Chromium au 1er lancement (Linux only)** : nouvelle classe `LinuxNssTrust` + appel depuis `AgentMain` au démarrage quand l'OS est Linux et l'agent n'est pas headless. Logique (idempotente, best-effort, ne bloque jamais le démarrage) :
   - Si le marqueur `~/.eudss-agent/.nss-trusted` existe : ne rien faire.
   - Sinon, si `certutil` est introuvable (`which certutil`) : logguer un conseil (« installez libnss3-tools pour la confiance Chrome automatique ») et sortir.
   - Sinon : `mkdir -p ~/.pki/nssdb` ; si la base n'existe pas, l'initialiser (`certutil -d sql:~/.pki/nssdb -N --empty-password`) ; puis `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "EU-DSS Agent localhost" -i <agent.cer>` où `<agent.cer>` = le sibling du keystore courant (`/var/lib/eudss-agent/agent.cer`, lisible en 0644). Écrire le marqueur en cas de succès.
   - Unit-testable : extraire la **décision** (faut-il agir ? quelle commande construire ?) dans une méthode pure testée (marqueur présent/absent, certutil présent/absent, chemin cert) ; l'exécution `certutil` reste best-effort non testée unitairement.

### B. Packaging (`packaging/linux/`) : nouveau

`packaging/linux/build-agent-deb.sh` (lancé en CI Linux et localement) :
1. `jpackage --type app-image --name eu-dss-agent --input <staging> --main-jar <jar> --main-class com.linagora.eudss.agent.AgentMain --dest build/linux-appimage` -> `build/linux-appimage/eu-dss-agent/` (JRE embarqué ; launcher `bin/eu-dss-agent`).
2. Assembler l'arborescence `.deb` :
   ```
   pkgroot/
     DEBIAN/control     # Package: eu-dss-agent ; Architecture: amd64 ; Depends: pcscd, libccid, libnss3-tools, ca-certificates
     DEBIAN/postinst    # provision + trust système (voir C)
     DEBIAN/prerm       # arrêt best-effort de l'agent
     DEBIAN/postrm      # purge : retire le cert système + /var/lib/eudss-agent
     opt/eu-dss-agent/...                         # l'app-image jpackage
     etc/xdg/autostart/eu-dss-agent.desktop       # autostart session utilisateur
   ```
3. `dpkg-deb --build --root-owner-group pkgroot dist/eu-dss-agent_0.1.0_amd64.deb`.

`DEBIAN/postinst` (root, à la config) :
```sh
set -e
mkdir -p /var/lib/eudss-agent
EUDSS_AGENT_KEYSTORE=/var/lib/eudss-agent/agent-keystore.p12 \
  /opt/eu-dss-agent/bin/eu-dss-agent --provision-cert
chmod 644 /var/lib/eudss-agent/agent-keystore.p12 /var/lib/eudss-agent/agent.cer
install -m 644 /var/lib/eudss-agent/agent.cer /usr/local/share/ca-certificates/eudss-agent.crt
update-ca-certificates
```
`DEBIAN/postrm` (sur `remove`/`purge`) : `rm -f /usr/local/share/ca-certificates/eudss-agent.crt ; update-ca-certificates --fresh ; rm -rf /var/lib/eudss-agent`. (Le cert NSS par-utilisateur dans `~/.pki/nssdb` + le marqueur ne sont pas retirables proprement par un postrm root : limitation connue, documentée ; c'est un cert localhost inoffensif.)

`etc/xdg/autostart/eu-dss-agent.desktop` :
```desktop
[Desktop Entry]
Type=Application
Name=EU-DSS Agent
Exec=/opt/eu-dss-agent/bin/eu-dss-agent
X-GNOME-Autostart-enabled=true
NoDisplay=true
```

### C. CI (`.github/workflows/linux-installer.yml`) : nouveau

Sur `ubuntu-latest` (**amd64**) : `actions/checkout` -> `actions/setup-java` (Temurin 21) -> `apt-get install -y fakeroot dpkg-dev binutils` -> `mvn -B -pl eu-dss-agent -am -DskipTests package` -> `packaging/linux/build-agent-deb.sh` -> `upload-artifact` du `dist/*.deb`. (arm64 = follow-up, runner + middleware requis.)

## Flux d'install (résultat attendu)

```
sudo apt install ./eu-dss-agent_0.1.0_amd64.deb   (tire pcscd, libccid, libnss3-tools, ca-certificates)
  postinst (root) :
    eu-dss-agent --provision-cert   -> /var/lib/eudss-agent/{agent-keystore.p12, agent.cer}
    agent.cer -> /usr/local/share/ca-certificates + update-ca-certificates   (curl/Java de confiance)
    /etc/xdg/autostart/eu-dss-agent.desktop installé
À l'ouverture de session GUI : l'agent démarre (XDG autostart), sert https://localhost:9795, et au
  1er run fait confiance à son cert dans ~/.pki/nssdb (certutil) -> Chrome/Chromium sans avertissement.
  (Firefox : « accepter une fois », différé.)
```

## Tests

- **Agent (unit)** : `AgentConfigDefaultsTest` driver Linux = `/usr/lib/SCMiddleware/libidop11.so`. `AgentTlsTest` : Linux -> `/var/lib/eudss-agent/agent-keystore.p12` ; `EUDSS_AGENT_KEYSTORE` prioritaire ; macOS/Windows inchangés. `LinuxNssTrust` : la décision pure (marqueur présent -> no-op ; certutil absent -> skip+conseil ; sinon -> commande certutil attendue avec le bon chemin cert). Régression : suite agent + serveur verte.
- **Build (CI)** : `linux-installer.yml` produit `eu-dss-agent_0.1.0_amd64.deb`.
- **Mécanisme (VM Ubuntu 24.04 ARM `{3fd9b840-...}`)** : construire un `.deb` arm64 sur la VM (jpackage arm64 + les mêmes scripts), `sudo apt install ./...deb`, puis vérifier : cert présent dans `/etc/ssl/certs` (via `update-ca-certificates`) ; `/var/lib/eudss-agent/agent-keystore.p12` + `agent.cer` présents ; `/etc/xdg/autostart/eu-dss-agent.desktop` présent ; après login l'agent tourne (`curl -k https://localhost:9795/rest/health` -> 200) sans lancement manuel ; le 1er run a ajouté le cert à `~/.pki/nssdb` (`certutil -d sql:$HOME/.pki/nssdb -L` liste « EU-DSS Agent localhost ») ; dans Chrome/Chromium (si présent) `https://localhost:9795/rest/health` sans avertissement ; `apt remove`/`purge` retire le cert système + `/var/lib/eudss-agent`. **Signature réelle NON testable** (pas de middleware arm64) : follow-up sur amd64.

## Critères d'acceptation

1. `.deb` amd64 produit en CI.
2. Install -> cert dans le magasin système (`update-ca-certificates`), keystore + `agent.cer` dans `/var/lib/eudss-agent`, entrée XDG autostart présente.
3. À l'ouverture de session : agent en cours, `/rest/health` 200, sans action manuelle ; cert ajouté à `~/.pki/nssdb` au 1er run -> Chrome/Chromium sans avertissement.
4. `apt remove`/`purge` : cert système retiré, `/var/lib/eudss-agent` supprimé.
5. Driver Linux par défaut corrigé (`/usr/lib/SCMiddleware/libidop11.so`) ; agent hors-Linux inchangé ; suite de tests verte.

## Hors scope (follow-ups)

Confiance **Firefox** (NSS par profil, Snap) ; build **`.rpm`** ; **arm64** (middleware vendeur inexistant ; OpenSC `iasecc` à valider matériellement) ; **vérification de signature réelle** sur Linux amd64 (env + token + middleware IDOPTE amd64 requis) ; durcissement multi-utilisateur (keystore par-utilisateur).
