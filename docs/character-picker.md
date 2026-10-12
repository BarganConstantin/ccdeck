# Selectable canvas companion

Settings → Music & character offers Deck companion, Fox and Penguin with previews.
The existing companion remains the default. Selection applies immediately and
persists in browser storage under `agent-dag.character`; missing, unsupported,
or inaccessible storage falls back to Deck companion. The visibility switch
retains the selected character when the companion is hidden.

## Reference and scope

The requested inspiration was [Pixelots on Reddit](https://www.reddit.com/r/ShowYourProduct/comments/1x2dk3v/app_pixelots_virtual_pet_on_screen/)
and the supplied orange pixel fox screenshots. The fox here is original artwork,
with an amber coat, cream muzzle and belly, pointed ears, and a tail. The fox
wears no hat; its headphones appear during music playback.
It uses fitted fox headphones and ccdeck's existing scene props. No Pixelots assets are
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

The fox has fitted headphones that keep both ears visible. Its tail is clipped
into a separate body group, including rectangle runs crossing the hip boundary;
it never belongs to the stepping legs and remains visible in seated poses.
The corrected artwork was inspected in dark and light browser galleries with
idle/headphones and idle, walk, seated and climbing poses. Three moving samples
confirm that the tail shares the body's transform and no leg extends into it.

## Penguin

Penguin adds an original rounded slate silhouette, cream face and belly,
amber beak and short webbed feet. It wears no hat and uses the existing
headphone exchange during music playback. Flippers share the existing wave and
grip animations; the raised pose leaves the eyes and beak visible. Its seated
feet remain inside the 18 × 14 grid instead of extending below the sprite.

The third choice uses the same stored preference and scene lifecycle. The
selector wraps when the settings pane cannot fit three choices. Browser checks
pass in dark/light themes at 1280, 900, 700, 500, 390 and 320 pixel widths,
including keyboard wraparound, Home/End, reload persistence, visibility retention
and the 54 × 42 canvas footprint. Motion galleries cover idle, walking, seated
and climbing poses, with and without headphones. Live audio playback was not
exercised by these isolated checks.
An additional 32-frame browser check tests the animated climbing paths against
the eye and beak centers, confirming that the raised flippers leave them visible.

## Pixel-art review

The penguin's face now has a feathered hood and white cheek patches. Its pupils
stay centered around the beak in both facings. The torso retains its feathered
sides under the lifting flippers, preventing detached corner pixels on hover.

Deck companion and Fox use raised grip paths that leave both eyes visible while
climbing and connect at the shoulder through the two-frame movement. The grip
tip still reaches the existing rope center. A small reach above the head uses
the scene's intentional SVG overflow.

Review sheets cover all three characters in dark/light themes and both facings,
with idle, walking, seated, climbing, landing, hover, dancing and fishing poses,
with/without headphones. Sitting lowers the sprite over the minimap ledge on
purpose; feet below the edge in that pose are expected.
