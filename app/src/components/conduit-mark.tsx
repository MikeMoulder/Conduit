/**
 * Conduit's mark: a bold ring open at the bottom, its ends cut square, and a
 * dot on the same circle in the opening, the next step along the path. What
 * you say goes out through one channel.
 *
 * Drawn in currentColor, so it takes the text color of wherever it sits and
 * follows the theme with no second image and no invert filter. The browser
 * tab icon (src/app/icon.svg) and the rendered icons in assets/brand/ use the
 * same geometry; change them together.
 */
const MARK_PATH = "M44.05 49.2A21 21 0 1 0 19.95 49.2";
const MARK_DOT = { cx: 32, cy: 53, r: 5 } as const;

export function ConduitMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={MARK_PATH} fill="none" stroke="currentColor" strokeWidth={10} strokeLinecap="butt" />
      <circle {...MARK_DOT} fill="currentColor" />
    </svg>
  );
}
