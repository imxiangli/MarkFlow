// Same artwork as build/icon.svg (the app icon), cropped to the plate.
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="100 100 824 824" aria-hidden="true">
      <defs>
        <linearGradient id="mf-logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e2c58" />
          <stop offset="1" stopColor="#0b1330" />
        </linearGradient>
        <radialGradient id="mf-logo-glow" cx="0.28" cy="0.18" r="0.85">
          <stop offset="0" stopColor="#4466e0" stopOpacity="0.5" />
          <stop offset="1" stopColor="#4466e0" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="mf-logo-ink" x1="216" y1="250" x2="806" y2="800" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffcf4d" />
          <stop offset="0.48" stopColor="#ff6b5a" />
          <stop offset="1" stopColor="#e2409f" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#mf-logo-bg)" />
      <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#mf-logo-glow)" />
      <path
        fill="url(#mf-logo-ink)"
        d="M221 767L221 361L343 275L343 681ZM343 275L539 547L417 633L221 361ZM417 633L613 361L735 275L539 547ZM735 275L735 577L613 663L613 361ZM735 577C735 727 817 727 907 664L785 750C695 813 613 813 613 663Z"
      />
    </svg>
  )
}
