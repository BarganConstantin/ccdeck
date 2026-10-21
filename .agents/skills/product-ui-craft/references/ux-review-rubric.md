# Evidence-based review

Review the dimensions relevant to the task, rather than filling every box for a tiny fix.

| Dimension | Observable question |
|---|---|
| Information architecture | Are related decisions together, with useful progressive detail? |
| Three-second comprehension | Can a first glance identify purpose, present state and next action? |
| Visual hierarchy | Does importance, rather than repeated decoration, control attention? |
| Typography | Are primary/secondary roles readable, with aligned numerals where needed? |
| Color and contrast | Are colors semantic, harmonious, and legible on actual surfaces? |
| Spacing/alignment | Do computed grids and rows support scanning without empty stretching? |
| Component consistency | Do shared actions look and behave consistently? |
| Interaction affordances | Do controls signal clickability, selection and resulting behavior accurately? |
| Accessibility | Can keyboard and assistive-technology users identify and operate controls? |
| Responsiveness | Are controls and content reachable in narrow and short windows? |
| Data states | Are loading, empty, failed, partial, stale and uncertain states honest? |
| Product identity | Does this fit the incumbent product without importing another brand? |
| Frontend quality | Are state ownership, dependencies, rendering and tests appropriate? |

Severity: **blocker** prevents a primary task, causes harmful misrepresentation or loses an essential control; **major** materially slows or excludes users; **minor** is a demonstrable local readability/interaction defect; **preference** is taste with no established user impact. Preference is not a shipping blocker.

Every finding needs observation, concrete evidence (DOM measurement, screenshot, source-supported behavior or test), impact, severity, proposed fix, expected improvement and verification method. Mark hypotheses as unverified. No screenshot proves a network contract, focus sequence, playback or screen-reader experience. No numeric design score proves shipping readiness.

Use the review asset to capture only findings worth acting on. For independent reviews, supply raw artifacts and preserve independence rather than feeding the desired conclusion. Delegate only where the environment and task authorize it.
