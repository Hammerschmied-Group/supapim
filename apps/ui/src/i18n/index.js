// Languages: English and German with ra-i18n-polyglot. Default = the browser's language (de-AT → de, anything else → en);
// a choice made with the language switch is kept in localStorage.
import polyglotI18nProvider from 'ra-i18n-polyglot';
import { resolveBrowserLocale } from 'react-admin';
import en from './en.js';
import de from './de.js';

export const LANGUAGES = [{ locale: 'en', name: 'English', short: 'EN' }, { locale: 'de', name: 'Deutsch', short: 'DE' }];
const messages = { en, de };
const STORAGE_KEY = 'supabase-cms-locale';

const supported = (l) => LANGUAGES.some((x) => x.locale === l);
const stored = () => { try { const l = localStorage.getItem(STORAGE_KEY); return supported(l) ? l : null; } catch { return null; } };

export function initialLocale() {
  if (stored()) return stored();
  const fromBrowser = resolveBrowserLocale('en');
  return supported(fromBrowser) ? fromBrowser : 'en';
}

export function createI18nProvider() {
  const provider = polyglotI18nProvider((locale) => messages[supported(locale) ? locale : 'en'], initialLocale(),
    LANGUAGES.map(({ locale, name }) => ({ locale, name })), { allowMissing: true });
  document.documentElement.lang = provider.getLocale();
  return {
    ...provider,
    changeLocale: async (locale) => {
      try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* private mode: the choice lasts until reload */ }
      await provider.changeLocale(locale);
      document.documentElement.lang = locale;
    },
  };
}

export { messages };
