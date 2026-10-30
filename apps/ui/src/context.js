import { createContext, useContext } from 'react';

// The supabase-js client of the signed-in person (same instance and same session as the data provider).
export const SupabaseContext = createContext(null);
export const useSupabase = () => useContext(SupabaseContext);

/** Where Supabase Auth sends people back to after a magic link / recovery mail: this app (with the hash router, "/cms/"). */
export const appUrl = () => `${window.location.origin}${import.meta.env.BASE_URL}`;
