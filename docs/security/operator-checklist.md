# Security when installing: checklist for operators

What SupaPIM cannot decide by itself, because it lives in the configuration of Supabase Auth, in the gateway or in your own buckets. Background: [findings.md](findings.md), [threat-model.md](threat-model.md).

## Supabase Auth

| Setting | Value | Why (finding) |
|---|---|---|
| Self-registration (`GOTRUE_DISABLE_SIGNUP`, Cloud: Auth → Providers → "Allow new users to sign up") | **off** | Otherwise every registered person is `authenticated` and can use CMS and MCP with the rights of that role (F-09). People come in through the invitation in the CMS. |
| Anonymous sign-in | off | as above |
| `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION` (Cloud: "Secure password change") | **on** | A connected program holds a token of the person and could otherwise change the password (F-03). |
| `JWT_EXPIRY` (Cloud: "Access token expiry") | 900 s | Role revocation, banning and signing out take effect only when the token expires (F-05). |
| Session timebox / inactivity (Cloud: Auth → Sessions) | e.g. 30 days / 7 days | Otherwise refresh tokens stay valid indefinitely, including those of the MCP clients (F-06). |
| Redirect allow-list | exactly the UI URL, no port wildcards | Invitation and sign-in links lead only there (F-10). |
| TOTP MFA | on; admins should use it | Since plugin v4, the second factor also protects the data (F-01). |

## Plugin container

| Variable | Value | Why |
|---|---|---|
| `CMS_PUBLIC_UI_URL` | e.g. `https://cms.example.com/cms/` | The invitation always leads there, not to wherever the `Origin` header points (F-10). |
| `CMS_ADMIN_INVITE_DELIVERY` | `mail` | With `link`, the admin gets a sign-in link for foreign accounts (F-14). |
| Service key | only in the service `cms-admin` (`node admin.mjs`) | The process that serves MCP and the UI gets no key (F-15). |

## Gateway and origins

- Serve the UI from its own origin, **or** set the headers `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff` on all responses under `/storage/v1/object/`. Otherwise an uploaded SVG or HTML file executes code in the origin of the UI (F-02).
- HSTS at the TLS proxy (F-17).

## Database (after `install.sql`)

```sql
select * from cms.check_public_defaults();   -- open rights in public
select * from cms.check_storage();           -- public buckets, buckets without a file type limit (F-07, F-02)
select * from cms.check_roles();             -- assignments to roles that are no longer assignable (F-19)
select * from cms.fix_public_defaults();     -- preview; run with dry_run => false
-- optional, affects ALL schemas: new functions are no longer executable by PUBLIC (F-08)
select * from cms.fix_public_defaults(dry_run => false, include_public_execute => true);
```

- Put files for the website and internal files in **separate** buckets. A public bucket is open to everyone on read, whatever the policies say (F-07).
- Set `allowed_mime_types` per bucket, e.g. only PNG, JPEG, WebP and PDF.
- `scripts/brand-bootstrap.sh` gives the agency read rights on **all** tables of the schema, including future ones. Apply it only to schemas that are meant entirely for the agency (threat-model 4.10).
- Uninstalling: first switch off the token hook, then `set cms.hook_disabled = on;` and `uninstall.sql` (F-20).

## Release

`scripts/release-audit.sh --image <tag>`: npm audit (fails from "high"), CycloneDX SBOMs for packages and image. Keep the output with the release.
