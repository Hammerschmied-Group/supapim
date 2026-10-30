-- Let PostgREST (and the Storage API, which connects through it) switch into the group roles when
-- a signed JWT carries "role": "<group>". Only tokens signed with the instance keys can do this;
-- anon/publishable keys keep their roles. authenticator is NOINHERIT, so membership only allows
-- SET ROLE and grants it nothing directly. Same as the AVIA template (30-postgrest.sql).

grant cms_admin, hr_editor, agency_nordwind, agency_suedwind to authenticator;
