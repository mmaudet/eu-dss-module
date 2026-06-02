# eu-dss — Installation et premiers pas (Windows & macOS)

L'application **eu-dss** signe et vérifie des documents (PAdES / ASiC) avec votre **clé USB
cryptographique** (carte à puce / token PKCS#11). La signature se fait dans votre navigateur, mais
la clé privée ne quitte **jamais** votre carte : un petit programme local, l'**agent**, fait le pont
entre le site web et votre token.

> **L'agent en bref** — il tourne sur votre poste et expose **`https://localhost:9795`**. Il ne reçoit
> jamais votre clé : le site lui envoie une empreinte (un condensat) à signer, et l'agent renvoie la
> signature calculée *par la carte*. Votre **code PIN** est demandé **au moment de signer**, dans
> l'application (et non au démarrage de l'agent).

---

## 1. Prérequis (tous systèmes)

| Élément | Détail |
|---|---|
| **Token USB branché** | Votre carte à puce / clé cryptographique, insérée. |
| **Middleware ChamberSign** | Le pilote PKCS#11 de la carte. L'agent ne le fournit pas. → **[Télécharger sur support.chambersign.fr](https://support.chambersign.fr/pilotes/)** |
| **Java 21** | Requis **sauf sous Windows** : l'installeur MSI embarque son propre runtime Java. Sous macOS/Linux, installez **Temurin JDK 21**. |

---

## 2. Windows (installeur MSI — recommandé)

C'est le chemin le plus simple : l'installeur fait **tout** automatiquement (certificat de confiance +
démarrage automatique). Aucune étape « accepter le certificat ».

1. **Installez le middleware ChamberSign** (lien ci-dessus) et branchez votre token.
2. **Téléchargez l'agent** :
   **[EU-DSS-Agent-0.1.0.msi](https://github.com/mmaudet/twake-eu-dss-module/releases/download/eu-dss-agent-v0.1.0/EU-DSS-Agent-0.1.0.msi)**
3. **Double-cliquez le MSI** et laissez l'installation se dérouler. À la fin, l'agent est :
   - **lancé**, et **relancé automatiquement** à chaque ouverture de session Windows ;
   - servi en HTTPS sur `https://localhost:9795` avec un **certificat déjà approuvé** par Windows
     (aucun avertissement de sécurité dans Edge/Chrome).
4. **Ouvrez l'application** de signature dans votre navigateur. Tout est prêt.

> Rien d'autre à faire : pas de PIN à saisir au démarrage, pas de certificat à accepter manuellement.

### À quoi ça ressemble

**Avant l'installation** (ou si l'agent est arrêté), l'application affiche un bandeau d'aide avec les
liens de téléchargement :

![Agent non détecté — l'application propose de télécharger l'agent et le middleware](images/win/01-agent-non-detecte.png)

**Une fois l'agent installé et la carte reconnue**, l'application affiche « Agent connecté », l'état
de la carte et le certificat de signature : vous pouvez signer.

![Agent connecté — carte reconnue, certificat de signature affiché](images/win/02-agent-connecte.png)

---

## 3. macOS

### Installeur .pkg (recommandé)

1. Installez le **middleware ChamberSign** (module PKCS#11 `/Library/SCMiddleware/libidop11.dylib`) et branchez votre token.
2. Téléchargez **`EU-DSS-Agent-0.1.0.pkg`** (voir [Releases](https://github.com/mmaudet/twake-eu-dss-module/releases)). Comme il n'est pas encore signé, au premier lancement : **clic droit sur le .pkg → Ouvrir** (puis confirmez), ou Réglages Système → Confidentialité et sécurité → « Ouvrir quand même ».
3. Installez (mot de passe administrateur demandé). À la fin, l'agent :
   - fait confiance à son certificat `localhost` dans le **trousseau Système** (aucun avertissement dans Safari/Chrome) ;
   - démarre automatiquement à l'ouverture de session (LaunchAgent).
4. Ouvrez l'application de signature : « Agent connecté » doit apparaître.

> **Désinstaller** : `sudo "/Library/Application Support/eudss-agent/uninstall.sh"` (macOS n'a pas de désinstalleur .pkg natif).
> **Firefox** garde son propre magasin de certificats (NSS) — non couvert par le trousseau Système (suivi séparé).

### Alternative développeur (exécuter le jar)

1. Installez **Temurin JDK 21** et le middleware ChamberSign. Branchez votre token.
2. Construisez l'agent : `mvn -DskipTests package`
3. Lancez-le : `bin/eu-dss-agent-macos.sh` (l'agent démarre **verrouillé** ; le PIN sera demandé dans l'application au moment de signer).
4. Ouvrez **une fois** `https://localhost:9795/rest/health` et acceptez le certificat auto-signé (l'approbation automatique est gérée par le .pkg ci-dessus).

> **Linux** : identique à l'alternative développeur, avec le module PKCS#11 `/usr/lib/libidop11.so` et le script `bin/eu-dss-agent-linux.sh`.

---

## 4. Signer un document

1. Ouvrez l'application, onglet **Signer**. Le panneau « Agent local » vérifie automatiquement
   l'agent, la carte et le middleware (il se revérifie quand vous revenez sur l'onglet).
2. **Choisissez le(s) document(s)** à signer.
3. Cliquez sur **Signer** : l'application vous demande alors votre **code PIN de carte**.
4. La signature est calculée par la carte et appliquée au document.

> **Session PIN** — après une signature, la carte reste déverrouillée pendant **~5 minutes**
> (compte à rebours affiché), puis se re-verrouille automatiquement. Vous pouvez aussi cliquer
> **« Verrouiller »** à tout moment. Le PIN n'est jamais stocké sur le disque.

---

## 5. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| **« Agent local non détecté »** (bandeau orange) | L'agent n'est pas lancé/installé ; ou (macOS) son certificat n'a pas encore été accepté. | Windows : (ré)installez le MSI. macOS : lancez le script, acceptez le certificat. Puis cliquez **« Revérifier »**. |
| **Bouton « Signer » indisponible / « token indisponible »** | Une autre application monopolise la carte (p. ex. *LOCAL TRUST FORCE*), ou le token n'est pas branché, ou le middleware est absent. | Fermez l'autre application de carte à puce, vérifiez que le token est inséré et que le middleware ChamberSign est installé. |
| **« PIN incorrect »** | Mauvais code PIN. | Ressaisissez. ⚠️ **Après ~3 essais erronés, la carte se bloque** (déblocage auprès de l'émetteur). |
| **Avertissement de certificat** (macOS) | Le certificat local de l'agent n'a pas été accepté. | Ouvrez `https://localhost:9795/rest/health` et acceptez-le. (Sous Windows, le MSI le fait pour vous.) |
| **Vérifier que l'agent répond** | — | Ouvrez `https://localhost:9795/rest/health` : vous devez voir `{"status":"ok"}`. |

---

## 6. Administration / déploiement géré (IT)

### Installation et désinstallation silencieuses (Windows)

```powershell
# Installer sans interaction (requiert des droits administrateur)
msiexec /i "EU-DSS-Agent-0.1.0.msi" /qn

# Désinstaller (retire aussi le certificat de confiance, le démarrage auto et les données)
msiexec /x "EU-DSS-Agent-0.1.0.msi" /qn
```

### Ce que l'installeur Windows provisionne

| Élément | Emplacement |
|---|---|
| Keystore TLS (auto-signé, généré **par machine**) | `C:\ProgramData\eudss-agent\agent-keystore.p12` |
| Certificat de confiance | magasin **`Ordinateur local\Autorités de certification racines de confiance`** (`LocalMachine\Root`) |
| Démarrage automatique (session utilisateur) | `HKLM\Software\Microsoft\Windows\CurrentVersion\Run` → `EU-DSS Agent` |

> Le démarrage auto est un lancement **en session utilisateur** (clé `Run`), et **non** un service
> Windows : un service tournerait en session 0 et ne verrait pas la carte à puce de l'utilisateur.

### Variables d'environnement de l'agent

L'agent se configure entièrement par variables d'environnement (utile pour un déploiement maîtrisé).

| Variable | Défaut | Rôle |
|---|---|---|
| `EUDSS_PKCS11_DRIVER` | *selon l'OS* ¹ | Chemin du module PKCS#11 du middleware. |
| `EUDSS_PKCS11_SLOT` | `0` | Index du slot (0 = certificat de signature qualifié ChamberSign). |
| `EUDSS_AGENT_PORT` | `9795` | Port d'écoute HTTPS local. |
| `EUDSS_AGENT_TLS` | `true` | HTTPS activé. `false` → HTTP en clair (dev local uniquement). |
| `EUDSS_CORS_HOSTS` | `http://localhost:5173,http://localhost:8080,http://localhost:4173` | Origines web autorisées (CORS). |
| `EUDSS_PIN_SESSION_TTL` | `300` | Durée (secondes) de la session déverrouillée avant re-verrouillage automatique. |
| `EUDSS_AGENT_PIN` | *(vide)* | Si défini, mode **headless** : déverrouillage automatique au démarrage, sans re-verrou. À réserver aux scénarios non interactifs. |
| `EUDSS_AGENT_KEYSTORE` | *selon l'OS* ² | Chemin du keystore TLS (surcharge). |
| `EUDSS_AGENT_TLS_PASSWORD` | `eudss-agent` | Mot de passe du keystore TLS. |

¹ Pilote par défaut : Windows `C:\Program Files\Smart Card Middleware\bin\idoPKCS.dll` ·
macOS `/Library/SCMiddleware/libidop11.dylib` · Linux `/usr/lib/libidop11.so`.
² Keystore par défaut : Windows `C:\ProgramData\eudss-agent\agent-keystore.p12` ·
macOS/Linux `~/.eudss-agent/agent-keystore.p12`.

### Sécurité

- Le certificat TLS local est **auto-signé** (`CN=localhost`), **généré sur chaque machine** et
  **jamais** distribué dans l'installeur.
- L'agent ne reçoit jamais la clé privée : il ne fait signer qu'**un condensat** par la carte.
- Le PIN n'est jamais écrit sur le disque ni journalisé ; il est effacé de la mémoire après usage.
