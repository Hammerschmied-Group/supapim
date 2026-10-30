// Runtime config comes from the server (/cms/config.json: Supabase URL + public anon key), so one
// build serves every project. Nothing project-specific is baked into the bundle.
import { createRoot } from 'react-dom/client';
// the design system's faces, served from this origin (the CSP allows no font host)
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import { App } from './App.jsx';
import { createProviders } from './providers.js';
import { createI18nProvider } from './i18n/index.js';
import { handleUrlAuth } from './session.js';

const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store' });
if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
const { supabaseUrl, anonKey } = await res.json();

const providers = createProviders({ supabaseUrl, anonKey });
await handleUrlAuth(providers.supabase);   // magic link / invite / recovery arrive in the URL: before the router sees it
createRoot(document.getElementById('root')).render(<App providers={providers} i18nProvider={createI18nProvider()} />);
