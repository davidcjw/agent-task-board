// Vendored from dragonfly-ds — hairline divider (horizontal or vertical).
import type { CSSProperties } from "react";

export interface RuleProps {
  vertical?: boolean;
  strong?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Rule({ vertical = false, strong = false, className = "", style }: RuleProps) {
  const classes = [
    "df-rule",
    vertical ? "df-rule--v" : "df-rule--h",
    strong && "df-rule--strong",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <span role="separator" className={classes} style={style} />;
}
