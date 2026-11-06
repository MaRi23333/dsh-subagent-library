/** Robot-head glyph for the library's settings row. */
export function LibraryNavIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 6.5V3.9" />
      <circle cx="8" cy="2.6" r="0.85" />
      <rect x="3.25" y="6.5" width="9.5" height="6.5" rx="1.5" />
      <path d="M5.75 9.25v1.25" />
      <path d="M10.25 9.25v1.25" />
      <path d="M1.75 9.25h1.5" />
      <path d="M12.75 9.25h1.5" />
    </svg>
  )
}
