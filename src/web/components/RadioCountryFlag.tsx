/// <reference types="vite/client" />
import RadioIcon from "./RadioIcon";

// Separate local files keep flag artwork out of the initial JavaScript bundle.
const flags = import.meta.glob<string>("../assets/radio-flags/*.svg", {
  eager: true, query: "?url&no-inline", import: "default",
});

export default function RadioCountryFlag({ code }: { code?: string }) {
  const country = code?.trim().toLowerCase();
  const src = country && /^[a-z]{2}$/.test(country)
    ? flags[`../assets/radio-flags/${country}.svg`] : undefined;
  // Country names already appear beside the artwork and in the station label.
  return src
    ? <img className="radio-country-flag" src={src} alt="" aria-hidden="true" width="24" height="18" draggable={false} />
    : <RadioIcon name="radio" />;
}
