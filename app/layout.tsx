import type { Metadata, Viewport } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "../components/ds/dragonfly.css";
import "./globals.css";

// dragonfly-ds three-face system, self-hosted via next/font.
const serif = Fraunces({
  variable: "--font-df-serif",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

const sans = Inter({
  variable: "--font-df-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
});

const mono = JetBrains_Mono({
  variable: "--font-df-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const SITE = "https://agent-task-board.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Agent Task Board — mission control for AI-agent work",
  description:
    "A local-first kanban for tasks you delegate to AI coding agents — queue prompts, track what's running, review and ship. Runs entirely in your browser.",
  alternates: { canonical: "/" },
  applicationName: "Agent Task Board",
  keywords: [
    "AI agents",
    "Claude Code",
    "kanban",
    "task board",
    "prompt manager",
    "developer productivity",
    "agent workflow",
  ],
  authors: [{ name: "David Chong" }],
  openGraph: {
    title: "Agent Task Board",
    description:
      "Mission control for the tasks you hand to AI coding agents. Prompt-first cards, live timers, local-first.",
    url: SITE,
    siteName: "Agent Task Board",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Task Board",
    description: "A local-first kanban for tasks you delegate to AI coding agents.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Agent Task Board",
  description:
    "A local-first kanban for tasks you delegate to AI coding agents — queue prompts, track what's running, review and ship.",
  url: SITE,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Any",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: { "@type": "Person", name: "David Chong" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
