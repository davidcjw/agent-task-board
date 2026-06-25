// Vendored from dragonfly-ds — typography primitive (three faces × scale steps).
import { forwardRef, type CSSProperties, type ElementType, type ReactNode } from "react";

export type TextFace = "serif" | "sans" | "mono";
export type TextSize = "mega" | "display" | "h" | "lead" | "body" | "micro";
export type TextTone = "ink" | "muted" | "accent" | "inherit";

export interface TextProps {
  children?: ReactNode;
  face?: TextFace;
  size?: TextSize;
  tone?: TextTone;
  caps?: boolean;
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  [key: string]: unknown;
}

export const Text = forwardRef<HTMLElement, TextProps>(function Text(
  { children, face = "sans", size = "body", tone = "ink", caps = false, as, className = "", style, ...rest },
  ref,
) {
  const Tag = (as ?? "span") as ElementType;
  const classes = [
    "df-text",
    `df-text--${face}`,
    `df-text--${size}`,
    `df-text--${tone}`,
    caps && "df-text--caps",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag ref={ref} className={classes} style={style} {...rest}>
      {children}
    </Tag>
  );
});
