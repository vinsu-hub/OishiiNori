import type { ReactNode } from "react";

/** Shared shell for /privacy and /terms -- matches NotFound.tsx's palette
 * (ivory paper, charcoal ink, vermilion accent) since neither page fits the
 * marketing-page component library the rest of Home.tsx uses. Plain,
 * legible prose over a styled layout, since the content here matters more
 * than the presentation. */
export default function LegalPageLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f3eddb",
        color: "#232321",
        fontFamily: '"DM Sans", sans-serif',
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 80px" }}>
        <style>{`
          .legal-back {
            display: inline-flex; align-items: center; gap: 8px;
            background: none; border: none; cursor: pointer;
            color: #6b6357; font-size: 13px; padding: 0; margin-bottom: 24px;
          }
          .legal-disclaimer {
            background: #fff8e8; border: 1px solid #e7d9ad; border-radius: 8px;
            padding: 14px 16px; font-size: 13px; line-height: 1.6; color: #6b6357;
          }
          .legal-body h2 { font-size: 18px; margin: 28px 0 8px; color: #232321; }
          .legal-body p, .legal-body li { font-size: 14px; line-height: 1.7; color: #3f3a33; }
          .legal-body ul { padding-left: 20px; }
          .legal-body a { color: #a51f26; }
        `}</style>
        <h1 style={{ fontFamily: '"Bebas Neue", sans-serif', fontSize: 44, color: "#a51f26", margin: "0 0 20px" }}>
          {title}
        </h1>
        <div className="legal-body">{children}</div>
      </div>
    </div>
  );
}
