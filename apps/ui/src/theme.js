// The MUI / react-admin themes, built from the design system's tokens (src/design/tokens.json — a mirror of the
// "CMS Plugin Design System" artifact; change values there first, then copy the file). Dark is the default,
// light has the same roles. Every colour, size and radius below comes from the tokens; nothing is a literal.
// The tokens are also published as CSS custom properties (--bg-default, --font-mono …) for sx and plain CSS.
import { deepmerge } from '@mui/utils';
import { defaultDarkTheme, defaultLightTheme } from 'react-admin';
import tokens from './design/tokens.json';

const listOf = (family) => Object.fromEntries((tokens[family]?.tokens ?? []).map((t) => [t.name, t.value]));
const SPACE = listOf('spacing');
const RADIUS = listOf('radius');
const SIZE = listOf('size');
const FONT = tokens.type.families;
const STYLE = Object.fromEntries(tokens.type.groups.flatMap((g) => g.styles.map((s) => [s.name, { ...s, family: FONT[g.family] }])));
const px = (v) => parseFloat(v);

/** Colour tokens of one theme, aliases ("{brand}") resolved. */
function colorsOf(theme) {
  const raw = Object.fromEntries(tokens.color.tokens.map((t) => [t.name, typeof t.value === 'string' ? t.value : (t.value[theme] ?? t.value.dark)]));
  const resolve = (v, depth = 0) => (typeof v === 'string' && v.startsWith('{') && depth < 16 ? resolve(raw[v.slice(1, -1)], depth + 1) : v);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]));
}
const shadowOf = (theme) => { const v = listOf('shadow')['shadow-overlay']; return typeof v === 'string' ? v : v[theme]; };
const text = (name) => ({ fontFamily: STYLE[name].family, fontSize: STYLE[name].fontSize, lineHeight: STYLE[name].lineHeight,
  fontWeight: STYLE[name].fontWeight, ...(STYLE[name].letterSpacing ? { letterSpacing: STYLE[name].letterSpacing } : {}) });

function build(mode) {
  const c = colorsOf(mode);
  const overlay = shadowOf(mode);
  const cssVars = {
    ...Object.fromEntries(Object.entries(c).map(([k, v]) => [`--${k}`, v])),
    '--shadow-overlay': overlay, '--font-sans': FONT.sans, '--font-mono': FONT.mono,
  };

  return deepmerge(mode === 'dark' ? defaultDarkTheme : defaultLightTheme, {
    palette: {
      mode,
      primary: { main: c.brand, contrastText: c['on-brand-fill'] },
      // react-admin paints its app bar in "secondary": the surface, not a colour block
      secondary: { main: c['bg-surface-100'], contrastText: c['fg-default'] },
      error: { main: c.danger, contrastText: c['on-danger-fill'] },
      warning: { main: c.warning },
      info: { main: c.info },
      success: { main: c.brand },
      background: { default: c['bg-default'], paper: c['bg-surface-100'] },
      text: { primary: c['fg-default'], secondary: c['fg-light'], disabled: c['fg-muted'] },
      divider: c['border-default'],
      action: { hover: c['bg-surface-200'], selected: c['bg-surface-300'], focus: c['bg-surface-300'] },
    },
    shape: { borderRadius: px(RADIUS['radius-md']) },
    shadows: ['none', ...Array.from({ length: 5 }, () => 'none'), ...Array.from({ length: 19 }, () => overlay)],
    sidebar: { width: px(SIZE['sidebar-width']), closedWidth: 52 },
    typography: {
      fontFamily: FONT.sans,
      fontSize: 14,
      h1: text('title-lg'), h2: text('title-lg'), h3: text('title-lg'), h4: text('title-lg'), h5: text('title'), h6: text('title'),
      subtitle1: text('heading'), subtitle2: text('label'),
      body1: text('body'), body2: text('body-sm'), caption: text('caption'), overline: { ...text('label'), letterSpacing: '0.04em' },
      button: { ...text('body'), fontWeight: 500, textTransform: 'none' },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': cssVars,
          body: { backgroundColor: c['bg-default'], fontVariantNumeric: 'tabular-nums' },
          ':focus-visible': { outline: `2px solid ${c['focus-ring']}`, outlineOffset: '2px' },
          'code, kbd, samp': { fontFamily: FONT.mono },
          '@media (prefers-reduced-motion: reduce)': { '*': { transition: 'none !important', animation: 'none !important' } },
        },
      },
      // ── actions ──────────────────────────────────────────────────────────────
      MuiButtonBase: { defaultProps: { disableRipple: true } },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { minHeight: SIZE['control-md'], padding: `0 ${SPACE['space-3']}`, borderRadius: RADIUS['radius-md'], fontWeight: 500,
            transition: 'background-color 120ms ease-out, border-color 120ms ease-out' },
          sizeSmall: { minHeight: SIZE['control-sm'], padding: `0 ${SPACE['space-2']}`, fontSize: STYLE['body-sm'].fontSize },
          containedPrimary: { backgroundColor: c['brand-fill'], color: c['on-brand-fill'], border: `1px solid ${c.brand}`,
            '&:hover': { backgroundColor: c['brand-fill-hover'] },
            '&.Mui-disabled': { backgroundColor: c['bg-surface-200'], borderColor: c['border-strong'], color: c['fg-muted'] } },
          containedError: { backgroundColor: c['danger-fill'], color: c['on-danger-fill'], '&:hover': { backgroundColor: c['danger-fill'] } },
          outlined: { borderColor: c['border-control'], color: c['fg-default'], backgroundColor: c['bg-surface-100'],
            '&:hover': { backgroundColor: c['bg-surface-200'], borderColor: c['border-control'] } },
          text: { color: c['fg-light'], '&:hover': { backgroundColor: c['bg-surface-200'], color: c['fg-default'] } },
          textError: { color: c.danger },
          startIcon: { marginRight: SPACE['space-1'] },
        },
      },
      MuiIconButton: {
        styleOverrides: { root: { borderRadius: RADIUS['radius-md'], color: c['fg-light'], '&:hover': { backgroundColor: c['bg-surface-200'], color: c['fg-default'] } },
          colorError: { color: c.danger } },
      },
      MuiToggleButton: {
        styleOverrides: { root: { textTransform: 'none', height: SIZE['control-sm'], padding: `0 ${SPACE['space-2']}`, fontSize: STYLE.label.fontSize,
          color: c['fg-light'], borderColor: c['border-strong'],
          '&.Mui-selected': { backgroundColor: c['brand-subtle'], color: c.brand, '&:hover': { backgroundColor: c['brand-subtle'] } } } },
      },
      MuiLink: { styleOverrides: { root: { color: c.brand } } },
      // ── forms: label above the field, field on surface-200, read-only dashed ───
      MuiTextField: { defaultProps: { variant: 'outlined', size: 'small', margin: 'dense' } },
      MuiFormControl: { defaultProps: { variant: 'outlined', size: 'small', margin: 'dense' } },
      MuiSelect: { defaultProps: { variant: 'outlined', size: 'small' } },
      MuiInputLabel: {
        defaultProps: { shrink: true },
        styleOverrides: {
          root: { ...text('label'), position: 'relative', transform: 'none', marginBottom: '6px', color: c['fg-light'], maxWidth: '100%',
            '&.Mui-focused': { color: c['fg-light'] }, '&.Mui-error': { color: c.danger }, '& .MuiFormLabel-asterisk': { color: c.danger } },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: c['bg-surface-200'], borderRadius: RADIUS['radius-md'], ...text('body'),
            '& .MuiOutlinedInput-notchedOutline': { top: 0, borderColor: c['border-control'], '& legend': { display: 'none' } },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: c['fg-light'] },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: c.brand, borderWidth: '1px' },
            '&.Mui-focused': { outline: `2px solid ${c['focus-ring']}`, outlineOffset: '1px' },
            '&.Mui-error .MuiOutlinedInput-notchedOutline': { borderColor: c.danger },
            // read-only, not the hidden helper textarea MUI adds for auto-height (it is readonly + aria-hidden)
            '&.MuiInputBase-readOnly, &:has(input[readonly]), &:has(textarea[readonly]:not([aria-hidden]))': {
              backgroundColor: 'transparent', color: c['fg-muted'],
              '& .MuiOutlinedInput-notchedOutline': { borderStyle: 'dashed', borderColor: c['border-control'] },
              '&.Mui-focused': { outline: 'none' },
            },
            '&.Mui-disabled': { backgroundColor: 'transparent', '& .MuiOutlinedInput-notchedOutline': { borderStyle: 'dashed', borderColor: c['border-control'] } },
            '& .MuiInputBase-input.Mui-disabled': { WebkitTextFillColor: c['fg-muted'] },
          },
          input: { padding: `6px ${SPACE['space-3']}`, '&::placeholder': { color: c['fg-muted'], opacity: 1 } },
          inputSizeSmall: { padding: `6px ${SPACE['space-3']}` },
          multiline: { padding: `${SPACE['space-2']} ${SPACE['space-3']}` },
        },
      },
      MuiFormHelperText: { styleOverrides: { root: { ...text('body-sm'), margin: `${SPACE['space-1']} 0 0`, color: c['fg-muted'], '&.Mui-error': { color: c.danger } } } },
      MuiFormControlLabel: { styleOverrides: { label: text('body') } },
      // ── surfaces: lines, not shadows ───────────────────────────────────────────
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          elevation1: { border: `1px solid ${c['border-strong']}`, borderRadius: RADIUS['radius-lg'] },
          outlined: { borderColor: c['border-strong'], borderRadius: RADIUS['radius-lg'] },
        },
      },
      MuiCard: { styleOverrides: { root: { border: `1px solid ${c['border-strong']}`, borderRadius: RADIUS['radius-lg'] } } },
      MuiAppBar: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundColor: c['bg-surface-100'], color: c['fg-default'], borderBottom: `1px solid ${c['border-strong']}`, boxShadow: 'none' } },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { ...text('body-sm'), borderBottom: `1px solid ${c['border-default']}`, padding: `${SPACE['space-2']} ${SPACE['space-3']}` },
          head: { ...text('label'), color: c['fg-light'], backgroundColor: c['bg-surface-200'], borderBottom: `1px solid ${c['border-strong']}`, whiteSpace: 'nowrap' },
          sizeSmall: { padding: `${SPACE['space-2']} ${SPACE['space-3']}` },
        },
      },
      MuiTableRow: { styleOverrides: { root: { '&.MuiTableRow-hover:hover': { backgroundColor: c['bg-surface-200'] } } } },
      MuiChip: {
        styleOverrides: {
          root: { ...text('label'), height: 20, borderRadius: RADIUS['radius-sm'], backgroundColor: c['bg-surface-200'], color: c['fg-light'], border: `1px solid ${c['border-strong']}` },
          label: { padding: `0 ${SPACE['space-2']}` },
          colorSuccess: { backgroundColor: c['brand-subtle'], color: c.brand, borderColor: 'transparent' },
          colorInfo: { backgroundColor: c['info-subtle'], color: c.info, borderColor: 'transparent' },
          colorWarning: { backgroundColor: c['warning-subtle'], color: c.warning, borderColor: 'transparent' },
          colorError: { backgroundColor: c['danger-subtle'], color: c.danger, borderColor: 'transparent' },
          colorPrimary: { backgroundColor: c['brand-subtle'], color: c.brand, borderColor: 'transparent' },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { ...text('body-sm'), borderRadius: RADIUS['radius-md'], color: c['fg-default'], alignItems: 'flex-start' },
          standardInfo: { backgroundColor: c['info-subtle'], '& .MuiAlert-icon': { color: c.info } },
          standardSuccess: { backgroundColor: c['brand-subtle'], '& .MuiAlert-icon': { color: c.brand } },
          standardWarning: { backgroundColor: c['warning-subtle'], '& .MuiAlert-icon': { color: c.warning } },
          standardError: { backgroundColor: c['danger-subtle'], '& .MuiAlert-icon': { color: c.danger } },
          icon: { fontSize: 18, padding: '9px 0' },
        },
      },
      MuiDialog: {
        styleOverrides: {
          root: { '& .MuiBackdrop-root': { backgroundColor: c.scrim } },
          paper: { backgroundColor: c['bg-overlay'], border: `1px solid ${c['border-strong']}`, borderRadius: RADIUS['radius-lg'], boxShadow: overlay },
        },
      },
      MuiDialogTitle: { styleOverrides: { root: text('title') } },
      MuiDialogActions: { styleOverrides: { root: { borderTop: `1px solid ${c['border-default']}`, padding: `${SPACE['space-3']} ${SPACE['space-4']}` } } },
      MuiPopover: { styleOverrides: { paper: { backgroundColor: c['bg-overlay'], border: `1px solid ${c['border-strong']}`, boxShadow: overlay } } },
      MuiMenu: { styleOverrides: { paper: { backgroundColor: c['bg-overlay'], border: `1px solid ${c['border-strong']}`, boxShadow: overlay } } },
      MuiSnackbarContent: { styleOverrides: { root: { backgroundColor: c['bg-overlay'], color: c['fg-default'], border: `1px solid ${c['border-strong']}`, boxShadow: overlay, borderRadius: RADIUS['radius-md'] } } },
      MuiTooltip: { styleOverrides: { tooltip: { ...text('caption'), backgroundColor: c['fg-default'], color: c['bg-default'] } } },
      MuiListSubheader: { styleOverrides: { root: { ...text('label'), color: c['fg-muted'], backgroundColor: 'transparent' } } },
      // ── react-admin layout ─────────────────────────────────────────────────────
      RaLayout: { styleOverrides: { root: { '& .RaLayout-content': { backgroundColor: c['bg-default'], padding: SPACE['space-4'] } } } },
      RaSidebar: {
        styleOverrides: {
          root: { '& .RaSidebar-fixed': { backgroundColor: c['bg-surface-100'], borderRight: `1px solid ${c['border-strong']}`, paddingTop: SPACE['space-2'],
                    boxSizing: 'border-box' },   // padding inside the height, so the menu's bottom group ends at the window edge
            '& .MuiDrawer-paper': { backgroundColor: c['bg-surface-100'] } },
        },
      },
      RaMenuItemLink: {
        styleOverrides: {
          root: { ...text('body-sm'), minHeight: 30, margin: `1px ${SPACE['space-2']}`, padding: `0 ${SPACE['space-3']}`, borderRadius: RADIUS['radius-md'], color: c['fg-light'],
            '& .RaMenuItemLink-icon': { color: c['fg-light'], minWidth: 26 },
            '&:hover': { backgroundColor: c['bg-surface-200'], color: c['fg-default'] },
            '&.RaMenuItemLink-active': { backgroundColor: c['brand-subtle'], color: c['fg-default'], boxShadow: `inset 2px 0 0 ${c.brand}`,
              '& .RaMenuItemLink-icon': { color: c.brand } } },
        },
      },
      RaLogin: {
        styleOverrides: {
          root: { backgroundColor: c['bg-default'], backgroundImage: 'none',
            '& .RaLogin-card': { backgroundColor: c['bg-surface-100'] },
            '& .RaLogin-icon': { backgroundColor: c['brand-subtle'], color: c.brand } },
        },
      },
      RaToolbar: { styleOverrides: { root: { backgroundColor: c['bg-surface-100'], borderTop: `1px solid ${c['border-default']}` } } },
    },
  });
}

export const darkTheme = build('dark');
export const lightTheme = build('light');
/** Monospace stack for paths, roles and schema names (sx: fontFamily: MONO). */
export const MONO = FONT.mono;
