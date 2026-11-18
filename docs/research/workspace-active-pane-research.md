# Workspace: identificarea discretă a panoului activ

2026-11-17. Bază inspectată: `feature/v4-terminal-chat`, `6dd8294d5`.
Research `matt-research`, cu verificare independentă a surselor; direcție
Impeccable **Operate**: orientare rapidă, semnale consecvente, expresie reținută.

## Recomandare și decizie

**Header activ discret + index umplut neutru**, aceeași selecție prin suprafață
în tabul îngust. Eliminăm linia albastră continuă de 2px din ambele contexte.
Coordonatorul a comparat în aplicație `quietHeader`, `badgeOnly`, `neutralFrame`
și a ales prima variantă; implementarea și verificarea vizuală îi aparțin.
Sursele susțin separarea selecției de focus și folosirea suprafețelor tematice;
amestecul de **5%** și combinația concretă sunt decizii ccdeck, nu reguli shadcn.

## Fapte din surse primare actuale

Verificate la data de mai sus. Codul shadcn este fixat la
`968d8cb9dc42ae5d52e8fd356cf84596ec832a26`, HEAD oficial consultat atunci.
Exemplele de stil de mai jos identifică presetul **Nova** și baza **Radix**;
nu presupun că toate presetările sunt identice și nu dovedesc un „trend 2026”.

- **Tabs:** documentația oferă varianta implicită și `variant="line"`.
  Implementarea oficială New York v4 marchează selecția implicită prin fundal
  și text, cu tratament întunecat propriu; linia alternativă aparține triggerului,
  în culoarea foreground. `focus-visible` are selectori independenți.
  [Docs Tabs][tabs-doc], [sursă Tabs][tabs-src].
- **Sidebar:** `isActive` produce `data-active`; Nova folosește fundal/foreground
  din tema sidebarului și greutate medie. Inelul `focus-visible:ring-2` este
  separat. Numele „accent” al tokenului nu garantează o culoare neutră.
  [Docs Sidebar][sidebar-doc], [stare][sidebar-src], [stil Nova][nova-sidebar].
- **Card:** structura header/content/footer este documentată; Card nu definește
  selecție. Nova îi dă `bg-card` și un contur de 1px, `foreground/10`.
  Conturul este un reper de container, nu dovadă că acesta este activ.
  [Docs Card][card-doc], [componentă][card-src], [stil Nova][nova-card].
- **Radix Tabs:** conținutul este afișat câte un panou; există activare automată
  sau manuală și `data-state="active"`. Primitiva este nestilizată.
  Preluăm ideea vizuală, fără a transforma splitul cu patru terminale vizibile
  într-un tablist. [Tabs Radix][radix], [styling Radix][radix-style].
- **WAI APG:** selecția poate persista după mutarea focusului; indicatorul de
  focus trebuie să rămână vizibil și distinct. [Focus și selecție][apg].

## Trei alternative — inferențe de design pentru ccdeck

| Variantă | Tratament | Avantaj și compromis |
| --- | --- | --- |
| **quietHeader — aleasă** | Header `color-mix(in srgb, var(--text) 5%, var(--panel))`; index activ cu fundal `--text-secondary` și cifră `--panel`. | Orientează pe suprafața headerului și prin forma umplută a indexului; contrastul trebuie verificat în fiecare temă. Inspirată de selecția prin suprafață din Tabs/Sidebar. |
| badgeOnly | Doar indexul activ umplut, restul headerului identic. | Foarte calm; semnalul de 18px poate fi greu de găsit între patru panouri. Nu este prima alegere pentru scanare. |
| neutralFrame | Contur neutru discret în interiorul panoului activ, cu index distinct. | Delimitează clar întregul panou; adaugă muchii lângă separatoare și poate semăna cu focusul. Card justifică vocabularul conturului, nu semantica de selecție. |

## Dovezi locale și contract pentru implementare

- La bază, linia reclamată este un **box-shadow inset**, nu un border:
  [workspace-split.css](../../src/web/styles/workspace-split.css),
  `.wsp-pane[data-focused] .ts-head`; `.wsp-tab[data-on]` repetă același 2px.
  Headerele inactive păstrează titlul `--text-secondary`; nu reducem opacitatea.
- [StageShell](../../src/web/components/terminal/StageShell.tsx) expune
  `data-focused` numai în modul multipanou. Cu un singur panou nu trebuie creat
  un nou semnal concurent. [PaneBadge](../../src/web/components/PaneBadge.tsx)
  și `pane-badge[data-active]` oferă deja indexul și starea necesare.
- **Trei stări diferite:** panoul ales (`split.focused`), focusul DOM și
  proprietarul tastării (`session.keysOwner`).
  [use-stage.ts](../../src/web/use-stage.ts), `focusPaneId`, și
  [StageHeader](../../src/web/components/terminal/StageHeader.tsx), butonul
  Keyboard cu `aria-pressed`, arată separarea. Headerul ales nu promite că
  terminalul primește text; nu schimbăm aceste mecanisme prin CSS.
- Convenția neutră există: `--selected` amestecă 8% `--text` cu `--panel`, iar
  `--ctl-fill` folosește 7–8% text spre transparent în
  [temele generate](../../src/web/styles/themes.css). Pentru header alegerea de
  5% este opacă, amestecată cu `--panel`; nu introducem hex-uri sau palete noi.
- Focusul efectiv v4 este `--focus-w: 1.5px`, contur `--accent` inset în
  [tokens.css](../../src/web/styles/tokens.css). Pasajul de 2px din DESIGN.md
  este mai vechi. Păstrăm contururile tastaturii și muchiile dividerului la
  focus/drag; nu aplicăm `outline: none` pentru a elimina linia de selecție.
- Tabul îngust activ păstrează o suprafață distinctă, consecventă cu headerul,
  numele și `aria-selected`; eliminarea shadow-ului de sus nu schimbă tastele,
  panourile montate sau relația tab/panel.

## Verificarea implementării

- 88 teste relevante trecute; typecheck și build trecute. Testul existent al
  stilului a fost adaptat la noua selecție și la textul secundar deja folosit.
- Browser izolat, toate cele 12 teme: fără linia/shadow-ul de sus, contrast
  minim al numerelor 4.86:1 și al titlurilor 5.55:1; un singur index activ.
- Selecția urmărește clickul pe alt panou și focusul în composer. Stripul la
  680px păstrează schimbarea cu săgeți, focusul DOM și conturul tastaturii.
  Panoul folosește cei 600px disponibili; la această lățime Sessions este
  foaia suprapusă existentă, nu o coloană care micșorează panoul. Forced colors
  păstrează Highlight/HighlightText pe index.
- Matricea cu 1/2/4 panouri, Rider Black/Light, Largest, meniuri și touch a
  trecut; zero erori JavaScript observate în aceste contexte.
- Cercetarea oferă repere pentru acest tratament de selecție, nu un certificat
  de paritate cu alte produse. Modelul AI real, telemetria externă și
  integrarea în v4 rămân în afara acestei verificări locale.

[tabs-doc]: https://ui.shadcn.com/docs/components/radix/tabs
[tabs-src]: https://github.com/shadcn-ui/ui/blob/968d8cb9dc42ae5d52e8fd356cf84596ec832a26/apps/v4/registry/new-york-v4/ui/tabs.tsx#L24
[sidebar-doc]: https://ui.shadcn.com/docs/components/radix/sidebar#sidebarmenubutton
[sidebar-src]: https://github.com/shadcn-ui/ui/blob/968d8cb9dc42ae5d52e8fd356cf84596ec832a26/apps/v4/registry/bases/radix/ui/sidebar.tsx#L499
[nova-sidebar]: https://github.com/shadcn-ui/ui/blob/968d8cb9dc42ae5d52e8fd356cf84596ec832a26/apps/v4/registry/styles/style-nova.css#L1166
[card-doc]: https://ui.shadcn.com/docs/components/radix/card
[card-src]: https://github.com/shadcn-ui/ui/blob/968d8cb9dc42ae5d52e8fd356cf84596ec832a26/apps/v4/registry/bases/radix/ui/card.tsx#L4
[nova-card]: https://github.com/shadcn-ui/ui/blob/968d8cb9dc42ae5d52e8fd356cf84596ec832a26/apps/v4/registry/styles/style-nova.css#L244
[radix]: https://www.radix-ui.com/primitives/docs/components/tabs
[radix-style]: https://www.radix-ui.com/primitives/docs/guides/styling
[apg]: https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#focus-vs-selection-and-the-perception-of-dual-focus
