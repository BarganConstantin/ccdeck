import type { ReactNode } from "react";

// V4's kit icons, drawn as exported from V4's Figma: 14px at a 1.5 stroke, the
// five that sit on a 12 box at 1.25. Round caps and joins, currentColor, so the
// button decides the colour. An icon is never drawn at another size: scaling a
// 14 to 16 changes its stroke, so the box comes from the icon itself.

type KitEl =
  | { d: string; w?: number; o?: number }
  | { cx: number; cy: number; r: number; w?: number; o?: number; fill?: boolean };

type KitDef = { size: 12 | 14; visible?: boolean; els: KitEl[] };

export const KIT_ICONS = {
  account: { size: 14, els: [
    { d: "M7 2.2C5.67 2.2 4.6 3.27 4.6 4.6C4.6 5.93 5.67 7 7 7C8.33 7 9.4 5.93 9.4 4.6C9.4 3.27 8.33 2.2 7 2.2ZM7 2.2V2.2ZM2.6 12C3.2 9.8 4.9 8.6 7 8.6C9.1 8.6 10.8 9.8 11.4 12" }
  ] },
  activity: { size: 14, els: [
    { d: "M3 11.6V7.4M7 11.6V2.4M11 11.6V5" }
  ] },
  agents: { size: 14, els: [
    { d: "M3.4 2.2V11.8M3.4 5H7.8M3.4 10H7.8M8 3.6H12V6.4H8V3.6ZM8 8.6H12V11.4H8V8.6Z" }
  ] },
  arrange: { size: 14, els: [
    { d: "M3 2H5C5.55228 2 6 2.44772 6 3V5C6 5.55228 5.55228 6 5 6H3C2.44772 6 2 5.55228 2 5V3C2 2.44772 2.44772 2 3 2ZM9 2H11C11.5523 2 12 2.44772 12 3V5C12 5.55228 11.5523 6 11 6H9C8.44772 6 8 5.55228 8 5V3C8 2.44772 8.44772 2 9 2ZM3 8H5C5.55228 8 6 8.44772 6 9V11C6 11.5523 5.55228 12 5 12H3C2.44772 12 2 11.5523 2 11V9C2 8.44772 2.44772 8 3 8ZM9 8H11C11.5523 8 12 8.44772 12 9V11C12 11.5523 11.5523 12 11 12H9C8.44772 12 8 11.5523 8 11V9C8 8.44772 8.44772 8 9 8Z" }
  ] },
  board: { size: 14, els: [
    { d: "M3.4 2.2V11.8M3.4 5H7.8M3.4 10H7.8M8 3.6H12V6.4H8V3.6ZM8 8.6H12V11.4H8V8.6Z" }
  ] },
  "browser-watch": { size: 14, els: [
    { d: "M1.4 7C1.4 7 3.4 3.2 7 3.2C10.6 3.2 12.6 7 12.6 7C12.6 7 10.6 10.8 7 10.8C3.4 10.8 1.4 7 1.4 7ZM1.4 7V7ZM7 5.6C6.5 5.6 6.04 5.87 5.79 6.3C5.54 6.73 5.54 7.27 5.79 7.7C6.04 8.13 6.5 8.4 7 8.4C7.77 8.4 8.4 7.77 8.4 7C8.4 6.23 7.77 5.6 7 5.6ZM7 5.6V5.6Z" }
  ] },
  calendar: { size: 14, els: [
    { d: "M2 6H12M5 1.6V4.2M9 1.6V4.2M3.2 3H10.8C11.4627 3 12 3.53726 12 4.2V10.8C12 11.4627 11.4627 12 10.8 12H3.2C2.53726 12 2 11.4627 2 10.8V4.2C2 3.53726 2.53726 3 3.2 3Z" }
  ] },
  capacity: { size: 14, els: [
    { d: "M2.5 10.9C2.04231 10.1096 1.80088 9.21258 1.8 8.29923C1.79913 7.38587 2.03883 6.4884 2.495 5.69712C2.95118 4.90584 3.60772 4.24867 4.39856 3.79174C5.1894 3.33481 6.08664 3.09424 7 3.09424C7.91335 3.09424 8.8106 3.33481 9.60144 3.79174C10.3923 4.24867 11.0488 4.90584 11.505 5.69712C11.9612 6.4884 12.2009 7.38587 12.2 8.29923C12.1991 9.21258 11.9577 10.1096 11.5 10.9M7 8.3L9.1 6.2" }
  ] },
  changed: { size: 14, els: [
    { d: "M12.2511 6.99505C12.2511 9.49505 10.4811 11.655 8.0311 12.135C5.5711 12.635 3.1111 11.325 2.1511 9.01505C1.1911 6.69505 2.0011 4.01505 4.0811 2.63505C6.1611 1.24505 8.9411 1.51505 10.7111 3.28505" },
    { d: "M12.25 1.75V5.25H8.75" }
  ] },
  "chevron-down": { size: 12, els: [
    { d: "M3 4.5L6 7.5L9 4.5" }
  ] },
  "chevron-left": { size: 14, els: [
    { d: "M8.9 3.2L5.1 7L8.9 10.8" }
  ] },
  "chevron-right": { size: 14, els: [
    { d: "M5.25 3.5L8.75 7L5.25 10.5" }
  ] },
  clear: { size: 14, els: [
    { d: "M2.6 3.8H3.8M3.8 3.8H5.6M3.8 3.8L4.3 11.8H9.7L10.2 3.8M5.6 3.8H8.4M5.6 3.8V2.4H8.4V3.8M8.4 3.8H10.2M10.2 3.8H11.4" }
  ] },
  close: { size: 14, els: [
    { d: "M3.6 3.6L10.4 10.4M10.4 3.6L3.6 10.4" }
  ] },
  context: { size: 14, els: [
    { d: "M1.8 6.4H7.8M7.8 2.2V11.8M1.8 2.2H12.2V11.8H1.8V2.2Z" }
  ] },
  copy: { size: 14, els: [
    { d: "M2 9.4V2H9.4M5.8 4.6H10.8C11.4627 4.6 12 5.13726 12 5.8V10.8C12 11.4627 11.4627 12 10.8 12H5.8C5.13726 12 4.6 11.4627 4.6 10.8V5.8C4.6 5.13726 5.13726 4.6 5.8 4.6Z" }
  ] },
  edit: { size: 14, els: [
    { d: "M8.21 4.6V2.4M6.21 7.4H6.22M10.21 7.4H10.22M6.61 9.4H9.81M3.41 4.6H13.01V11.2H3.41V4.6Z" }
  ] },
  external: { size: 12, els: [
    { d: "M10 5V2H7M10 2L5.5 6.5M9 7.5V10H2V3H4.5" }
  ] },
  feedback: { size: 14, els: [
    { d: "M7 4.9V6.6M7 7.7V7.75M2.2 3.3H11.8V8.6H6.1L3.5 10.8V8.6H2.2V3.3Z" }
  ] },
  file: { size: 14, els: [
    { d: "M10.6 4.5L7.9 1.8H3.4V12.2H10.6V4.5ZM7.9 1.8V4.5H10.6" }
  ] },
  filter: { size: 14, els: [
    { d: "M2 3H12M4 7H10M6 11H8" }
  ] },
  folder: { size: 12, els: [
    { d: "M1.5 3.5C1.5 2.95 1.95 2.5 2.5 2.5H4.5L5.5 3.7H9.5C10.05 3.7 10.5 4.15 10.5 4.7V9C10.5 9.55 10.05 10 9.5 10H2.5C1.95 10 1.5 9.55 1.5 9V3.5Z" }
  ] },
  group: { size: 14, els: [
    { d: "M2 7L7 9.2L12 7M2 9.8L7 12L12 9.8M2 4.2L7 2L12 4.2L7 6.4L2 4.2Z" }
  ] },
  history: { size: 14, els: [
    { d: "M3 11.5V7M7 11.5V3M11 11.5V8.5" }
  ] },
  info: { size: 14, els: [
    { cx: 7, cy: 7, r: 5.5 },
    { d: "M7 6.3V9.7" },
    { cx: 7, cy: 4.4, r: 0.85, fill: true }
  ] },
  integrations: { size: 14, els: [
    { d: "M11.2378 2.75736L10.1771 3.81802M10.1771 3.81802L8.40934 2.05025L7.4901 2.96949C7.02126 3.43833 6.75787 4.07422 6.75787 4.73726C6.75787 5.4003 7.02126 6.03618 7.4901 6.50503C7.95894 6.97387 8.59483 7.23726 9.25787 7.23726C9.92091 7.23726 10.5568 6.97387 11.0256 6.50503L11.9449 5.58579L10.1771 3.81802ZM5.93447 5.93934L4.87381 7M4.87381 7L4.1667 6.29289L3.24746 7.21213C2.77862 7.68097 2.51523 8.31686 2.51523 8.9799C2.51523 9.64294 2.77862 10.2788 3.24746 10.7477M4.87381 7L6.99513 9.12132M8.05579 8.06066L6.99513 9.12132M6.99513 9.12132L7.70223 9.82843L6.78299 10.7477C6.31415 11.2165 5.67827 11.4799 5.01523 11.4799C4.35219 11.4799 3.7163 11.2165 3.24746 10.7477M3.24746 10.7477L2.04538 11.9497" }
  ] },
  keyboard: { size: 14, els: [
    { d: "M3.8 6H3.9M6 6H6.1M8.2 6H8.3M10.2 6H10.3M4.4 8.2H9.6M2.6 3.4H11.4C12.0627 3.4 12.6 3.93726 12.6 4.6V9.4C12.6 10.0627 12.0627 10.6 11.4 10.6H2.6C1.93726 10.6 1.4 10.0627 1.4 9.4V4.6C1.4 3.93726 1.93726 3.4 2.6 3.4Z" }
  ] },
  lock: { size: 12, els: [
    { d: "M3.7 10.25H8.3C8.96274 10.25 9.5 9.71274 9.5 9.05V6.45C9.5 5.78726 8.96274 5.25 8.3 5.25H3.7C3.03726 5.25 2.5 5.78726 2.5 6.45V9.05C2.5 9.71274 3.03726 10.25 3.7 10.25Z" },
    { d: "M4 5.25V3.8C4 2.7 4.9 1.8 6 1.8C7.1 1.8 8 2.7 8 3.8V5.25" }
  ] },
  machine: { size: 14, els: [
    { d: "M5.8 1.6V3.8M8.2 1.6V3.8M5.8 10.2V12.4M8.2 10.2V12.4M1.6 5.8H3.8M1.6 8.2H3.8M10.2 5.8H12.4M10.2 8.2H12.4M3.8 3.8H10.2V10.2H3.8V3.8Z" }
  ] },
  minus: { size: 14, els: [
    { d: "M3 7H11" }
  ] },
  more: { size: 14, els: [
    { d: "M3.5 7H3.51M7 7H7.01M10.5 7H10.51" }
  ] },
  pause: { size: 12, els: [
    { d: "M4 2.5V9.5M8 2.5V9.5" }
  ] },
  play: { size: 14, els: [
    { d: "M4.6 2.9V11.1L11.1 7L4.6 2.9Z" }
  ] },
  plus: { size: 14, els: [
    { d: "M7 2.6V11.4M2.6 7H11.4" }
  ] },
  radar: { size: 14, els: [
    { d: "M7 2C4.23858 2 2 4.23858 2 7C2 9.76142 4.23858 12 7 12C9.76142 12 12 9.76142 12 7C12 4.23858 9.76142 2 7 2ZM7 2V7L10.5 3.5" }
  ] },
  radio: { size: 14, els: [
    { d: "M4 5H2V12H12V5H4ZM4 5L10 2M4 8H7M9 8H10M4 10H5M8 10H10" }
  ] },
  recenter: { size: 14, els: [
    { d: "M7 1.2V3.5M7 10.5V12.8M1.2 7H3.5M10.5 7H12.8M9 7C9 8.10457 8.10457 9 7 9C5.89543 9 5 8.10457 5 7C5 5.89543 5.89543 5 7 5C8.10457 5 9 5.89543 9 7Z" }
  ] },
  restart: { size: 14, els: [
    { d: "M7 1.6V6.6M4.2 3.6C3.37484 4.19262 2.75899 5.03176 2.44108 5.99665C2.12317 6.96153 2.11959 8.00241 2.43087 8.96946C2.74215 9.93651 3.35223 10.7799 4.1733 11.3781C4.99437 11.9764 5.98409 12.2987 7 12.2987C8.01591 12.2987 9.00563 11.9764 9.8267 11.3781C10.6478 10.7799 11.2578 9.93651 11.5691 8.96946C11.8804 8.00241 11.8768 6.96153 11.5589 5.99665C11.241 5.03176 10.6252 4.19262 9.8 3.6" }
  ] },
  search: { size: 14, els: [
    { d: "M6.1 2.2C3.95 2.2 2.2 3.95 2.2 6.1C2.2 8.25 3.95 10 6.1 10C8.25 10 10 8.25 10 6.1C10 3.95 8.25 2.2 6.1 2.2ZM6.1 2.2V2.2ZM9 9L12.2 12.2" }
  ] },
  sessions: { size: 14, els: [
    { d: "M5 3.6H12M5 7H12M5 10.4H12M2.2 3.6H2.21M2.2 7H2.21M2.2 10.4H2.21" }
  ] },
  settings: { size: 14, els: [
    { d: "M7 4.9C5.84 4.9 4.9 5.84 4.9 7C4.9 8.16 5.84 9.1 7 9.1C8.16 9.1 9.1 8.16 9.1 7C9.1 5.84 8.16 4.9 7 4.9ZM7 4.9V4.9ZM7 1.6V3.1M7 10.9V12.4M1.6 7H3.1M10.9 7H12.4M3.2 3.2L4.2 4.2M9.8 9.8L10.8 10.8M3.2 10.8L4.2 9.8M9.8 4.2L10.8 3.2" }
  ] },
  skills: { size: 14, els: [
    { d: "M11.2 1.4V2.7M11.2 2.7V4M11.2 2.7H9.9M11.2 2.7H12.5M6 2.4C6.4 4.9 7.5 6 10 6.4C7.5 6.8 6.4 7.9 6 10.4C5.6 7.9 4.5 6.8 2 6.4C4.5 6 5.6 4.9 6 2.4Z" }
  ] },
  spend: { size: 14, els: [
    { d: "M7 1.6V12.4M9.6 4C9.2 3.1 8.2 2.6 7 2.6C5.4 2.6 4.4 3.4 4.4 4.5C4.4 7.3 9.8 6 9.8 8.9C9.8 10.1 8.7 10.9 7 10.9C5.7 10.9 4.6 10.3 4.2 9.3" }
  ] },
  split: { size: 14, els: [
    { d: "M7 2.6V11.4M1.8 2.6H12.2V11.4H1.8V2.6Z" }
  ] },
  terminal: { size: 14, els: [
    { d: "M2.4 3.8L5.6 7L2.4 10.2M7.4 10.6H11.6" }
  ] },
  theme: { size: 14, els: [
    { d: "M7 1.8C4.13 1.8 1.8 4.13 1.8 7C1.8 9.87 4.13 12.2 7 12.2M7 1.8C9.87 1.8 12.2 4.13 12.2 7C12.2 9.87 9.87 12.2 7 12.2M7 1.8V1.8ZM7 1.8V12.2M7 4.4H10.8M7 7H12M7 9.6H10.8" }
  ] },
  thinking: { size: 14, els: [
    { d: "M7 1.8L8.3 5.7L12.2 7L8.3 8.3L7 12.2L5.7 8.3L1.8 7L5.7 5.7L7 1.8Z" }
  ] },
  time: { size: 14, els: [
    { d: "M7 1.8C4.13 1.8 1.8 4.13 1.8 7C1.8 9.87 4.13 12.2 7 12.2C9.87 12.2 12.2 9.87 12.2 7C12.2 4.13 9.87 1.8 7 1.8ZM7 1.8V1.8ZM7 4.2V7L9 8.4" }
  ] },
  tools: { size: 14, els: [
    { d: "M4 5.4V3H10V5.4M1.6 8.4H5.8M5.8 8.4V9.2H8.2V8.4M5.8 8.4V7.6H8.2V8.4M8.2 8.4H12.4M2.8 5.4H11.2C11.8627 5.4 12.4 5.93726 12.4 6.6V10.6C12.4 11.2627 11.8627 11.8 11.2 11.8H2.8C2.13726 11.8 1.6 11.2627 1.6 10.6V6.6C1.6 5.93726 2.13726 5.4 2.8 5.4Z" }
  ] },
  unreachable: { size: 14, visible: true, els: [
    { d: "M2.61 11.81L12.23 2.19" },
    { d: "M4.9675 9.45L3.9175 10.5C3.1975 11.22 2.0175 11.22 1.2975 10.5C0.5675 9.78 0.5675 8.6 1.2975 7.88L2.6875 6.48M9.8675 4.55L10.9175 3.5C11.6375 2.78 12.8175 2.78 13.5475 3.5C14.2675 4.22 14.2675 5.4 13.5475 6.13L12.1475 7.52M5.6675 5.69L8.7275 8.75" }
  ] },
  update: { size: 14, els: [
    { d: "M11.6007 6.2C11.3855 5.10012 10.7922 4.11021 9.92371 3.40188C9.0552 2.69355 7.96621 2.31146 6.84552 2.32185C5.72484 2.33224 4.64311 2.73445 3.78788 3.45875C2.93264 4.18306 2.35782 5.18379 2.16305 6.28747C1.96828 7.39115 2.16585 8.5282 2.72151 9.50148C3.27717 10.4748 4.15589 11.2229 5.20533 11.6163C6.25476 12.0096 7.40876 12.0234 8.46726 11.6551C9.52576 11.2868 10.422 10.5598 11.0007 9.6M11.9007 2.6V6.3H8.3007" }
  ] },
  usage: { size: 14, els: [
    { d: "M2.2 9.4C2.2 6.75 4.35 4.6 7 4.6C9.65 4.6 11.8 6.75 11.8 9.4M7 9.4L9.4 6.4" }
  ] },
  warning: { size: 14, els: [
    { d: "M7 6V8.6M7 10.1V10.15M7 2L12.6 11.6H1.4L7 2Z" }
  ] },
  workspace: { size: 14, els: [
    { d: "M4 5.4L6 7L4 8.6M7.4 8.6H9.8M1.8 2.6H12.2V11.4H1.8V2.6Z" }
  ] },
  zoom: { size: 14, els: [
    { d: "M11.8 5.6V2.2H8.4M11.8 2.2L8 6M2.2 8.4V11.8H5.6M2.2 11.8L6 8" }
  ] },
} as const satisfies Record<string, KitDef>;

/** The state glyphs: the same drawing language, in the colour of the state they
 *  sit in (StateMark sets it through the existing tokens). */
export const KIT_STATE_GLYPHS = {
  done: { size: 14, els: [
    { d: "M3 7.4L5.6 10L11 4.4", w: 1.6 }
  ] },
  error: { size: 14, els: [
    { cx: 7, cy: 7, r: 5.5 },
    { d: "M9 5L5 9M5 5L9 9" }
  ] },
  idle: { size: 14, els: [
    { cx: 7, cy: 7, r: 4.5 }
  ] },
  waiting: { size: 14, els: [
    { cx: 7, cy: 7, r: 6, o: 0.35 },
    { d: "M7 3.75V7.5" },
    { d: "M7 10.25V10.26", w: 1.75 }
  ] },
  working: { size: 14, els: [
    { cx: 7, cy: 7, r: 5.5, o: 0.3 },
    { d: "M7 1.5C10.04 1.5 12.5 3.96 12.5 7" }
  ] },
} as const satisfies Record<string, KitDef>;

export type KitIconName = keyof typeof KIT_ICONS;
export type KitStateName = keyof typeof KIT_STATE_GLYPHS;

function kitEls(els: readonly KitEl[]): ReactNode {
  return els.map((e, i) => {
    const w = "w" in e ? e.w : undefined;
    const o = "o" in e ? e.o : undefined;
    if ("d" in e) return <path key={i} d={e.d} strokeWidth={w} strokeOpacity={o} />;
    return e.fill
      ? <circle key={i} cx={e.cx} cy={e.cy} r={e.r} fill="currentColor" stroke="none" />
      : <circle key={i} cx={e.cx} cy={e.cy} r={e.r} strokeWidth={w} strokeOpacity={o} />;
  });
}

function KitSvg({ def, className, size, kind }: { def: KitDef; className?: string; size?: number; kind?: string }) {
  const box = size ?? def.size;
  return (
    <svg className={className} data-kind={kind} width={box} height={box} viewBox={`0 0 ${def.size} ${def.size}`}
      fill="none" stroke="currentColor" strokeWidth={def.size === 12 ? 1.25 : 1.5} strokeLinecap="round" strokeLinejoin="round"
      overflow={def.visible ? "visible" : undefined} aria-hidden="true" focusable="false">
      {kitEls(def.els)}
    </svg>
  );
}

export function KitIcon({ name, className }: { name: KitIconName; className?: string }) {
  return <KitSvg def={KIT_ICONS[name] as KitDef} className={className} />;
}

/** A state glyph on the kit's 14 grid. `size` is for the faces that have always
 *  asked for their own box; the strokes scale with it. */
export function KitStateGlyph({ name, className, size, kind }: { name: KitStateName; className?: string; size?: number; kind?: string }) {
  return <KitSvg def={KIT_STATE_GLYPHS[name] as KitDef} className={className} size={size} kind={kind} />;
}
