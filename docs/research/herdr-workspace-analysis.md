# ccdeck Workspace: analiză comparativă cu Herdr

Data: 2026-11-17. Analiză inițială, fără modificări ale interfeței.

## Baza comparației

- ccdeck: `next/v4`, commit `13d1d45c1`, într-un branch separat.
- Herdr: [herdrdev/herdr-app](https://github.com/herdrdev/herdr-app), commit
  `321c9a84bc928f1c31be59e73dad966d86a3e252`; site-ul și ghidul oficial.
- Capturile oferite de proprietar: lista Herdr grupată pe proiecte și ccdeck
  Workspace cu trei terminale și Usage deschis.
- Evaluări independente: A — structură, lizibilitate și interacțiuni;
  B — detector și observații în browser. Comparația Herdr provine din capturi
  și cod; aplicația nativă Herdr nu a fost instalată sau testată.

Captura ccdeck nu reprezintă exact baza analizată. Runtime-ul local este servit
dintr-un alt worktree, cu modificări proprii. În captură există o a treia linie
cu furnizorul și modelul; `RailParts.tsx` la baza analizată afișează maximum două
linii. Orice implementare trebuie comparată cu baza noului branch și coordonată
cu lucrările separate asupra chrome-ului sesiunilor.

## Concluzie

Direcția utilă este un Workspace în care numele sarcinii conduce lista, urgența
este evidentă, iar panoul care primește tastatura se identifică imediat. Herdr
oferă exemple concrete pentru această ierarhie. Nu avem măsurători care să arate
că rendererul nativ sau o anumită durată de animație explică diferența percepută.

ccdeck are deja mecanismele esențiale: prioritizarea așteptărilor, rezultate
necitite, split, zoom, redenumire și navigare din tastatură. Prima etapă trebuie
să le facă mai ușor de înțeles și folosit.

## Ce am verificat în Herdr

În [lista agenților](https://github.com/herdrdev/herdr-app/blob/321c9a84bc928f1c31be59e73dad966d86a3e252/defaults/mods/agents/main.js):

- Rândul normal are 30px, iconul programului 16px, numele trunchiat, timpul și
  starea la dreapta. Numele și starea au roluri separate.
- Există ordonare după prioritate și grupare pe spațiu. Imaginea oferită arată
  una dintre variante; nu este singurul mod de organizare al produsului.
- Starea care cere intervenție are text explicit. Working, Done și Idle au
  semne distincte; culorile nu trebuie transplantate peste semantica ccdeck.
- Se pot fixa agenți în partea de sus; subagenții sunt imbricați și pot fi pliați.
- Titlul folosește numele stabil ales de persoană sau un titlu relevant raportat
  de terminal, în locul identificatorilor tehnici nefolositori.

[Header-ul panoului](https://github.com/herdrdev/herdr-app/blob/321c9a84bc928f1c31be59e73dad966d86a3e252/defaults/mods/pane/main.js)
arată numele, folderul și starea. Acțiunile secundare apar la hover. În ccdeck,
orice dezvăluire similară trebuie să funcționeze și la focus și pe touch.

[Peek](https://github.com/herdrdev/herdr-app/blob/321c9a84bc928f1c31be59e73dad966d86a3e252/defaults/mods/peek/main.js)
permite inspectarea temporară a unui agent și trecerea explicită la panoul lui.
Această separare dintre privire și lucru este un reper bun pentru selecția ccdeck.

## Ce există deja în ultima next/v4

| Capacitate | Dovadă în ccdeck | Implicație |
|---|---|---|
| Listă de maximum două linii, fără model afișat în rând | `components/RailParts.tsx` | Nu repetăm eliminarea metadatelor deja făcută. |
| Needs you → Done · new → Working → Done → Ready | `rail-model.ts` | Rezultatele noi sunt deja înaintea muncii care nu cere atenție. |
| Timpi compacți, fără actualizare vizuală la fiecare secundă | `rail-row-copy.ts` | Nu este necesar un alt sistem de cronometre. |
| Nume consecvent și diferențiere pentru sesiuni omonime | `rail-row-copy.ts`, `session-display.ts` | Păstrăm aceste reguli la comprimarea rândurilor. |
| Ordinea este ținută pe loc sub pointer și la focus de tastatură | `rail-model.ts`, `SessionList.tsx` | Nu pierdem protecția împotriva mutării unei ținte în timpul selecției. |
| Enter pentru scriere, Shift+Enter pentru deschidere alăturată, F2 pentru nume | `components/RailParts.tsx` | Îmbunătățim descoperirea comenzilor existente. |
| Split, drag, zoom și păstrarea terminalelor montate | `workspace-split.ts`, `components/terminal/StageShell.tsx` | Este necesar rafinament, nu reconstruirea infrastructurii. |
| Chat activ implicit pentru Claude în Workspace | `use-screen-flags.ts`, `use-session-transcript.ts` | Codex nu are încă aceeași cale de citire în Chat. |

## Cinci direcții prioritare

### 1. Listă orientată spre sarcină — prima intervenție

**Observație:** captura afișează multe metadate; baza nouă este mai simplă, dar
rândurile păstrează minimum 44px în Compact și 60px în Default. Herdr folosește
30px pentru rândul simplu. Acestea sunt valori din sursă, nu măsurători la aceeași
scară pe două aplicații.

**Propunere:** rând de 32–36px pentru o sesiune simplă pe desktop, ca ipoteză de
prototip. Nume, timp și stare; iconul furnizorului poate ajuta recunoașterea dacă
folosește un asset potrivit și o etichetă accesibilă. O a doua linie rămâne când
explică o așteptare, un eșec sau diferențiază sesiuni. Pe touch rămân ținte de
minimum 44px. Preferințele valide de text și densitate trebuie respectate.

Modelul, effort-ul, calea completă și ultimul prompt întreg rămân accesibile prin
Inspector, focus sau detalii; nu toate trebuie repetate permanent în navigator.

**Verificare:** zece sesiuni, nume lungi și duplicate, două repo-uri cu același
basename, așteptare cu explicație lungă și scalarea textului. Verificăm dacă
persoana poate identifica sesiunea cerută, nu doar câte rânduri încap.
Testăm și titluri diferite cu același început: diferențierea existentă compară
textele complete, deci nu detectează obligatoriu coliziuni produse de trunchiere.
Acesta este un risc de verificat, nu un defect reprodus în browser.

### 2. Legătură explicită între listă, panou și tastatură

**Observație:** ccdeck are deja selecție, panou focalizat și proprietar al
tastaturii. În cod, click pe rând și Enter au intenționat rezultate diferite.
Captura statică nu dovedește că această diferență este înțeleasă de utilizator.

**Propunere:** selecția, hover-ul și faptul că o sesiune este deschisă într-un
split trebuie să rămână recognoscibile separat. Un singur panou este activ;
header-ul lui și rândul asociat trebuie să se citească împreună. Indicație
contextuală scurtă pentru Enter și Shift+Enter. Fără schimbarea automată a
proprietarului tastaturii la o simplă trecere cu pointerul.

**Verificare:** click A, Enter, tastare într-o sesiune de test, eliberarea
tastaturii, selectare B, deschidere alăturată, zoom și revenire. Textul nu poate
ajunge într-un terminal ascuns sau în sesiunea anterioară.

### 3. Mai mult loc util pentru terminalul citit

**Observație:** captura împarte zona centrală în trei terminale, cu Usage deschis
permanent. Aceasta explică o parte din densitatea percepută. ccdeck are deja zoom,
controlul mărimii textului și comportament pentru panouri înguste.

**Propunere:** facem zoom-ul și revenirea ușor de descoperit și păstrăm Usage
accesibil la cerere. Nu închidem automat panourile preferate ale persoanei.
Header-ul păstrează numele, starea, contextul și acțiunea imediată; utilitarele
secundare se grupează când panoul devine îngust. Separatoare și suprafețe din
temele existente, coordonate cu lucrările de chrome deja separate.

**Verificare:** același conținut la 1440 și 1100px, cu unu, două și trei panouri;
resize repetat, text mărit și revenire după zoom. La 390 și 320px evaluăm fluxul
mobil existent, nu comprimăm Workspace-ul desktop în trei coloane.

### 4. Grupare pe proiecte, comparată cu prioritatea existentă

**Varianta A:** păstrăm grupurile de atenție și simplificăm rândurile. Cost și risc
mai mici; răspunde direct scopului principal ccdeck.

**Varianta B:** proiecte pliabile pentru orientare, cu o zonă de așteptări
prioritare vizibilă deasupra. Apropiată de referință; necesită reguli pentru
sesiuni mutate, proiecte omonime, fold, selecție și evitarea dublurilor.

**Recomandare:** A pentru prima etapă. Comparăm B ulterior cu aceleași sesiuni
reale, înainte să introducem un selector nou sau o a doua navigație permanentă.
Fixarea sesiunilor este un candidat ulterior dacă lista compactă nu rezolvă
revenirea la aceleași sarcini.

**Verificare:** găsirea unei sarcini după proiect, apariția unei cereri într-un
proiect pliat și păstrarea selecției când se schimbă starea.

### 5. Continuitatea Chat / Term — lucrare funcțională separată

**Limită confirmată:** `chatSessionFor()` acceptă numai Claude. `TerminalStage`
revine în Term pentru scriere. Conversația activă este recitită la intervale de
5 secunde; acest interval nu dovedește singur o problemă de performanță, dar poate
explica o senzație diferită față de terminalul care primește output continuu.
Decision este dezactivat implicit și nu are cale de răspuns funcțională.

**Problemă mică, confirmată în sursă:** `ChatTurn.tsx` desenează un chevron de
expandare la fiecare instrument, însă rândul nu are acțiune de expandare.
Eliminarea acestui indiciu până există detalii accesibile poate intra în prima
etapă; nu depinde de suportul pentru conversații Codex.

**Propunere:** întâi facem clară promisiunea curentă: citești în Chat, răspunzi în
Term, cu focus corect și poziție de citire păstrată. Apoi investigăm un adaptor
pentru conversațiile Codex și actualizări incrementale. Scrierea directă în Chat
ar cere un contract nou de trimitere, tratarea sesiunilor ocupate și testarea
livrării; un câmp vizual de text nu ar finaliza această funcție.

**Verificare:** Claude și Codex, terminal indisponibil, sesiune în lucru, schimbare
de sesiune, scroll în istoric în timpul output-ului și eroare/reîncercare. Nicio
cerere sau aprobare nu trebuie afișată ca executată dacă aplicația nu a executat-o.

## Ordinea recomandată

1. Prototip al listei compacte pe grupurile existente, plus selecție și focus.
2. Verificarea aceluiași flux cu terminale reale de test și dimensiuni diferite;
   rafinarea header-ului și a accesului la zoom pe baza rezultatului.
3. Comparație între gruparea după atenție și după proiect, cu aceleași date.
4. Chat pentru Codex și continuitatea răspunsului, estimate separat.

Identitatea ccdeck, vocabularul stărilor și închiderea care lasă sesiunea să ruleze
rămân contracte de produs. În Herdr, README precizează că închiderea unui pane/tab
încheie terminalele sale; simbolul de închidere nu trebuie preluat cu această
semnificație. Nici interfața nativă, galeria de moduri și orchestrarea agenților nu
sunt necesare pentru prima îmbunătățire a acestui Workspace.

## Verificări și limite

- Citite componentele, state ownership, tokenurile de densitate, documentele
  produsului și codul public Herdr; fără copiere de implementare sau asset-uri.
- Detector rulat o singură dată pe `SessionList.tsx`: zero alerte. Acest control
  nu validează întreaga interfață, accesibilitatea sau experiența utilizatorului.
- Pagina locală s-a încărcat în browser într-un context separat. Turul de primă
  utilizare a fost vizibil; nu am validat geometria ori interacțiunile Workspace
  live pe baza noului branch. Încărcarea aplicației a declanșat trei apeluri
  `/api/forget`, cu răspuns 200: sursa le folosește pentru invalidarea cache-urilor
  sesiunilor eliminate de prunarea clientului. Nu au fost comenzi de oprire a
  terminalelor. Un context de browser separat nu izolează serverul.
- Observațiile vizuale despre Workspace folosesc capturile furnizate. Testele
  responsive, contrastul compus, performanța și scenariile de tastare rămân pași
  pentru prototip/implementare, nu rezultate ale acestei analize.
- Nu au fost rulate build-ul sau testele: livrabilul schimbă numai documentația.

Nu este un verdict de lansare și nu reprezintă un studiu cu utilizatori.
Întrebările de alegere vizuală sunt amânate până există un prototip comparabil;
cererea curentă este analiza inițială.
