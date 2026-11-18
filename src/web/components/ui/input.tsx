// Adapted from shadcn/ui (MIT), new-york Input. See THIRD_PARTY_NOTICES.md.
import { forwardRef, type ComponentPropsWithoutRef } from "react";

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<"input">>(
  ({ className = "", type = "text", ...props }, ref) => (
    <input ref={ref} type={type} className={`ui-input ${className}`} {...props} />
  ),
);
Input.displayName = "Input";
