import { useLocaleState, useTranslate } from 'react-admin';
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import { LANGUAGES } from './index.js';

/** DE | EN, usable on the login page, the consent page and in the app bar. */
export function LanguageSwitch({ sx }) {
  const [locale, setLocale] = useLocaleState();
  const t = useTranslate();
  return (
    <ToggleButtonGroup size="small" exclusive value={locale} onChange={(_e, next) => next && setLocale(next)}
      aria-label={t('cms.language.label', { _: 'Language' })} sx={sx} data-testid="language-switch">
      {LANGUAGES.map((l) => (
        <ToggleButton key={l.locale} value={l.locale} aria-label={l.name} sx={{ px: 1, py: 0.25, lineHeight: 1.4 }}>{l.short}</ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
