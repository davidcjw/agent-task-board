import { ImageResponse } from "next/og";

export const alt = "Agent Task Board — mission control for AI-agent work";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const LANES: Array<{ label: string; hex: string }> = [
  { label: "QUEUED", hex: "#8a8fa3" },
  { label: "RUNNING", hex: "#34d399" },
  { label: "REVIEW", hex: "#fbbf24" },
  { label: "DONE", hex: "#56a3d9" },
];

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#000000",
          backgroundImage:
            "radial-gradient(60% 50% at 50% 0%, rgba(250,76,20,0.18), transparent 70%), linear-gradient(to right, rgba(242,242,242,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(242,242,242,0.06) 1px, transparent 1px)",
          backgroundSize: "100% 100%, 60px 60px, 60px 60px",
          padding: "72px",
          color: "#f2f2f2",
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 999,
              background: "#fa4c14",
              boxShadow: "0 0 24px #fa4c14",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: 30, letterSpacing: "0.22em" }}>
            <span>AGENT</span>
            <span style={{ color: "#fa4c14" }}>{"//"}</span>
            <span>TASKBOARD</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ fontSize: 74, fontWeight: 600, lineHeight: 1.08, letterSpacing: "-0.02em" }}>
            Mission control for
          </div>
          <div style={{ fontSize: 74, fontWeight: 600, lineHeight: 1.08, letterSpacing: "-0.02em" }}>
            the work you hand to AI agents.
          </div>
          <div style={{ fontSize: 28, color: "#7d7d7d", marginTop: 18, maxWidth: 920 }}>
            A local-first kanban — queue prompts, track what&apos;s running, review and ship.
          </div>
        </div>

        <div style={{ display: "flex", gap: "16px" }}>
          {LANES.map((lane) => (
            <div
              key={lane.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                border: "1px solid rgba(242,242,242,0.18)",
                borderRadius: 6,
                padding: "12px 20px",
                fontSize: 22,
                letterSpacing: "0.14em",
              }}
            >
              <div style={{ width: 12, height: 12, borderRadius: 999, background: lane.hex }} />
              {lane.label}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
