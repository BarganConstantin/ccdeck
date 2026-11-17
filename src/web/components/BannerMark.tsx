// The 14px mark every banner starts with (V4's Figma, Banner): a kit icon in
// the tone's colour, where the strip used to draw a 7px dot with a glow. The
// tone is the colour alone (search-and-banners.css): Error --err, Waiting
// --warn, Done --ok, Info --muted.
import { KitIcon, KitStateGlyph, type KitIconName, type KitStateName } from "./kit-icons";

export type BannerTone = "err" | "warn" | "ok" | "info";

/** `done` and `error` are the kit's state glyphs; every other name is a kit icon. */
export type BannerGlyph = KitIconName | KitStateName;

const STATES: readonly string[] = ["done", "error", "idle", "waiting", "working"];

export default function BannerMark({ glyph, tone, armed = false }: {
  glyph: BannerGlyph;
  tone: BannerTone;
  /** A restart is counting down: the only moment the mark moves. */
  armed?: boolean;
}) {
  return (
    <span className={`banner-mark ${tone}${armed ? " armed" : ""}`} aria-hidden="true">
      {STATES.includes(glyph)
        ? <KitStateGlyph name={glyph as KitStateName} />
        : <KitIcon name={glyph as KitIconName} />}
    </span>
  );
}
