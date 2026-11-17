import type { InputHTMLAttributes } from "react";

/** V4's checkbox: a 14px box and a tick that draws itself (styles/menus.css,
 *  `.cbx`). The input is the real control with every prop it was given; the
 *  tick is only its picture. */
export default function Checkbox(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <span className="cbx">
      <input type="checkbox" {...props} />
      <svg className="cbx-tick" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
        <path d="M3.5 7.5 6 10l4.5-5.5" pathLength="1" />
      </svg>
    </span>
  );
}
