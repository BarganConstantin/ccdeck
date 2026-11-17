# Workspace: primul lot de claritate

2026-11-17. Branch: `feature/v4-terminal-chat`, bazat pe `next/v4` la `13d1d45c1`.
Pregătit pentru verificarea vizuală a proprietarului, înainte de integrare.

## Comportament

- În Workspace, sesiunile cu nume distinct ocupă un rând compact, cu proiectul
  lângă nume. Așteptările, erorile, sesiunile eliminate și numele duplicate
  păstrează explicația. Lista de pe Board își păstrează forma.
- La densitatea Compact, un rând simplu are 34px; la Default/Comfortable are
  minimum 50px. Textul mărit poate crește rândul; dispozitivele touch păstrează
  minimum 44px. Informația completă rămâne în tooltip și în numele accesibil.
- Un număr comun leagă rândul unei sesiuni deschise de header-ul panoului său.
  Numerele urmează ordinea panourilor, inclusiv în strip-ul de zoom. Panoul activ
  are un contur distinct; aceasta nu afirmă că terminalul primește tastatura.
- Rândurile instrumentelor din Chat nu mai afișează săgeți fără expandare.

Gruparea după atenție, selecția, traseele Enter/Shift+Enter și ciclul de viață
al terminalului rămân cele existente. Nu s-a adăugat Chat pentru Codex sau
trimitere de mesaje din Chat.

## Verificări

Pe Node 22:

- `npm run typecheck` — trecut.
- `npm run build` — trecut; avertismentul existent despre dimensiunea chunk-urilor.
- 435 teste trecute, 14 fișiere: `v4-rail`, `rail-row-tell`, `v4-chat-view`,
  `workspace-split`, `workspace-split-wiring`, `v4-workspace-keys`,
  `v4-workspace-keys-behavior`, `i18n`, `chat-i18n`, `contrast-floors`,
  `v4-workspace-review`, `v4-workspace-layout`, `workspace-session-links`,
  `workspace-compact-rows` din `src/web/__tests__/`.
- Ultimele două fișiere adaugă 33 de regresii pentru ținta actuală a panoului,
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
- Conversațiile sintetice trec prin ruta reală de transcript Claude. Instrumentele
  se afișează fără săgeți de expandare.

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
