/** Host theme tokens keep the roster at home in both desktop color schemes. */
const TOKEN = {
  primary: 'var(--dsw-alias-label-primary, currentColor)',
  secondary: 'var(--dsw-alias-label-secondary, #737780)',
  muted: 'var(--dsw-alias-label-tertiary, #858993)',
  border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.2))',
  borderStrong: 'var(--dsw-alias-border-l3, rgba(128,128,128,0.32))',
  divider: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.12))',
  surface: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.035))',
  inset: 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.07))',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08))',
  accent: 'var(--dsw-alias-state-business-primary, #4176e6)',
  accentFill: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6)',
  accentSoft: 'var(--dsw-alias-state-business-tertiary, rgba(65,118,230,0.12))',
  success: 'var(--dsw-alias-state-success-primary, #16a34a)',
  successSoft: 'var(--dsw-alias-state-success-tertiary, rgba(22,163,74,0.12))',
  warn: 'var(--dsw-alias-state-warn-label, #b45309)',
  warnSoft: 'var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,0.12))',
  danger: 'var(--dsw-alias-state-error-primary, #dc2626)',
  dangerSoft: 'var(--dsw-alias-state-error-secondary, rgba(220,38,38,0.12))',
} as const

const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace'

const button: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  minHeight: 32, padding: '5px 12px', fontSize: 12.5, lineHeight: 1.5,
  fontFamily: 'inherit', fontWeight: 500, borderRadius: 8,
  border: `1px solid ${TOKEN.borderStrong}`, background: 'transparent',
  color: TOKEN.secondary, cursor: 'pointer', whiteSpace: 'nowrap',
}

const chip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'baseline', gap: 4,
  maxWidth: '100%', padding: '2px 7px', borderRadius: 5,
  fontSize: 11.5, lineHeight: 1.5, color: TOKEN.secondary,
  background: TOKEN.inset, overflowWrap: 'anywhere',
}

export const S = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 16,
    width: '100%', minWidth: 0, maxWidth: 880,
    boxSizing: 'border-box', padding: '16px 4px', color: TOKEN.primary,
    containerType: 'inline-size', containerName: 'dsh-library',
  },
  headingRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 20, lineHeight: 1.4, fontWeight: 650, letterSpacing: '-0.025em', margin: 0 },
  banner: {
    fontSize: 12.5, lineHeight: 1.65, padding: '10px 12px', borderRadius: 8,
    display: 'flex', flexDirection: 'column', gap: 6, overflowWrap: 'anywhere',
  },

  bar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  search: {
    display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 220px',
    minWidth: 0, minHeight: 34, padding: '6px 10px',
    border: `1px solid ${TOKEN.borderStrong}`, borderRadius: 8,
  },
  searchInput: {
    flex: 1, minWidth: 0, border: 'none', outline: 'none', padding: 0,
    background: 'transparent', color: 'inherit', fontSize: 13, fontFamily: 'inherit',
  },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  row: {
    minWidth: 0, border: `1px solid ${TOKEN.border}`, borderRadius: 12,
    background: TOKEN.surface, overflow: 'hidden',
    transition: 'border-color 140ms ease, box-shadow 140ms ease',
  },
  rowOpen: { borderColor: TOKEN.accent, boxShadow: `0 0 0 1px ${TOKEN.accentSoft}` },
  rowOff: { background: 'transparent' },
  head: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px 0 12px' },
  disclosure: {
    display: 'flex', alignItems: 'flex-start', flex: 1, minWidth: 0, gap: 6,
    minHeight: 28, padding: '2px 0', textAlign: 'left', font: 'inherit',
    border: 0, borderRadius: 4, color: TOKEN.primary, background: 'transparent', cursor: 'pointer',
  },
  titleRow: { display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', gap: '5px 8px', flexWrap: 'wrap' },
  chevron: {
    flex: 'none', width: 18, height: 22, display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', color: TOKEN.muted, transition: 'transform 140ms ease',
  },
  id: { fontSize: 14, lineHeight: 1.6, fontWeight: 650, fontFamily: MONO, overflowWrap: 'anywhere', minWidth: 0 },
  headToggle: {
    display: 'flex', alignItems: 'center', flex: 'none', gap: 7,
    minHeight: 28, fontSize: 11.5, color: TOKEN.muted, cursor: 'pointer',
  },
  overview: { display: 'flex', flexDirection: 'column', gap: 9, padding: '2px 16px 13px 36px', minWidth: 0 },
  excerpt: {
    display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden',
    margin: 0, fontSize: 13, lineHeight: 1.65, color: TOKEN.secondary, overflowWrap: 'anywhere',
  },
  route: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 8px', minWidth: 0 },
  metaLabel: { fontSize: 11.5, color: TOKEN.muted, flexShrink: 0 },
  model: { fontFamily: MONO, fontSize: 12.5, fontWeight: 500, color: TOKEN.primary, overflowWrap: 'anywhere', minWidth: 0, maxWidth: '100%' },
  provider: { fontFamily: MONO, fontSize: 11.5, color: TOKEN.muted, paddingLeft: 8, borderLeft: `1px solid ${TOKEN.borderStrong}`, overflowWrap: 'anywhere', minWidth: 0, maxWidth: '100%' },
  glyph: chip,
  dirtyChip: { ...chip, fontSize: 10.5, color: TOKEN.warn, background: TOKEN.warnSoft },
  body: { display: 'flex', flexDirection: 'column', gap: 13, padding: '12px 14px', borderTop: `1px solid ${TOKEN.divider}` },
  fieldLabel: { fontSize: 12, color: TOKEN.secondary, marginBottom: 6, display: 'block' },
  field: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, alignItems: 'start' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 12, borderTop: `1px solid ${TOKEN.divider}` },
  spacer: { flex: 1 },

  input: {
    width: '100%', minHeight: 35, boxSizing: 'border-box', fontSize: 13, fontFamily: MONO,
    lineHeight: 1.5, padding: '6px 9px', border: `1px solid ${TOKEN.borderStrong}`,
    borderRadius: 7, background: 'transparent', color: 'inherit',
  },
  prose: {
    width: '100%', minHeight: 64, boxSizing: 'border-box', fontSize: 13, fontFamily: 'inherit',
    lineHeight: 1.7, padding: '8px 10px', border: `1px solid ${TOKEN.borderStrong}`,
    borderRadius: 7, background: 'transparent', color: 'inherit', resize: 'vertical',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  button,
  primary: { ...button, padding: '5px 13px', borderColor: 'transparent', background: TOKEN.accentFill, color: '#fff' },
  danger: { ...button, borderColor: TOKEN.dangerSoft, color: TOKEN.danger },
  ghost: { ...button, borderColor: 'transparent', color: TOKEN.muted },
  hint: { fontSize: 11.5, lineHeight: 1.65, color: TOKEN.muted, margin: 0, overflowWrap: 'anywhere' },
  empty: { padding: '28px 16px', textAlign: 'center', fontSize: 13, lineHeight: 1.7, color: TOKEN.muted, border: `1px dashed ${TOKEN.border}`, borderRadius: 10 },
  footer: { padding: '4px 0', color: TOKEN.muted, overflowWrap: 'anywhere' },
  footerSummary: { cursor: 'pointer', fontSize: 11.5, paddingBottom: 8 },
} satisfies Record<string, React.CSSProperties>

export const BANNER = {
  ok: { ...S.banner, background: TOKEN.successSoft, color: TOKEN.success },
  error: { ...S.banner, background: TOKEN.dangerSoft },
  warn: { ...S.banner, background: TOKEN.warnSoft },
  info: { ...S.banner, background: TOKEN.inset },
} as const

/** Scoped styles travel with the client bundle; no extra host CSS loader. */
export const SETTINGS_CSS = `
.dsh-library *, .dsh-library *::before { box-sizing: border-box; }
.dsh-library button:disabled { cursor: default !important; opacity: .5; }
.dsh-library :is(button, input, textarea, select, summary):focus-visible {
  outline: 2px solid ${TOKEN.accent}; outline-offset: 3px;
}
.dsh-library .library-search:focus-within {
  outline: 2px solid ${TOKEN.accent}; outline-offset: 2px;
}
.dsh-library .library-search input:focus-visible { outline: none; }
.dsh-library .library-panel { display: grid; gap: 14px; min-width: 0; }
.dsh-library .library-tabs { display: flex; gap: 18px; border-bottom: 1px solid ${TOKEN.border}; }
.dsh-library .library-tabs button {
  padding: 6px 3px 8px; border: 0; border-bottom: 2px solid transparent;
  background: transparent; color: ${TOKEN.secondary}; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
.dsh-library .library-tabs button[aria-selected=true] { color: ${TOKEN.accent}; border-color: currentColor; }
.dsh-library .library-editor { min-width: 0; border: 0; margin: 0; }
.dsh-library h3 { margin: 0; font-size: 13px; font-weight: 650; }
.dsh-library .library-editor textarea { min-height: 51px !important; }
.dsh-library .library-editor [data-field=assignment] { min-height: 35px !important; }
.dsh-library .library-editor input:read-only { background: ${TOKEN.inset} !important; }
.dsh-library .library-members-head {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 5px 10px; padding-top: 8px; border-top: 1px solid ${TOKEN.border};
}
.dsh-library .library-members { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.dsh-library .library-members li {
  display: grid; gap: 7px; min-width: 0; padding: 8px 10px 10px;
  border: 1px solid ${TOKEN.border}; border-radius: 8px; background: var(--dsw-alias-bg-base, transparent);
}
.dsh-library .library-member-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; font-size: 12px; }
.dsh-library .library-member-head button { min-height: 27px !important; padding: 2px 6px !important; }
.dsh-library .library-link {
  border: 0 !important; padding: 0 !important; min-height: 0 !important; display: inline !important;
  color: ${TOKEN.accent} !important; white-space: normal !important; text-align: left; text-decoration: underline; overflow-wrap: anywhere;
}
.dsh-library .library-field-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 8px; padding-top: 2px; }
.dsh-library .library-field-actions > button { min-height: 24px !important; }
.dsh-library .library-field-note { padding-top: 4px; }
.dsh-library .library-field-error { color: ${TOKEN.danger}; font-size: 11.5px; line-height: 1.65; overflow-wrap: anywhere; }
.dsh-library .library-field-error:not(:empty) { margin-top: 4px; }
.dsh-library [data-field=slot][aria-invalid=true] { border-color: ${TOKEN.danger} !important; }
.dsh-library [data-field=role-id] { user-select: text; }
.dsh-library .library-refs ul { padding-inline-start: 19px; margin: 4px 0; }
.dsh-library .library-dialog {
  width: min(540px, calc(100% - 32px)); max-height: calc(100% - 32px); padding: 17px;
  border: 1px solid ${TOKEN.borderStrong}; border-radius: 12px; background: var(--dsw-alias-bg-base, Canvas);
  color: var(--dsw-alias-label-primary, CanvasText); box-shadow: 0 8px 30px #13182633; font: inherit; font-size: 13px;
}
.dsh-library .library-dialog::backdrop { background: #10152260; }
.dsh-library .library-compare { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin-top: 10px; }
.dsh-library .library-compare article { background: ${TOKEN.inset}; padding: 8px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-library .library-compare dl { margin: 5px 0 0; }
.dsh-library .library-compare dt, .dsh-library .library-compare dd { display: inline; margin: 0; }
.dsh-library .library-compare dt { font-weight: 600; margin-inline-end: 5px; }
.dsh-library select option { background: ${TOKEN.surface}; color: ${TOKEN.primary}; }
.dsh-library-switch {
  appearance: none; position: relative; display: inline-block; flex: none;
  width: 30px; height: 18px; margin: 0; border: 1px solid ${TOKEN.borderStrong};
  border-radius: 999px; background: ${TOKEN.hover}; cursor: pointer;
  transition: background 140ms ease;
}
.dsh-library-switch::before {
  content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
  border-radius: 50%; background: ${TOKEN.muted}; transition: transform 140ms ease;
}
.dsh-library-switch:checked { background: ${TOKEN.accentFill}; border-color: transparent; }
.dsh-library-switch:checked::before { transform: translateX(12px); background: #fff; }
@container dsh-library (max-width: 285px) {
  .dsh-library .library-grid, .dsh-library .library-compare { grid-template-columns: minmax(0, 1fr) !important; }
}
@media (hover: hover) {
  .dsh-library-card:hover { border-color: ${TOKEN.borderStrong}; }
  .dsh-library-disclosure:hover { color: ${TOKEN.accent} !important; }
  .dsh-library button:not(:disabled):hover { filter: brightness(.96); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-library *, .dsh-library *::before { transition: none !important; }
}
@media (forced-colors: active) {
  .dsh-library-switch { appearance: auto; }
  .dsh-library-switch::before { display: none; }
}
`
