import type { HTMLAttributes, ReactElement } from "react";
import HoverHint from "./HoverHint";

/** Account hints keep their existing surface and immediate focus disclosure. */
export default function AccountHint({ children, detail, disabled = false }: {
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  detail: string;
  disabled?: boolean;
}) {
  return <HoverHint className="ap-peek ap-account-hint" detail={detail} disabled={disabled}>
    {children}
  </HoverHint>;
}
