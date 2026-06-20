# UI Refonte Implementation Plan — EU-DSS Sign

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. UI tasks verify visually (`npm run build` green + render against the design) rather than by strict TDD.

**Goal:** Implement the imported Claude Design refonte ("SaaS premium, beaucoup d'air") in the existing `eu-dss-ui` React app, keeping every eIDAS/IPC/backend wiring intact. The refonte is a new design system + reskin of the working screens, plus several new surfaces.

**Architecture:** One React codebase runs as both the web app and the Tauri desktop app. The redesign is CSS-variable-driven (a token layer in `styles.css`) plus restructured components. All functional wiring (`AgentContext`, `agentApi`, `backendApi`, the sign/verify flows) is untouched — this is presentation + new screens, not logic.

**Tech Stack:** Vite 6 + React 19 + TS (existing). Fonts: Geist + Geist Mono (add via `@fontsource/geist-sans` + `@fontsource/geist-mono`, bundled so the Tauri app works offline). No new runtime deps otherwise.

**Design reference:** `eu-dss-ui/design-ref/EU-DSS-Sign.dc.html` (the imported canvas) and the live project `https://claude.ai/design/p/66142934-9a97-4fca-914a-405e20dd42c0` (renders faithfully + has the `screenshots/` set). Every task below cites the screen section in the canvas (HTML comments `<!-- ================= SCREEN: ... -->`).

This is the "Refonte" plan (after Plans 1-2). It depends on the Tauri app (Plan 2, merged). It does NOT add the backend persistence that the dashboard implies (see Phase 2 caveat).

---

## Design system (extract first — the foundation for everything)

Tokens read directly from the canvas (`design-ref/EU-DSS-Sign.dc.html`, INTRO + observed throughout). Phase 1 Task 1 writes these as CSS variables.

**Color**
- Brand: `--brand:#2D63E8`; accent gradient `--grad:linear-gradient(135deg,#3A6DF0,#5B4FE0)`; active-nav tint `--brand-soft:#EEF3FE`, border `#DDE7FE`, hover `#EAF0FE`, faint `#F7FAFF`.
- Ink scale: `--ink:#16223A` (primary), `--ink-2:#3D4D69`, `--ink-3:#5A6B85`, `--ink-4:#7A89A3`, `--ink-5:#9AA7BE`, `--ink-6:#AEB9CC`, label `#8A97AC`.
- Success: `--ok:#1FA463`, text `--ok-ink:#18794E`, tints `#E7F6EE` / border `#BCE3CC`.
- Danger: `--danger:#D8514F`, tint `#FDEEEE`.
- Amber: tint `#FBF0DA` / border `#F1DFB5`.
- Surfaces: `--canvas:#E7E5DF` (app bg / window chrome), `--card:#fff`, `--main:#F4F6FB` (content area), `--rail:#FAFBFE` (sidebar).
- Borders: `--line:#E7ECF4`, `--line-2:#EFF2F8`, `--line-3:#F4F6FB`.
- Dark hero: `linear-gradient(120deg,#16223A,#1E315A,#27408A)` + radial glow `rgba(91,79,224,.45)`; on-dark text `#fff` / `#A9B6D4` / `#DCE4F2`; on-dark green pill bg `rgba(31,164,99,.16)` text `#7BE6A8`.

**Type**
- `--font:'Geist',system-ui,sans-serif` (weights 400/500/600/700); `--mono:'Geist Mono',monospace` (serial numbers, hashes, format codes, levels).
- Scale: h1 34px/600/-.02em; h2 23px/600/-.02em; section-title 14px/600; body 13.5-16px; small 11-12.5px; uppercase eyebrow 10.5-12px/600, letter-spacing .06-.08em, color `--ink-6`/`#8A97AC`.

**Shape**
- Radii: card 14px, hero 18px, button/input 9-11px, pill 999px, icon-tile 9-13px.
- Shadows: `--sh-card:0 1px 3px rgba(20,34,58,.05)`; `--sh-pop:0 12px 40px -16px rgba(20,34,58,.22),0 2px 8px rgba(20,34,58,.05)`; `--sh-hero:0 18px 40px -22px rgba(22,34,58,.7)`.
- Animations (keep): `pulseDot` (green status dot), `floatKey` (floating key icon), `spin`.

**Shell layout (all app screens)**
42px titlebar (logo + window controls) · 226px sidebar (`--rail`: logo block, "SIGNATURE" group = Accueil/Signer/Vérifier, "GÉRER" group = Clé & certificat/Prérequis, theme + langue toggles, agent-status pill) · main area (`--main`). Active nav item = `--brand-soft` bg + `--brand` text + weight 600.

---

## Screen → component map

| Design screen (canvas section) | React target | Phase |
| --- | --- | --- |
| Shell: titlebar + sidebar + theme/lang/agent pill | `App.tsx` (Sidebar/Shell), new `TitleBar`, `ui.tsx` | 1 |
| SCREEN: SIGNER, ETAT VIDE, SELECTEUR FORMAT | `components/SignWorkspace.tsx` (+ DocumentsPanel, AgentPanel) | 1 |
| SCREEN: PIN MODAL, 09 ERREURS PIN, DEBLOCAGE PUK | `components/PinModal.tsx` | 1 (PUK = 2) |
| SCREEN 07 SIGNATURE EN COURS | `SignWorkspace` `SigningProgress` | 1 |
| SCREEN 08 RECAP POST-SIGNATURE | `SignWorkspace` `SuccessView` | 1 |
| SCREEN: VERIFIER, 11 VERDICTS ALTERNATIFS | `components/ValidatePage.tsx` | 1 |
| 10 ERREURS CLE / AGENT | `SignWorkspace` `AgentPanel` banners | 1 |
| Shared: Card/Btn/Tag/Banner/Icon/CertGrid/TrustBadge | `components/ui.tsx` | 1 |
| SCREEN: ACCUEIL (dashboard) | new `components/Dashboard.tsx` + "Accueil" tab | 2 |
| SCREEN: CLE & CERTIFICAT | new `components/KeyCertPage.tsx` | 2 |
| SCREEN: PREREQUIS | promote `services/prerequisites` into a full screen | 2 |
| WIZARD PREMIER LANCEMENT (3 frames) | new `components/FirstRunWizard.tsx` | 2 |
| 15/17 THEME SOMBRE | dark CSS-variable theme + toggle | 2 |
| Langue FR/EN toggle | i18n (stretch) | 2 |

---

## Phase 1 — Design system + reskin the working screens

The deliverable: the live app (web + Tauri) adopts the new look, with the sign/verify flows behaving exactly as today.

### Task 1: Design tokens + fonts

**Files:** `eu-dss-ui/src/styles.css` (rewrite the `:root` token block + base), `eu-dss-ui/package.json`, `eu-dss-ui/src/main.tsx`.

- [ ] Add fonts: `npm i @fontsource/geist-sans @fontsource/geist-mono`; import the 400/500/600/700 (sans) and 400/500 (mono) weights in `main.tsx`.
- [ ] In `styles.css`, replace the `:root` variables with the full token set above (color, type, shape, shadow). Keep existing variable NAMES where components already use them (`--brand`, `--ink-3`, `--ok`, `--danger`, `--brand-soft`, etc.) so the reskin is incremental; add the new ones.
- [ ] Set `body { background: var(--canvas); font-family: var(--font); color: var(--ink); }`. Keep the `pulseDot`/`floatKey`/`spin` keyframes.
- [ ] Verify: `npm run build` green; the app renders with Geist + the warm canvas.

### Task 2: App shell — titlebar, sidebar, status

**Files:** `eu-dss-ui/src/App.tsx`, new `eu-dss-ui/src/components/TitleBar.tsx`, `eu-dss-ui/src/styles.css`.

- [ ] Rebuild the shell to match the canvas (titlebar 42px + 226px `--rail` sidebar + `--main` content). Sidebar: logo block, "SIGNATURE" group (Accueil*/Signer/Vérifier), "GÉRER" group (Clé & certificat*/Prérequis*), the Thème (Clair/Sombre) + Langue (FR/EN) toggle rows, and the agent-status pill at the bottom (the `AgentChip`, restyled: green `pulseDot`, "Agent connecté" / "Carte verrouillée|déverrouillée"). (* = nav items whose screens land in Phase 2; render them as disabled/"bientôt" placeholders so the sidebar matches the design now.)
- [ ] `TitleBar`: the 42px bar with the gradient logo mark + "EU-DSS Sign" + window controls. In Tauri (`'__TAURI_INTERNALS__' in window`) the controls call the window API (minimize/maximize/close) and `decorations:false` is set in `tauri.conf.json`; in the browser, render the bar without functional controls (or hide it). Note for the implementer: macOS custom titlebar needs `"titleBarStyle"` handling — keep it simple (overlay + draggable region via `data-tauri-drag-region`).
- [ ] Keep `AgentProvider` wrapping everything and the `tab` state driving the content. Wire the existing tabs (Signer/Vérifier) to the new nav; the Phase-2 nav items are inert placeholders.
- [ ] Verify: build green; shell matches `SCREEN: ACCUEIL`/`SIGNER` chrome (sidebar, titlebar, status pill).

### Task 3: Signer screen (`SignWorkspace`)

**Files:** `eu-dss-ui/src/components/SignWorkspace.tsx`, `ui.tsx`, `styles.css`. Reference: canvas `SCREEN: SIGNER` (lines ~176-256), `ETAT VIDE`, `SELECTEUR FORMAT OUVERT`.

- [ ] Header: "Signer" h2 + subtitle + the "Signature qualifiée · eIDAS" pill (top-right).
- [ ] Two-column layout: LEFT = dropzone (1.5px dashed `#C7D6F5`, icon tile, "Déposer vos documents", "Choisir des fichiers" button) + doc rows (icon tile by type, name, size, a `--mono` format pill `PAdES-B-T`/`ASiC-E` that opens the per-doc format selector, remove `x`). RIGHT = "Paramètres de signature" card (Niveau eIDAS `B-T`, Empreinte `SHA-256`, Horodatage TSA toggle) + the dark cert hero card ("Clé connectée" green pill, signer name, "ChamberSign Qualified CA"). Keep the empty/`busy`/`done` state machine and all handlers (`signAll`, `runBatch`, `signOne`) exactly as-is.
- [ ] Wire real data: signer name + issuer from `selectedCert` (AgentContext); doc list + statuses from `docs`. The "Paramètres" values (B-T, SHA-256, TSA) mirror the constants already used in `signOne`.
- [ ] Verify: build green; sign a doc still works (web fallback or Tauri); layout matches the canvas.

### Task 4: PIN modal (`PinModal`)

**Files:** `eu-dss-ui/src/components/PinModal.tsx`, `styles.css`. Reference: canvas `SCREEN: PIN MODAL`, `09 ERREURS PIN`.

- [ ] Reskin to the design: dimmed app backdrop + centered overlay, the masked PIN dots, the numeric keypad, the card-lock warning, and the `pin_incorrect`/`pin_locked` error states. Keep all `AgentContext` PIN wiring (`submitPin`, `cancelPin`, `pinBusy`, `pinError`) unchanged.
- [ ] Verify: build green; the unlock flow + error messages behave as today, restyled.

### Task 5: Vérifier screen (`ValidatePage`)

**Files:** `eu-dss-ui/src/components/ValidatePage.tsx`, `ui.tsx`. Reference: canvas `SCREEN: VERIFIER`, `11 VERDICTS ALTERNATIFS`.

- [ ] Reskin: file selector card, the verdict banner (TOTAL_PASSED green / INDETERMINATE amber / FAILED red — drive off `indication`), the signataire row (avatar + name + `--mono` serial), the "rapport checks" list, and the collapsible "Rapport DSS détaillé (XML)". Keep the `backendApi.validate` wiring + the signatures table.
- [ ] IMPORTANT (accuracy follow-up from Plan 2): drive the verdict + qualification badge strictly off the DSS report fields (`indication`, `signatureFormat`, and the qualification if exposed), NOT an optimistic label. If the report says AdES-QC, show AdES-QC, not QESig.
- [ ] Verify: build green; validate a signed PDF still shows the real result, restyled.

### Task 6: Signing progress + success recap

**Files:** `eu-dss-ui/src/components/SignWorkspace.tsx` (`SigningProgress`, `SuccessView`). Reference: canvas `SCREEN 07`, `SCREEN 08`.

- [ ] Reskin the "Signature en cours…" modal (per-doc progress rows) and the success recap (the green seal hero, the PAdES-BASELINE-T / eIDAS badges, the signed-docs list with download, the "Détails de la signature" grid). Keep the download handlers + the `allTargetedSigned` logic.
- [ ] (Optional, the Plan-2 follow-up) add a small toast/confirmation when a file downloads, since the silent download confused testing.
- [ ] Verify: build green; the full sign→success→download path works, restyled.

### Task 7: Error/empty states + shared `ui.tsx`

**Files:** `eu-dss-ui/src/components/ui.tsx`, `SignWorkspace.tsx` (`AgentPanel`). Reference: canvas `10 ERREURS CLE / AGENT`, `12 ETAT VIDE`.

- [ ] Update the shared primitives (`Card`, `Btn` variants, `Tag`, `Banner`, `TrustBadge`, `CertGrid`, `Icon` set) to the new language; add any new icons the design uses (key, USB, file-types, OS window controls). Reskin the `AgentPanel` states (unavailable / checking / error / available) to the design's banners.
- [ ] Final Phase-1 verify: `npm run build` green; run `npm run tauri dev`, walk Signer → PIN → sign → success → Vérifier against the canvas; the eIDAS flows behave exactly as before.
- [ ] Commit Phase 1 (per task, scope `ui`).

---

## Phase 2 — New surfaces + dark mode

> **Caveat to resolve first:** the **Accueil dashboard** shows stats ("24 documents signés ce mois", "18/18 vérifications", recent activity) and an activity history. The app today is **stateless** — it signs and forgets, with no persistence. So the dashboard implies a **new history/persistence feature** that does not exist. Decide per surface: stub with honest empty states ("Aucune activité récente pour le moment"), or scope a real local history (a new feature, larger). Do NOT ship fabricated numbers.

- [ ] **Task 8: Accueil/Dashboard** (`components/Dashboard.tsx` + an "Accueil" tab). Hero key card (real cert from AgentContext), the stat cards + recent-activity list as honest empty/placeholder states until a history feature exists. Canvas `SCREEN: ACCUEIL`.
- [ ] **Task 9: Clé & certificat** (`components/KeyCertPage.tsx`). Token card + USB illustration + full cert details from `selectedCert`. Mostly display; wire to AgentContext. Canvas `SCREEN: CLE & CERTIFICAT`.
- [ ] **Task 10: Prérequis screen**. Promote `services/prerequisites` + `PrerequisitesPanel` into the full step-list screen. Canvas `SCREEN: PREREQUIS`.
- [ ] **Task 11: First-launch wizard** (`components/FirstRunWizard.tsx`, 3 frames: prérequis → test PIN → vérification). Gate on first run (local flag). Canvas `WIZARD PREMIER LANCEMENT`.
- [ ] **Task 12: Dark mode**. Add a `[data-theme="dark"]` variable set (canvas `15/17 THEME SOMBRE`) and wire the sidebar Thème toggle (persist the choice). All components already use variables after Phase 1, so this is mostly a second token block.
- [ ] **Task 13 (stretch): i18n FR/EN** behind the Langue toggle.
- [ ] **Task 14 (optional): PUK unblock** recovery screen. Canvas `DEBLOCAGE PUK`.

---

## Cross-cutting rules

- **Never touch the logic.** `AgentContext`, `agentApi`, `backendApi`, the sign/verify state machines stay byte-for-byte. The refonte is JSX/CSS + new components only. If a screen seems to need new data the app doesn't have (history, stats), stub honestly — don't fabricate, don't invent backend calls.
- **Both environments.** Every change must keep `npm run build` (web) green AND work in `npm run tauri dev`. The titlebar/window-controls are Tauri-only (feature-detect).
- **Mockup data is illustrative.** Names/dates/counts in the canvas are placeholders; bind to real AgentContext/validation data where it exists, stub the rest.
- **Verification is visual.** After each task: build green + render the screen against `design-ref/EU-DSS-Sign.dc.html` (or the live URL). Faithfulness to the design is the acceptance bar.

## Suggested execution

Phase 1 is the high-value, bounded transformation (the working app, new look). Run it subagent-driven, one task per dispatch, with a visual check against the canvas between tasks. Phase 2 is additive and can follow once Phase 1 lands — resolve the dashboard persistence question with the user before Task 8.
