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

## Revizie: conversație structurată și context discret

Chat identifică fiecare răspuns, păstrează mesajele utilizatorului pe linii
separate și formatează paragrafe, liste, titluri, citate și blocuri de cod.
Copierea unui răspuns păstrează textul Markdown. HTML-ul și linkurile rămân
text literal; acesta este un subset de Markdown, nu un renderer CommonMark complet.

Apelurile consecutive sunt grupate într-un disclosure nativ. Un apel cu argument
poate fi deschis pentru a citi argumentul primit de la server; un apel fără
argument nu pretinde că se poate deschide. Grupul în curs este deschis inițial,
iar cele încheiate sunt strânse. Lipsa stării Running nu este prezentată drept
succes. Argumentele sunt limitate de ruta existentă la 120 de caractere;
disclosure-ul nu oferă un jurnal complet de intrări sau rezultate.

Citirea mai sus în conversație păstrează poziția la polling. „Latest messages”
revine la sfârșit și mută focusul în regiunea de citire. Butonul aparține zonei
scrollabile, separat de eventualul card de întrebare. Footerul explică unde
se poate răspunde și folosește acțiunile existente de trecere în Term.

În lista Workspace, numele duplicate din proiecte diferite afișează numai
proiectul necesar diferențierii. Promptul și ora exactă rămân în tooltip și
în textul accesibil. Același proiect cere contextul sarcinii; doar gemenii cu
același provider și același prompt integral păstrează ceasul. La coliziunea
ceasului apare și coada distinctă a ID-ului. Această regulă înlocuiește pentru
Workspace regula anterioară care ascundea ceasul gemenilor deschiși în panouri.

Verificări pe această revizie, Node 22:

- 438 teste trecute în 14 fișiere: `chat-conversation`, `chat-markdown`,
  `chat-follow`, `chat-i18n`, `v4-chat-view`, `v4-chat-writes-in-term`,
  `workspace-compact-rows`, `v4-rail`, `v4-decision-chat-geometry`,
  `rail-row-tell`, `i18n`, `contrast-floors`, `terminal-stage-view` și
  `workspace-session-links`. Typecheck și build trecute; avertismentul
  existent despre mărimea chunk-urilor rămâne.
- Detector Impeccable: zero alerte pe cele șase componente schimbate.
- Chromium izolat cu build-ul servit: 1440×900, Rider Black și Light;
  text Largest și Comfortable la 1100×700. Fără overflow orizontal în
  aplicație sau în corpurile conversațiilor.
- Expandare din tastatură, argumentul real al unui apel, copierea răspunsului
  în clipboard, păstrarea scroll-ului după un polling de peste 5 secunde,
  revenirea la ultimele mesaje cu focus și Show Term verificate în browser.
- 390 și 320px: fluxul mobil existent, fără overflow. Separat, Chat și footerul
  au fost verificate ca elemente în panouri de 390 și 320px; textul se încadrează,
  iar blocul de cod are propriul scroll orizontal.
- Pointer coarse real în contextul browserului: instrumente, copiere și
  butoanele noi din footer au minimum 44px. Zero erori JavaScript observate.

Conexiunile DevTools și Browser plugin nu au fost disponibile în această rundă;
QA a folosit Chromium headless instalat local, într-un context separat.
Aceste verificări susțin review-ul vizual al lotului local, nu o lansare.
Verdict pentru lotul local: **SHIP WITH FOLLOW-UPS**. Confirmarea vizuală a
proprietarului și verificarea de integrare rămân înainte de v4; Chat păstrează
limitele de provider și de trimitere descrise mai jos.

## Revizie: răspuns direct și Workspace mai liniștit

La cererea proprietarului, Chat are acum o casetă de răspuns conectată la
aceeași sesiune de terminal. Enter trimite, Shift+Enter păstrează linia nouă,
iar compoziția IME nu trimite accidental. Draftul este ținut în memoria
panoului pentru fiecare sesiune și se păstrează la schimbarea Chat/Term;
închiderea panoului sau reîncărcarea paginii nu promite persistență.

Trimiterea cere o conexiune live care permite scrierea, identitatea exactă a
sesiunii și absența unei cereri de confirmare raportate de aceasta. Textul se
trimite ca paste, apoi Enter. Nu există retry sau coadă ascunsă: refuzul
păstrează draftul, iar o trimitere parțială cere verificarea în Term înainte
de repetare. „Sent” înseamnă acceptarea de transportul local, nu confirmarea
agentului. Nu s-a adăugat un API pentru conversații sau un provider nou.

Compoziția vizuală a fost revizuită după exemplele publice
[Herdr Chat și Code](https://herdr.dev/). Caseta este acum un singur control
integrat în conversație, cu hint de tastatură doar cât compui și o singură
linie pentru starea conexiunii. În eșantionul desktop măsurat, footerul normal
are 76px, iar cel deconectat 108px, față de aproximativ 180px în prima variantă.
Instrumentele păstrează disclosure-urile funcționale, cu o linie discretă
pentru apelurile deschise, fără o cutie în jurul fiecărui grup.

Headerele și comutatoarele panourilor respectă textul mărit. Sub 400px,
comenzile headerului sunt în meniul existent More, păstrând un singur rând
și mai mult loc pentru nume. Fiecare panou are un ID propriu pentru meniu și
ancora lui. Lista evită repetarea promptului la gemenii unde proiectul și
ceasul deja fac diferența; promptul integral rămâne accesibil.

Verificarea reviziei finale, Node 22:

- 574 teste trecute în 20 de fișiere afectate, inclusiv controllerul și
  protocolul terminalului, composerul, integrarea cu stage-ul, meniurile,
  drafturile între sesiuni, lazy loading, bundle-ul construit și i18n.
  Typecheck și build trecute; avertismentul de mărime a chunk-urilor rămâne.
- Chromium izolat cu build servit: 1, 2 și 4 panouri la 1440×900, Rider Black
  și Light; text Largest inclusiv 4 panouri la 1920×1080. Fără overflow
  orizontal în eșantionul vizibil. Au fost verificate separat panouri de
  390 și 320px și fluxul mobil existent la aceste lățimi.
- Meniul îngust se deschide din tastatură, își păstrează comenzile și
  restaurează focusul; meniurile a două panouri folosesc ancore distincte.
- Trimiterea cu Enter, Shift+Enter, IME, focusul rămas în Chat, draftul
  păstrat la Chat/Term și refuzul unei sesiuni deconectate au fost verificate.
  Caseta crește până la limita de șase linii, apoi are scroll propriu și se
  micșorează când textul este șters. Send are minimum 44px la pointer coarse.
- În plus față de testele cu stand-in-uri, mesajul pe două linii, cu
  diacritice, a traversat engine-ul local instalat și a ajuns exact o dată
  într-un proces demonstrativ real. Procesul a scris răspunsul său fix într-un
  transcript citit prin ruta reală a aplicației. Zero erori JavaScript
  observate. Nu s-a pornit niciun model și nu s-a făcut o cerere AI plătită.

Verdict local: **SHIP WITH FOLLOW-UPS**, pregătit pentru review vizual.
Chat rămâne disponibil pentru transcript-uri Claude. O sesiune externă care
nu se poate atașa nu devine controlabilă doar prin această casetă. Comportamentul
cu un agent AI real și platformele Windows/Linux nu au fost verificate aici.

## Previzualizare și limite

Aplicația completă: `http://127.0.0.1:4479/batch1-preview.html`.
Pagina de pornire din build-ul local pregătește trei panouri și deschide Chat.
Bootstrap-ul de previzualizare este un artefact local ignorat de Git, nu cod
livrat. O reconstruire îl elimină și trebuie regenerat.

Backend-ul folosește configurații și transcript-uri sintetice separate.
Revizia curentă deschide implicit și Reply demo: un proces local de ecou prin
engine-ul real de terminal, cu un transcript etichetat demonstrativ. Poți
încerca trimiterea acolo fără un model. Cele șase sesiuni sintetice anterioare
rămân pentru comparație; cele care nu se atașează afișează Send dezactivat.
La revizia Chat, backend-ul a fost repornit exclusiv în mediul izolat și
inițializează direct cele șase sesiuni și maparea transcript-urilor sintetice.
Nu mai depinde de procesul separat de seed pentru Chat.
Sesiunile fixture nu au terminale reale de atașat: Term poate afișa refuzul
de atașare. Harness-ul separat `http://127.0.0.1:5197/` permite tastare cu ecou
local în memorie; geometria split-ului său este proprie și nu validează
orchestrarea panourilor din aplicație.

Nu au fost validate tastarea către un agent AI real, fluxul extern de evenimente,
platformele Windows/Linux sau integrarea în `next/v4`. Suita completă și CI
aparțin verificării de integrare, după confirmarea vizuală.
