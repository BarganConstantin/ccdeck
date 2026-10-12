# Selectable canvas companion

Settings → Music & character now offers Deck companion and Fox with previews.
The existing companion remains the default. Selection applies immediately and
persists in browser storage under `agent-dag.character`; missing, unsupported,
or inaccessible storage falls back to Deck companion. The visibility switch
retains the selected character when the companion is hidden.

## Reference and scope

The requested inspiration was [Pixelots on Reddit](https://www.reddit.com/r/ShowYourProduct/comments/1x2dk3v/app_pixelots_virtual_pet_on_screen/)
and the supplied orange pixel fox screenshots. The fox here is original artwork,
with an amber coat, cream muzzle and belly, pointed ears, tail, and a rust hat.
It uses ccdeck's existing headphones and scene props. No Pixelots assets are
bundled.

The companion stays inside ccdeck's existing canvas/minimap scene. This change
adds character selection rather than a desktop overlay or a pet-care system.
The existing player, scene lifecycle, movement, rope, ledge, fishing and dance
animations remain shared between both characters.

## Implementation

`character.ts` owns the supported IDs and storage fallback. `use-appearance.ts`
persists the selection, and `CharacterPicker` provides named radio choices with
arrow-key, Home and End navigation and a single keyboard tab stop.
`CharacterSprite` chooses the renderer without remounting the scene or player.
`FoxSprite` shares the existing pose classes and prop anchors, using the same
18 × 14 grid and 54 × 42 pixel canvas footprint. UI colors follow theme tokens;
the fox's coat palette belongs to the artwork.

## Verification

Type checking and the production build pass. Character selection, storage
fallback, pose rendering, appearance/settings and existing companion regression
tests pass. The unrelated CSS class audit still has two failures, reproduced on
the unchanged development baseline: orphan classes and runtime-prefix coverage.
These failures are not introduced by character selection.

Isolated Brave browser checks pass in dark and light themes at 1280, 390 and
320 pixel widths, without horizontal overflow or page errors. Checks cover
keyboard selection, reload persistence, hide/show retention and the unchanged
54 × 42 pixel footprint across eight one-second idle samples. Special poses
are covered by renderer tests; this browser run did not exercise live music
playback or every scene transition.

A separate browser check renders climbing, landing and seated poses under the
real stylesheet and confirms their computed limb colors remain amber, including
the darker far seated leg. Independent final review approved the change after
fixing the shared CSS overrides on these pose groups.
