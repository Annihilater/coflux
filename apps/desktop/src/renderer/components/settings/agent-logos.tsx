import type { ComponentType } from "react";

import type { AgentId } from "@/components/settings/agent-settings";
import { cn } from "@/lib/utils";

/**
 * Inline brand marks for the agent catalog (plan 20261001-desktop-agents): simplified, drawn on a
 * 24×24 grid, no remote images. The monochrome marks paint with `currentColor`, so they follow the
 * surrounding text colour in both themes and take the tab glyphs' state tints; Claude's mark keeps
 * its terracotta, which reads on light and dark backgrounds alike. Size comes from the caller's
 * `size-*` class.
 */
type LogoProps = { className?: string };

/** Claude: a tapered starburst. Rays are generated once, at module load. */
const CLAUDE_RAYS: string = (() => {
  const count = 12;
  // Slightly uneven ray lengths, as in the mark.
  const lengths = [10.6, 9.4, 10.2, 9.1, 10.8, 9.6, 10.3, 9.2, 10.7, 9.5, 10.1, 9.3];
  const parts: string[] = [];
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const length = lengths[index]!;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Perpendicular unit vector.
    const px = -sin;
    const py = cos;
    const base = 1.2;
    const baseHalf = 1.15;
    const tipHalf = 0.5;
    const point = (radius: number, offset: number) =>
      `${(12 + cos * radius + px * offset).toFixed(2)} ${(12 + sin * radius + py * offset).toFixed(2)}`;
    parts.push(`M${point(base, baseHalf)} L${point(length, tipHalf)} L${point(length, -tipHalf)} L${point(base, -baseHalf)} Z`);
  }
  return parts.join(" ");
})();

export function ClaudeLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("shrink-0", className)}>
      <path d={CLAUDE_RAYS} fill="#D97757" />
      <circle cx="12" cy="12" r="2.4" fill="#D97757" />
    </svg>
  );
}

/** Codex (OpenAI): six interlocking capsules around the centre. */
export function CodexLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("shrink-0", className)}>
      <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round">
        {[0, 60, 120, 180, 240, 300].map((angle) => (
          <rect key={angle} x="8.6" y="2.4" width="6.8" height="11.6" rx="3.4" transform={`rotate(${angle} 12 12)`} />
        ))}
      </g>
    </svg>
  );
}

/** Cursor: an isometric cube, its three faces in three tones of the same colour. */
export function CursorLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("shrink-0", className)}>
      <path d="M3.3 7 12 12v10l-8.7-5z" fill="currentColor" fillOpacity="0.45" />
      <path d="M12 12 20.7 7v10L12 22z" fill="currentColor" fillOpacity="0.75" />
      <path d="M3.3 7 12 2l8.7 5L12 12z" fill="currentColor" />
    </svg>
  );
}

/** Grok: an open ring cut by a diagonal stroke. */
export function GrokLogo({ className }: LogoProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("shrink-0", className)}>
      <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="M17.6 6.6A8 8 0 1 0 19.6 14.6" />
        <path d="M4 20 20.5 3.5" />
      </g>
    </svg>
  );
}

/** One logo per catalog entry; a Record so a new agent without a logo fails typecheck. */
export const AGENT_LOGOS: Readonly<Record<AgentId, ComponentType<LogoProps>>> = {
  claude: ClaudeLogo,
  codex: CodexLogo,
  cursor: CursorLogo,
  grok: GrokLogo,
};

export function AgentLogo({ agent, className }: { agent: AgentId; className?: string }) {
  const Logo = AGENT_LOGOS[agent];
  return <Logo className={className} />;
}
