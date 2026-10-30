# Threat model: SupaPIM (CMS interface + MCP per person)

As of 29 Oct 2026. Reviewed: the code on `main` (c2a77ad) and the running local stack (Supabase self-hosted v0.8.3, ES256, GoTrue as OAuth 2.1 server with DCR). The findings, with evidence, severity and status, are in [findings.md](findings.md). The **F-xx** numbers in the text refer to it.

## 1. What is protected

| Asset | Where | Why it matters |
|---|---|---|
| Customer data (PIM, FAQ, HR documents, vector store) | Postgres schemas, storage buckets | The product promises that every person and every agent may do exactly what their Postgres role may do. |
| Role assignment | `cms.user_roles`, token hook | Whoever changes it changes all of a person's rights. |
| Identity and sessions | GoTrue (`auth.*`), access and refresh tokens, `localStorage` of the UI | A token is the person, on every Supabase API. |
| Service key | only `apps/server/src/admin` | It bypasses all rights (RLS, GRANTs, auth). |
| Audit log | `audit.change_log` | Proof of who changed what; contains entire rows. |

## 2. Actors

- **Person with a role** (agency, HR, admin): signed in to the UI, possibly with TOTP.
- **Person without a role**: signed in, role `authenticated`. On Supabase Cloud, self-registration is on by default, so this can be *anyone* (F-09).
- **MCP client** (Claude, ChatGPT, Cursor, any program registered via DCR): after approval, holds the person's access and refresh token.
- **Agent with prompt injection**: an honest client whose model follows instructions found in data content.
- **External attacker**: knows the public URL and the anon key (both are public), registers OAuth clients, sends links.
- **Attacker with a password**: phishing or a reused password, but no second factor.
- **Operator** (admin of the Supabase project): has SQL access, sets GRANTs, policies and `cms.settings`.

## 3. Trust boundaries and data flow

```
Browser (UI, /cms)  ──session token──►  Gateway ─► PostgREST / Storage / GoTrue      (rights: Postgres)
                    ──session token──►  /cms/api/admin ─(gate: JWKS + whoami.is_admin)─► GoTrue admin API (service key)
MCP client          ──OAuth token────►  /cms/mcp ─(JWKS)─► PostgREST / Storage with the same token
GoTrue              ──token issuance─►  cms.custom_access_token_hook (sets role from cms.user_roles)
```

The key point: **the MCP server and the UI have no rights of their own.** They pass the person's token on, and Postgres decides. The only place with more rights is the admin API, and only after checking the token **and** the database (`cms_api.whoami().is_admin`). There are three pieces of evidence for this separation:
1. `scripts/check-no-service-key.sh` checks the code and the container environment.
2. `scripts/test-security.mjs` §4 starts a server with a canary key behind a recording proxy. The key appears in no request of the MCP path and in no response, only at the auth admin API.
3. A grep over the UI bundle finds no service key.

Residual risk: when run as a single container, the key sits in `process.env` of the same Node process as the MCP server. `apps/server/admin.mjs` allows running it as its own process; the deployment package does this as the separate service `cms-admin` (F-15).

## 4. Threats

### 4.1 Token passthrough and binding

**Situation.** All access tokens have `aud = authenticated`, including the OAuth tokens of the MCP clients. There is no resource binding: `resource` from the authorization request is not carried into the token. A token from the UI session works at the MCP server and vice versa. An OAuth token works at every Supabase API: PostgREST, Storage, GraphQL, Realtime and **GoTrue `/user`**.

**Consequences.**
- An MCP client, whether malicious, compromised or approved through phishing, can do more with the token than MCP. Measured on the local stack: it **resets the person's password** (`PUT /auth/v1/user`, HTTP 200, without re-authentication) and signs out all sessions (`logout?scope=global`). That takes over the account (F-03).
- The admin API accepted OAuth tokens of an admin. **Fixed:** the gate rejects tokens with `client_id`.
- A token that ends up in the MCP log or in a client configuration is full access for up to `JWT_EXPIRY` (3600 s). The refresh token is valid indefinitely (F-06).

**Mitigations.** Implemented: the admin API accepts UI tokens only; the consent page warns when the access goes to a foreign host. Configuration shipped with the deployment package (F-03):
- GoTrue: `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=true`.
- Session timebox.
- Shorter token lifetime.

### 4.2 Prompt injection through data content

**Situation.** `select_rows`, `download_file` (text up to 256 KB), `list_files` and `call_function` return data to the model unchanged. Anyone who may write a row or upload a file (agency: product names, HR: files, but also data from shop imports) can plant instructions in it for the agent of a *different* person who has more rights, such as the admin.

**What the agent can then do:** everything the person's role can do, through the MCP tools:
- Change or delete rows (limit: `max_rows` ≤ 500 per call)
- Upload files
- **`create_signed_url` up to 7 days**: this makes exfiltration possible as soon as the client has another tool with network access.

What it cannot do:
- Call admin functions through MCP: `cms_api` is not in `list_tables`, and `call_function` rejects it (test §2, "MCP admin cms_api.list_users refused").
- Use the admin API: OAuth tokens are rejected.
- Do more than the person: Postgres enforces that.

**Mitigations.**
- In place: `destructiveHint` on tools that modify data (clients ask for confirmation), `max_rows` with `Prefer: max-affected`, and audit with email and `client_id`.
- Implemented or recommended (F-18):
  - **Implemented:** the MCP instructions say that content is data and never instructions.
  - **Implemented:** `create_signed_url` for 24 h at most, and only when the person asks for it.
  - In the docs: run agents with write rights only with confirmation per call.

### 4.3 Confused deputy

**MCP server:** it has no access of its own (no service key, no DB connection) and therefore cannot do more on someone's behalf than the token allows. Checked:
- `NOT_A_PERSON` rejects `anon`, `service_role` and so on. The test sends the anon key and the service key as bearer; both get 401.
- Identifiers are checked against SQL identifiers by regex, storage paths without `..`.
- The raw `filter` can only set PostgREST parameters; `select`/`limit` are overwritten afterwards.
- All calls carry the person's token.

**Admin API:** it is the actual deputy, because it holds the service key.
- The order of checks is right: token (JWKS, issuer, audience, expiry) → no service role → no OAuth client → `whoami()` with the person's token says `is_admin` and the same `sub`.
- Only then comes the key, and only for four operations: read users, invite, ban, unban.
- Tests: unit tests in `admin.test.mjs`, E2E in `admin.spec.js` (expired, foreign key, HS256, `alg=none`), suite §1/§2/§4.

Residual risks:
- With `CMS_ADMIN_INVITE_DELIVERY=link`, the admin gets a sign-in link for a foreign identity that has not yet accepted. That lets them sign in as that person (F-14).
- "Do not change your own role" is not a hard boundary. An admin can invite a second identity, take it over via the link and give it `cms_admin`. Admin stays admin, which is intended; it is still worth knowing.

**`security definer` functions in `cms`** (see 4.9) are deputies as well. They determine the caller through the GUC `role` (`cms.caller_role()`), which PostgREST sets with `SET LOCAL ROLE`. Nobody can forge it through the API, because `SET ROLE` requires membership.

### 4.4 DCR abuse and the consent page

- **DCR** is open (`/auth/v1/oauth/clients/register` without a key, route in the gateway).
  - GoTrue rejects `javascript:`/`data:` redirects and allows `http` only for `localhost`.
  - `https` on arbitrary hosts and app schemes (`cursor://`) are allowed.
  - The client name is freely chosen, e.g. "Claude".
  - **Phishing chain:** an attacker registers "Claude" with `https://evil.example/cb` and sends the authorization link. The person clicks "Allow", and the attacker gets code and token. With F-03 that means: change the password, account gone.
  - The consent page shows the redirect URI. That is the only brake.
- **CSRF:** there are no cookies. The UI, the admin API and the consent page send the token in the `Authorization` header taken from `localStorage`; a foreign page cannot trigger these requests. CORS returns no `Access-Control-Allow-Origin` for foreign origins (test §5).
- **Clickjacking:** `/cms/` (so also `#/consent`) and `/oauth/consent` send `frame-ancestors 'none'`. Tested.
- **Auto-approve:** if the person has already agreed to a client, GoTrue redirects back without asking. The code goes only to a registered redirect URI *of this* client. An attacker gains nothing from that as long as they do not control the client's redirect URI.
  - New: on this path, the page also confirms the client for MFA persons (F-01).
  - New: the page follows only `http(s)` and app redirects.
- **Consent without a second factor:** the GoTrue consent API accepts an AAL1 session, and OAuth tokens are always `aal1`. **Fixed** in F-01: without confirmation at AAL2, the token carries no role.

### 4.5 Open redirect on invitation

The admin API takes `Origin` + `/cms/` as `redirect_to`, and GoTrue checks it against `GOTRUE_URI_ALLOW_LIST`. Measured on the stack:
- `Origin: http://evil.example` → GoTrue falls back to `SITE_URL`.
- `Origin: http://localhost:9` → `redirect_to=http://localhost:9/cms/`, because the allow-list contains `http://localhost:*/cms/**`.

A browser sets `Origin` itself, so this can be exploited only by the admin personally or by scripts holding an admin token. **Fixed:** `CMS_PUBLIC_UI_URL` fixes the target. In addition, the deployment package ships a production allow-list without port wildcards (F-10).

### 4.6 Revoking rights takes effect only when the token expires

`revoke_role`, `assign_role`, banning and signing out affect only *new* tokens. An issued access token keeps its role for up to `JWT_EXPIRY` (3600 s locally), even after the person is deleted. Measured: after `logout`, the refresh token is dead, while the access token keeps answering with 200 (suite §1, INFO). Countermeasure: a shorter `JWT_EXPIRY`. Immediate revocation would need a check on every request, for example an RLS function that compares `cms.user_roles` against the claim. That costs performance, so it is not implemented (F-05).

### 4.7 Public buckets bypass all policies on read

With `public = true`, `/storage/v1/object/public/…` serves every file without a key and without a token. The policies (e.g. "agency Nordwind sees only `nordwind/`") apply only to listing and writing. Measured: 200 for a `nordwind/` file without a token (suite §5, INFO). `cms.check_storage()` reports public buckets, and the UI shows "Public bucket" when uploading. In addition: active content (SVG) is served without CSP and without `nosniff`. The UI image upload now accepts raster formats only. If the UI is on the same origin as `/storage/v1`, every uploadable SVG becomes XSS in the UI origin, and therefore token theft (F-02).

### 4.8 EXECUTE for PUBLIC on new functions in `public`

By default, Postgres grants new functions `EXECUTE` to `PUBLIC`. This can be revoked only globally, not per schema. `cms.fix_public_defaults()` revokes it from `anon`/`authenticated` for existing functions and for the default ACL of these roles. Functions created in `public` *afterwards* are still executable by `anon` via `PUBLIC`. `cms.check_public_defaults()` reports them (`critical` for `security definer`). They can also be called by any role through MCP `call_function`. Since v6, `fix_public_defaults(include_public_execute => true)` revokes the right globally (opt-in, F-08).

### 4.9 `security definer` functions in `cms`

| Function | Checks | Assessment |
|---|---|---|
| `is_admin(r)` | — (returns only yes/no) | `search_path` did not end in `pg_temp`; fixed (F-12). Reveals whether a role is admin (uncritical). |
| `effective_rights`, `list_users`, `assign_role`, `revoke_role`, `list_assignable_roles` | `require_admin()` via `caller_role()` | Correct. `assign_role` accepts only `is_assignable_role`: NOLOGIN, not superuser, not BYPASSRLS, `authenticator` is a member. Since v6, roles with inherited admin rights (e.g. member of `pg_read_all_data`) or with `CREATEROLE`/`CREATEDB` are not assignable; `cms.check_roles()` reports old assignments (F-19). |
| `record_history` | read right on `audit.change_log`, otherwise admin + read right on the table | Returned entire rows, including columns and rows the admin may not read: **fixed** (F-04). |
| `confirm_mfa_client` (new) | `aal2`, claim role = session role, the authorization belongs to the person | See F-01. |
| `audit.log_change` | — (trigger) | Errors become a WARNING, and the change goes through without a log entry. The claims come from `request.jwt.claims`: through PostgREST this is safe. Anyone working directly via SQL can set them and forge the log. |

### 4.10 Effect of `scripts/brand-bootstrap.sh` on rights

The script **extends** rights; it does not restrict any:
- Admin roles get DML on *all* tables of the schema, including future ones.
- The agency role gets `SELECT` on *all* tables, including future ones, and a permissive policy `using (true)` on every RLS table.
- The agency role is granted `authenticator` and can therefore be assigned through the token hook.
- The schema ends up in the audit.

Applied to an *existing* schema, this makes all existing tables readable for the agency, including ones that have nothing to do with products. Stricter policies that already exist are overridden for this role by the permissive `true` policy. For schema names containing `_`, the storage policy was too broad (`_` is a LIKE wildcard): **fixed** (F-13). An already existing role `agency_<schema>` is adopted without checking and granted `authenticator`.

### 4.11 Second factor (newly found)

The UI asks for the code and opens only with AAL2. The database did not ask: a password alone yielded an AAL1 token with the full role for PostgREST, Storage and MCP (F-01). **Fixed in the token hook:** anyone with a confirmed factor gets the role only with `aal2`. For OAuth tokens (always `aal1`), the role applies only if the person has confirmed the client with their AAL2 session on the consent page.

## 5. Assumptions

- TLS terminates in front of the gateway and the SupaPIM container. Without TLS, all tokens travel in cleartext.
- The operator assigns GRANTs and policies deliberately. SupaPIM makes them visible but does not check whether they make sense.
- The UI is served from a **different origin** than `/storage/v1`, or storage responses get a sandbox CSP (see F-02). Without one of the two, 4.7 rises to "high".

## 6. Tests for this model

| File | What | Runs in |
|---|---|---|
| `packages/sql/test/tests.sql` | Rights per role, hook including MFA, `confirm_mfa_client`, `record_history` columns | `scripts/test.sh`, `scripts/test-sql.sh` (PG 15 + 17) |
| `scripts/test-security.mjs` | Role × action across the UI and MCP channels, tokens, MFA, service-key canary, headers/CORS | `scripts/test.sh` |
| `apps/server/test/admin.test.mjs` | Admin gate: expired, foreign key, wrong issuer/aud, service role, OAuth client | `scripts/test.sh` |
| `apps/ui/e2e/admin.spec.js`, `auth.spec.js` | Admin API with expired/foreign/HS256/`alg=none` tokens; MFA login; consent with a second factor | `scripts/test.sh` |
| `scripts/release-audit.sh` | npm audit, SBOM (CycloneDX) for packages and image | Release |
