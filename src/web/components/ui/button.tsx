// Adapted from shadcn/ui (MIT), new-york Button. See THIRD_PARTY_NOTICES.md.
// Native buttons and ccdeck's CSS tokens replace Tailwind recipes; no global reset.
import { forwardRef, type ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "outline" | "primary" | "ghost";
  size?: "default" | "icon";
}

const variants = { outline: "", primary: "ui-button-primary", ghost: "ui-button-ghost" } as const;
const sizes = { default: "", icon: "ui-button-icon" } as const;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = "", variant = "outline", size = "default", type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={["ui-button", variants[variant], sizes[size], className].filter(Boolean).join(" ")} {...props} />
  ),
);
Button.displayName = "Button";
