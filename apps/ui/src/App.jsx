import {
  Admin, AppBar, CustomRoutes, Layout, LoadingIndicator, Menu, Resource, Title, ToggleThemeButton, usePermissions, useTranslate,
} from 'react-admin';
import { Box, Button, Card, CardContent, ListSubheader, Typography } from '@mui/material';
import { AdminIcon, DashboardIcon, FaqIcon, ImageIcon, SecurityIcon, SettingsIcon, TableIcon } from './icons.jsx';
import { darkTheme, lightTheme } from './theme.js';
import { Link, Route } from 'react-router-dom';
import { componentsFor } from './views.jsx';
import { StorageContext } from './fields.jsx';
import { AdminPage } from './admin.jsx';
import { ApiContext } from './api.js';
import { ForgotPasswordPage, LoginPage, SetPasswordPage } from './auth.jsx';
import { ConsentPage } from './consent.jsx';
import { SecurityPage } from './security.jsx';
import { SupabaseContext } from './context.js';
import { LanguageSwitch } from './i18n/LanguageSwitch.jsx';
import { MadeBy } from './credit.jsx';

/** Menu icon of a table: settings (one row), images, questions, else a table. */
const iconFor = (r) => (r.isSingleton ? SettingsIcon
  : r.isGallery || r.columns.some((c) => c.storage?.kind === 'image') ? ImageIcon : /(^|_)faq$/.test(r.table) ? FaqIcon : TableIcon);

// All texts go through translate(): messages in src/i18n (cms.* keys, English defaults inline), react-admin's own in ra.*.

const MENU_FULL_HEIGHT = { minHeight: '100%' };   // the sidebar's fixed box has a height; the bottom group needs it

function CmsMenu() {
  const model = usePermissions().permissions;
  const t = useTranslate();
  const security = <Menu.Item key="security" to="/security" primaryText={t('cms.security.title', { _: 'Security' })} leftIcon={<SecurityIcon />} />;
  // Administration and Security sit at the bottom of the sidebar, below the brands
  const bottom = (
    <Box data-testid="menu-bottom" sx={(theme) => ({ mt: 'auto', pt: 1, pb: 1, borderTop: `1px solid ${theme.palette.divider}` })}>
      {model?.isAdmin && (
        <Menu.Item to="/admin" primaryText={t('cms.admin.title', { _: 'Administration' })} leftIcon={<AdminIcon />} data-testid="menu-admin" />
      )}
      <Box component="nav" aria-label={t('cms.security.title', { _: 'Security' })}>{security}</Box>
      <MadeBy sx={{ pt: 1 }} />
    </Box>
  );
  if (!model) return <Menu sx={MENU_FULL_HEIGHT}>{bottom}</Menu>;
  return (
    <Menu sx={MENU_FULL_HEIGHT}>
      <Menu.DashboardItem leftIcon={<DashboardIcon />} />
      {model.schemas.map((s) => (
        <Box key={s.name} component="nav" aria-label={s.label} data-schema={s.name}>
          <ListSubheader sx={{ lineHeight: '32px', mt: 1 }}>{s.label}</ListSubheader>
          {s.resources.filter((n) => model.byName[n].canList).map((n) => <Menu.ResourceItem key={n} name={n} />)}
        </Box>
      ))}
      {bottom}
    </Menu>
  );
}

const appBarSwitch = { mr: 1 };   // colours come from the theme (MuiToggleButton)
const CmsAppBar = () => <AppBar toolbar={<><LanguageSwitch sx={appBarSwitch} /><ToggleThemeButton /><LoadingIndicator /></>} />;
const CmsLayout = ({ children }) => <Layout menu={CmsMenu} appBar={CmsAppBar}>{children}</Layout>;

function Dashboard() {
  const model = usePermissions().permissions;
  const t = useTranslate();
  if (!model) return null;
  return (
    <Card sx={{ mt: 2 }}>
      <Title title="SupaPIM" />
      <CardContent>
        <Typography variant="body2" color="text.secondary" gutterBottom data-testid="role">
          {t('cms.dashboard.role', { _: 'Database role: %{role}', role: model.role })}
        </Typography>
        {model.resources.length === 0 ? (
          <Typography data-testid="no-tables">
            {t('cms.dashboard.empty', { _: 'No tables are shared with your role yet. Ask an administrator for access.' })}
          </Typography>
        ) : model.schemas.map((s) => (
          <Box key={s.name} sx={{ mb: 2 }}>
            <Typography variant="h6">{s.label}</Typography>
            {s.comment && <Typography variant="body2" color="text.secondary">{s.comment}</Typography>}
            {s.resources.map((n) => {
              const r = model.byName[n];
              return <Button key={n} component={Link} to={`/${n}`} size="small" disabled={!r.canList}>{t(r.labelKey ?? r.label, { _: r.label })}</Button>;
            })}
          </Box>
        ))}
      </CardContent>
    </Card>
  );
}

export function App({ providers, i18nProvider }) {
  return (
    <SupabaseContext.Provider value={providers.supabase}>
      <ApiContext.Provider value={providers.api}>
        <StorageContext.Provider value={providers.storage}>
          <Admin authProvider={providers.authProvider} dataProvider={providers.dataProvider} i18nProvider={i18nProvider}
            loginPage={LoginPage} layout={CmsLayout} dashboard={Dashboard} requireAuth disableTelemetry title="SupaPIM"
            theme={lightTheme} darkTheme={darkTheme} defaultTheme="dark">
            {/* outside the layout and reachable without a session: invitation / recovery, and the MCP consent page */}
            <CustomRoutes noLayout>
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/set-password" element={<SetPasswordPage />} />
              <Route path="/consent" element={<ConsentPage />} />
            </CustomRoutes>
            <CustomRoutes>
              <Route path="/security" element={<SecurityPage />} />
            </CustomRoutes>
            {(model) => [
              ...(model?.resources ?? []).map((r) => (
                <Resource key={r.name} name={r.name} options={{ label: r.labelKey ?? r.label }} icon={iconFor(r)}
                  recordRepresentation={r.labelColumn ?? undefined} {...componentsFor(r)} />
              )),
              model?.isAdmin && <CustomRoutes key="admin"><Route path="/admin" element={<AdminPage />} /></CustomRoutes>,
            ]}
          </Admin>
        </StorageContext.Provider>
      </ApiContext.Provider>
    </SupabaseContext.Provider>
  );
}
