// Settings › Radar: the way into Radar, and what it does by itself.
//
// RADAR MONITORS BY ITSELF, ALWAYS. There is no switch any more (the owner,
// 2026-10-23, reversing v3.44.0's opt-in): the deck finds Claude Code's
// collector and watches its telemetry in the background, even while Radar is
// closed (traffic-radar-service.mjs). The section keeps the door to Radar, a
// row like General's doors, saying so.
//
// In the shared shape (SettingsParts.tsx, #2176): one untitled group.
import { SettingRow, SettingsGroup } from "./SettingsParts";

export const RADAR_NOTE = "Watches the telemetry Claude Code sends to its collector, always and in the background, even while Radar is closed. What it reads stays on this machine.";

export default function RadarSettings({ onOpen }: { onOpen: () => void }) {
  return (
    <SettingsGroup>
      <SettingRow
        as="div"
        settingId="radar-open"
        name="Radar"
        nameId="settings-radar-open-name"
        note={RADAR_NOTE}
        control={
          <button
            type="button"
            className="btn"
            id="settings-radar-open"
            aria-labelledby="settings-radar-open settings-radar-open-name"
            aria-haspopup="dialog"
            onClick={onOpen}
          >Open</button>
        }
      />
    </SettingsGroup>
  );
}
