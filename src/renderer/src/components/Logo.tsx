export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="mf-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f7cff" />
          <stop offset="1" stopColor="#7a5cff" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#mf-logo-g)" />
      <path
        d="M14 44V20h5.5l7.5 10 7.5-10H40v24h-5.5V29.5L27 39.5l-7.5-10V44z"
        fill="#fff"
      />
      <path d="M44 34h4.5v-14h5v14H58l-7 9z" fill="#fff" opacity="0.92" />
    </svg>
  )
}
