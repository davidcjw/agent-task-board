// Vendored from dragonfly-ds — mono pill control built on Panel + Text.
import type { ElementType, ReactNode } from "react";
import { Panel } from "./Panel";
import { Text } from "./Text";

export interface ButtonProps {
  children: ReactNode;
  variant?: "outline" | "accent" | "ghost";
  href?: string;
  as?: ElementType;
  onClick?: () => void;
  className?: string;
  [key: string]: unknown;
}

export function Button({ children, variant = "outline", href, as, className = "", ...rest }: ButtonProps) {
  const Tag = as ?? (href ? "a" : "button");
  const accent = variant === "accent";
  return (
    <Panel
      as={Tag}
      href={href}
      border={variant === "ghost" ? "none" : "all"}
      interactive
      className={["df-button", `df-button--${variant}`, className].filter(Boolean).join(" ")}
      {...rest}
    >
      <Text face="mono" size="micro" caps tone={accent ? "inherit" : "ink"}>
        {children}
      </Text>
    </Panel>
  );
}
