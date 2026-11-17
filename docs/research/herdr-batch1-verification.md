# Workspace: primul lot de claritate

2026-11-17. Branch: `feature/v4-terminal-chat`, bazat pe `next/v4` la `13d1d45c1`.
Pregătit pentru verificarea vizuală a proprietarului, înainte de integrare.

## Comportament

- În Workspace, sesiunile cu nume distinct ocupă un rând compact. Proiectul
  apare lângă nume numai peste 300px; la lățimi mai mici rămâne în detalii și
  în numele accesibil. Așteptările, erorile, sesiunile eliminate și numele duplicate
  păstrează explicația. Lista de pe Board își păstrează forma.
- La densitatea Compact, un rând simplu are 34px; la Default/Comfortable are
  minimum 50px. Textul mărit poate crește rândul; dispozitivele touch păstrează
  minimum 44px. Informația completă rămâne în tooltip și în numele accesibil.
- Iconurile Claude Code și Codex apar în listă și în headere; starea este separată,
  lângă timp. Numerele panourilor rămân în header, tooltip și numele accesibil al
  rândului, fără badge vizibil în listă. Panoul activ păstrează semnalizarea sa.
- Rândurile cu explicații au mai mult spațiu vertical: 53px măsurați la Compact.
  Pentru gemenii deja deschiși într-un panou, ora exactă rămâne în tooltip,
  eliberând linia comenzii. Gemenii fără panou păstrează ceasul de diferențiere.
- Rândurile instrumentelor din Chat nu mai afișează săgeți fără expandare.

Gruparea după atenție, selecția, traseele Enter/Shift+Enter și ciclul de viață
al terminalului rămân cele existente. Nu s-a adăugat Chat pentru Codex sau
trimitere de mesaje din Chat.

## Verificări

Pe Node 22:

- `npm run typecheck` — trecut.
- `npm run build` — trecut; avertismentul existent despre dimensiunea chunk-urilor.
- 529 teste trecute, 17 fișiere: `v4-rail`, `rail-row-tell`, `v4-chat-view`,
  `workspace-split`, `workspace-split-wiring`, `v4-workspace-keys`,
  `v4-workspace-keys-behavior`, `i18n`, `chat-i18n`, `contrast-floors`,
  `v4-workspace-review`, `v4-workspace-layout`, `workspace-session-links`,
  `workspace-compact-rows`, `terminal-stage-view`, `brand-kit`, `notices-bundle`
  din `src/web/__tests__/`.
- Fișierele `workspace-session-links` și `workspace-compact-rows` au 39 de regresii pentru ținta actuală a panoului,
  numerotare, contextul rândurilor și absența expandării false.
- Review independent al logicii: fără defecte identificate.
- Detectorul Impeccable pe componentele schimbate: zero alerte.
- `git diff --check` — trecut.

În Chrome, cu aplicația construită și un backend izolat cu sesiuni sintetice:

- 1440×900 și 1100×700: rânduri de 34/44px, fără overflow orizontal; potrivire
  între numerele din listă și cele din trei panouri.
- Click pentru schimbarea panoului, Enter, Shift+Enter până la patru panouri,
  zoom și revenire: asocierea vizuală rămâne corectă. Testele nu au trimis text
  vreunui agent real.
- 390×844 și 320×700: trecere la fluxul mobil existent, fără overflow orizontal.
- Text Largest și densitate Comfortable: rândurile cresc la 50/60px în captura
  măsurată, fără overflow orizontal sau dispariția titlurilor.
- Contrast compus al numărului activ din lista selectată, după corecție:
  Rider Black 6.59:1, Light 12.81:1, White Contrast 12.24:1, Dark 7.67:1.
  Acesta este un eșantion al noii componente, nu o certificare a întregului UI.
  În revizia cu avataruri, numărul nu mai este desenat în listă; stilul său
  rămâne în header. Iconurile sunt fișierele originale, cu proveniența și
  licența reproduse în `THIRD_PARTY_NOTICES.md`.
- Conversațiile sintetice trec prin ruta reală de transcript Claude. Instrumentele
  se afișează fără săgeți de expandare.

## Revizie: avataruri monocrome și aliniere

La cererea proprietarului, Claude Code și Codex folosesc acum variantele
monocrome originale LobeHub, fără fundal alb. Fișierele sunt nemodificate;
proveniența, hash-urile și licența sunt în `THIRD_PARTY_NOTICES.md`.
Masca CSS ia culoarea textului din temă. Ambele ocupă un slot de 20px;
Codex este desenat la 16px în interior pentru echilibru optic cu Claude.

Verificări pe revizia monocromă, cu Node 22:

- `npm run typecheck` și `npm run build` — trecute. Build-ul păstrează
  avertismentul existent despre dimensiunea chunk-urilor.
- 333 teste trecute în cele opt fișiere afectate: `workspace-compact-rows`,
  `v4-rail`, `rail-row-tell`, `v4-chat-view`, `terminal-stage-view`,
  `contrast-floors`, `brand-kit`, `notices-bundle`. Cele 529 de teste de mai
  sus descriu verificarea lotului anterior, nu o rerulare integrală a reviziei.
- Detectorul Impeccable: zero alerte pe `ProviderAvatar`, `RailParts` și
  `StageHeader`.
- În build-ul servit, Chrome la 1440×900: centrele avatarului, titlului și
  stării coincid în toate cele 25 de combinații de text și densitate.
  Rândurile cu două linii compensează jumătate din înălțimea explicației și
  a spațiului său, inclusiv când densitatea adaugă spațiu în rând.
- Toate cele 12 teme: fundal transparent și contrast compus al iconurilor de
  minimum 5.27:1 în eșantionul de listă și headere, inclusiv Codex selectat.
  Cele patru colțuri ale ambelor SVG-uri au alpha zero; nu există pătrat alb.
  Aceasta nu este o certificare a întregii interfețe.
- 390×844 și 320×700: fluxul mobil existent rămâne fără overflow orizontal;
  acesta folosește în continuare rândurile mobile cu starea în stânga.

## Revizie: Working se rotește continuu

Indicatorul Working din lista de sesiuni folosește rotația CSS existentă,
cu viteză constantă și perioada de 1,2s din `--loop-loader`. Nu mai pulsează
în modul normal; Waiting și Done rămân statice. La mișcare redusă păstrează
pulsul de opacitate în locul rotației.

- Node 22: 175 teste trecute în `v4-rail`, `canvas-motion`, `v4-motion-tokens`,
  `rail-row-tell` și `workspace-compact-rows`; typecheck și build trecute.
- Chrome, build servit: observare pe 1,6s, fără resetarea animației, opacitate
  constantă și poziție fixă a slotului. Rotația continuă după redimensionarea
  de la 1440×900 la 1100×700. La 390 și 320px nu apare overflow orizontal.
- Regulile de mișcare redusă activate temporar în CSSOM-ul paginii izolate
  dau `pulse` și `transform: none`, apoi sunt restaurate. Nu s-a schimbat
  preferința sistemului proprietarului.

## Previzualizare și limite

Aplicația completă: `http://127.0.0.1:4479/batch1-preview.html`.
Pagina de pornire din build-ul local pregătește trei panouri și deschide Chat.
Bootstrap-ul de previzualizare este un artefact local ignorat de Git, nu cod
livrat. O reconstruire îl elimină și trebuie regenerat.

Backend-ul folosește configurații și transcript-uri sintetice separate.
Sesiunile fixture nu au terminale reale de atașat: Term poate afișa refuzul
de atașare. Harness-ul separat `http://127.0.0.1:5197/` permite tastare cu ecou
local în memorie; geometria split-ului său este proprie și nu validează
orchestrarea panourilor din aplicație.

Nu au fost validate tastarea către un agent real, fluxul extern de evenimente,
platformele Windows/Linux sau integrarea în `next/v4`. Suita completă și CI
aparțin verificării de integrare, după confirmarea vizuală.
