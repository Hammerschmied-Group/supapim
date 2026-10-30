# SupaPIM UI: Architecture

As of 2026-10-28. Decision log for the SupaPIM UI at `/cms`. Implemented: the core (D1–D10), storage (D11), audit and admin (D12), auth and languages (D13 and D14).

**Principle:** The UI has no permission model and no content model of its own. It shows what `cms_api.describe()` reports for the signed-in role and sends every request to PostgREST with the person's token. Postgres decides what is allowed. The UI only hides what would be rejected anyway.

## Decisions

### D1 Data provider: `ra-data-postgrest` directly, auth from `ra-supabase-core`

`ra-supabase` has two parts. We use its **auth provider** (`ra-supabase-core`). We do not use its data provider `supabaseDataProvider`, but the library it is built on: `@raphiniert/ra-data-postgrest`. Reasons:

1. **Custom schemas.** `supabaseDataProvider` takes exactly one global function `schema: () => string`. We need a schema per resource (`nordwind.products` next to `suedwind.products`). `ra-data-postgrest` 2.6 accepts `meta.schema` **per call** and turns it into `Accept-Profile` (GET) or `Content-Profile` (POST/PATCH/DELETE). This works through the gateway, as the E2E test shows: the agency reads `nordwind.products` and writes `suedwind.products`.
2. **OpenAPI.** The rest of `supabaseDataProvider` (`getSchema()`, guesser) reads the OpenAPI document. Through the gateway it is only reachable with the service key. We use `describe()` instead.
3. It is **not a fork**. `ra-supabase-core` 3.5.2 itself depends on `@raphiniert/ra-data-postgrest ^2.4.1`. npm installs the library only once (2.6.0). Our own code is about 40 lines in `src/providers.js`: HTTP client with token and `apikey`, a switch from resource to schema and table, the column list, the write filter.

Each resource gets its own `ra-data-postgrest` instance. Its `primaryKeys` map is keyed by the table name in the URL. With a single instance, `nordwind.products` and `suedwind.products` would share an entry.

### D2 Auth provider: `supabaseAuthProvider` with two corrections

- `login` maps the `username` field to `email` so that Supabase Auth accepts the sign-in. The login form (`auth.jsx`) already sends `email`. Magic link, TOTP and the consent page: D11 and D13.
- **`checkError`:** `ra-supabase-core` signs the user out on **403**. For us, 403 means "Postgres rejects this one action" (`42501 permission denied`). The person should stay signed in and see the message. So only **401** ends the session now.
- `getPermissions` returns the **UI model** from `describe()` (see D4). `<Admin>` renders the resources through a function child `(model) => <Resource …/>`. react-admin 5 still supports this form.
- The session is stored by supabase-js in `localStorage` under the key `supabase-cms-auth`. The consent page (D13) uses the same client and therefore the same session.

### D3 Versions (checked 2026-10-28)

| Package | Version | Fits because |
|---|---|---|
| `react-admin` | 5.15.5 | current; MUI 5/6/7/9, react-router 6/7 |
| `ra-supabase-core` | 3.5.2 (2026-02-13) | peer `ra-core ^5.8.0`, satisfied by 5.15.5 |
| `@raphiniert/ra-data-postgrest` | 2.6.0 | peer `ra-core ^5.7.3`; the tree contains only one `ra-core` (`npm ls`) |
| `@mui/material` | **7.3.11** | `ra-supabase-ui-materialui` allows at most MUI 7. With MUI 9 we could not use its login, password and MFA components. |
| `react-router(-dom)` | **7.18.5** | `react-admin` requires `^6.28 \|\| ^7.1`, version 8 does not fit |
| `react` | 19.2.9 | 19.3.1 is only a day old |
| `@supabase/supabase-js` | 2.118.0 | |
| `vite` / `@vitejs/plugin-react` | 8.3.4 / 6.1.2 | |
| `@playwright/test` | 1.64.1 | Chromium headless shell |

All versions are pinned exactly (`--save-exact`), and `package-lock.json` is in the repo. **Result:** the versions work together as long as MUI stays ≤ 7 and react-router stays ≤ 7.

### D4 Resources and views are derived from `describe()`

`src/model.js` is a pure function without React and has unit tests against real `describe()` responses of the demo roles (`test/fixtures/`). The rules:

| `describe()` reports | UI |
|---|---|
| Table/view in schema `s` | Resource `s.t`, menu group `s` (label from the name, description from the schema comment) |
| Column without `select` | **invisible**, even if `insert` or `update` is present (never requested, see D5) |
| Column without `update` | read-only in the edit form |
| Column without `insert` | missing from the create form |
| `identity = 'a'` or `generated` | never writable, whatever the GRANTs say |
| Table without `insert` | no create route and no create button |
| Table without `delete` | no delete button, no bulk selection |
| Table without `update` (or without a readable PK) | show view instead of edit view |
| No (readable) primary key | read-only list, no detail page |

- **Views:** `kind = view/materialized_view/foreign_table` are treated the same way. An edit view exists only if `describe()` returns a PK, which is normally not the case for views.
- **Record title** (`recordRepresentation`, references, search): the first readable column of `name, title, label, question, email, sku, slug, code`, otherwise the first text column.
- **List columns:** at most 7. JSON, arrays, Markdown/HTML, vectors and uuid surrogate keys are left out.
- **Filters:** full-text search (`ilike`) on the title column and one select filter per enum column.
- **Saving** runs `pessimistic`, not `undoable`. A rejection by the DB then shows up immediately instead of after the undo window.
- **Cache:** The model is loaded once per signed-in person and discarded on sign-in or sign-out. New permissions only take effect with the next token anyway. After that, reloading the page is enough.
- RLS can still reject individual rows. The UI then shows the database's message (e.g. 406 "Cannot coerce the result to a single JSON object" when a row is not visible).

### D5 Never `select=*`, write only allowed fields

- **Reading:** `select=*` fails with `42501` as soon as the role may not read **one** column. The data provider therefore always requests the explicit list `readColumns` (`meta.columns`). This also applies to `Prefer: return=representation` after PATCH and POST.
- **Writing:** `writableData()` removes everything the role may not write. The DB would reject it anyway, but an unchanged read-only field must not make saving fail. `ra-data-postgrest` only sends changed fields on an update anyway (diff against `previousData`).
- **Defaults on create:** Simple literal defaults (`'EUR'::text`, `'active'::status`, `true`, numbers, `'{}'::jsonb`) prefill the form. If a field with a DB default is left empty, it is not sent, so that `now()`, `gen_random_uuid()` or the identity apply. Otherwise the UI would, for example, write `active = false`, because a switch without a preset value is `false`.

### D6 Field types

| Column (`category` / `udt` / hint) | List/Show | Form |
|---|---|---|
| Foreign key (single-column, target readable and with a single-column PK) | `ReferenceField` with link | `ReferenceInput` + autocomplete (`ilike` search on the title column) |
| `enum` / enum array | text / list | `SelectInput` / `SelectArrayInput` |
| `boolean` | check mark | `BooleanInput`, `NullableBooleanInput` if nullable |
| `number` | `NumberField` | `NumberInput` |
| `date` / `timestamp(tz)` | date / date + time | `DateInput` / `DateTimeInput` (`time` stays text) |
| `json`, `jsonb`, non-text arrays | truncated / `<pre>` | multi-line in monospace, parsed and validated ("Invalid JSON") |
| `text[]`, `varchar[]` | comma-separated | `TextArrayInput` |
| `text` with a long-text name (`description`, `answer`, `content`, `body`, `notes`, `summary`) | truncated | multi-line |
| Markdown: domain `markdown` or `@cms(markdown)` | text | multi-line in monospace (no editor with preview yet) |
| HTML: domain `html` or `@cms(html)` | `RichTextField` | `RichTextInput` (`ra-input-rich-text`, TipTap, MIT) |
| Text column with `@cms(image, bucket=…)` / `@cms(file, bucket=…)` | preview (imgproxy) or path + "Open" | image/file field with upload, alt text and title (D11) |
| `vector`, `halfvec`, `sparsevec`, `tsvector` | `‹extensions.vector(1536)›` | the type only; the column is neither loaded nor sent |
| `uuid` and everything else | text | text |

Rich text is thus determined **by column type (domain) or comment**. The demo has no HTML or Markdown column. This mapping is therefore covered by unit tests, not by E2E.

### D7 Foreign keys as relations

- **Forward:** `ReferenceField` links to the target. If the role may edit the target, the link goes to the edit view, otherwise to the show view.
- **Backward:** The edit and show views list the records that point to this record (`ReferenceManyField`), e.g. the images of a product. Every row is clickable.
- Multi-column foreign keys and targets without read permission remain plain values in v1.

### D8 Hints in comments: `@cms(…)`, including the convention for image columns

UI hints live **in the Postgres comments** of a column or table. Additional text may sit next to the `@cms(…)` part; the UI shows it as help text:

```sql
comment on column nordwind.faq.answer is 'Answer for the website. @cms(markdown)';
comment on column nordwind.product_images.storage_path is '@cms(image, bucket=images)';
comment on table  nordwind.faq is 'Frequently asked questions @cms(label=FAQ)';
```

Recognised are `text`, `textarea`, `markdown`, `html`, `json`, `image`, `file`, `hidden` and `readonly` as well as `label=…`, `bucket=…`, `alt=…` and `title=…`. A `hidden` on a table hides it, and a `singleton` on a table turns it into a page with exactly one row (D19). `readonly` is purely cosmetic; the permissions remain the GRANTs.

**Why comments and not `cms.settings`:** `describe()` already returns the comments. So there is no new table, no migration step and no admin rights needed. Comments can be maintained in the SQL editor and in Studio, travel with schema dumps and migrations, and apply per column. This fits the principle of not building a model of our own next to Postgres. `cms.settings` remains for SupaPIM's own settings (admin roles, audit).

**Image columns (implemented, see D11):**
- An image column is a **text column holding the object path** in the bucket, marked with `@cms(image, bucket=<bucket-id>)` (for files `@cms(file, bucket=…)`).
- Alt text and title live in sibling columns of the same row. The defaults are `alt_text` and `title_attr`; to deviate, specify them with `@cms(image, bucket=images, alt=alt, title=caption)`. The image field edits these three columns together. Each keeps its own column permission: the agency may maintain alt text and title but cannot upload a new image, because `storage_path` is not updatable for it.
- **There is no heuristic** for the bucket. A bucket cannot be derived reliably from the column name. This is why `demo/sql/00-demo-schema.sql` puts both comments on `product_images.storage_path`.
- Upload and preview go through the storage API and imgproxy with the person's token. `describe().storage` shows up front which buckets and object policies apply.

### D11 Storage: image columns, upload, preview

Everything goes through `src/storage.js` with the Supabase client from `src/providers.js`, so with the person's token. The UI knows no service key. Storage decides permissions through the role's object policies.

**Three columns, three permissions.** The image field (`StorageInput` in `fields.jsx`) combines three columns of the same row. Each keeps its own column permission; the field builds no model of its own:

| Part | appears / is editable when |
|---|---|
| Preview | the role may read the path column **and** the bucket is visible in `describe().storage` **and** it is public or has a SELECT policy |
| Path (text field) | the column has `update` (edit) or `insert` (create), otherwise locked |
| Upload/replace button | the path column is writable **and** `storage.objects` has `insert` **and** there is an INSERT/ALL policy in the bucket (`bucketAbilities()` in `model.js`) |
| Alt text, title | the **own** `update`/`insert` of the column `alt_text` / `title_attr` (or `alt=`/`title=`) |

The agency can therefore maintain alt text and title and sees the preview, but has neither an upload button nor a writable path. This holds in the UI and in the database at the same time: `PATCH storage_path` → `403 42501`, `POST /storage/v1/object/…` → `statusCode 403 permission denied for table objects` (HTTP 400 through the gateway).

**Evaluation in `model.js`.** `resolveStorage()` turns `@cms(image, bucket=…)` into the object `column.storage = { bucket, kind, alt, title, known, public, select, insert, update, delete }`.
- Without `bucket=`, the column falls back to a text field (no heuristic, D8). The same applies to columns that cannot hold text (`int`, array).
- The sibling column `alt_text` / `title_attr` is only used if it exists, is readable and is text. It gets `consumedBy`; `formColumns()` hides it in edit/show/create because the image field shows it. If the image field is not part of the form (create without `insert` on the path), the alt text stays a separate field.
- `bucketAbilities(storage, bucketId)`: bucket visible, privilege on `storage.objects` **and** a policy for the command (or `all`). This only decides which buttons appear; Storage still checks every request.

**Preview.** `previewUrl()` returns the imgproxy URL `/storage/v1/render/image/…` for `<img>` (size, `resize=contain`): public buckets through the public URL, private ones through a signed URL (1 h, needs the person's SELECT policy). If the object is missing, the field shows "No preview". The CSP (`img-src … ${supabaseUrl}`) allows the images. File columns (`@cms(file, …)`) have no preview but "Open" (signed URL or public URL in a new tab).

**Upload (changed 2026-10-29).**
- **Only on save, not on selection.** Selecting a file stages it in the form (`PendingUploadsContext`) and shows a local preview. The path is already in the form, so validation applies. `useDeferredUploads()` in `fields.jsx` uploads the file in the `transform` of `<Create>`/`<Edit>`, right before the row is written, and substitutes the final path. If the write fails (permissions, foreign key, …), `mutationOptions.onError` rolls back exactly those uploads, provided the role has `delete` in the bucket. Leaving without saving, or a validation error such as a missing required field, therefore no longer leaves a file behind. Previously an object remained in that case that nobody could find.
- Object name: `<folder>/<sanitised file name>`. The folder is the one from the current path, otherwise the schema name (matches policies such as `name like 'nordwind/%'`). The name is sanitised to `[A-Za-z0-9._-]` (`ß`→`ss`, accents removed, never a path).
- **Never overwrite** (`upsert: false`): That would need `update` and could replace a file that another row still uses. If the name is taken, `upload()` appends a short suffix.
- **"Discard selection"** discards the staged file and restores the previous path. Nothing has been uploaded yet.
- **"Existing file"** (admin roles only): choose from `cms_api.unreferenced_files(bucket)`, i.e. files in the bucket that no image/file column points to. This lets you assign an existing upload to a row.
- **Admin → "Files without a record"** lists all such files (`cms_api.unreferenced_files()`) with open and delete. This is the safety net for everything the forms do not catch: uploads via MCP, aborted browsers, replaced paths, deleted rows. Only rows the admin can see are considered. That is why the function is reserved for admins.

**Rename (2026-10-29).** A file can be renamed on the image field (edit), on every gallery card and under Admin → "Files without a record". The folder stays, and the name is sanitised as for uploads.
- `cms_api.file_references(bucket, path)` returns the rows whose image/file column points to the path and that the caller can see (resource, column, primary key). It also returns the total number of all references, counted as the plugin owner.
- If a row the caller cannot see points to it, or the caller may not change the path of a referencing row, the dialog refuses. Those rows would otherwise point to nothing.
- Flow: First `storage.move()` moves the object (storage API, update policy; never overwrites, a taken name gives 409), then every referencing row is updated with the person's token. If an update fails, the rows already changed and the object are reverted.
- Agencies without `update` on the path column get no rename button.
- Tests: `e2e/rename.spec.js`, SQL `file_references`.

**Deliberately open (v1):**
- If a row is deleted or a stored path is replaced, the old object stays in the bucket, because several rows can use the same object. It then shows up under "Files without a record" and is deleted there.
- No cropping, no drag-and-drop, no multi-uploads.
- Private buckets are covered by unit tests of the signed-URL switch, not by E2E (the demo has no file column on `hr-files`).

### D16 System fields are never inputs in forms (2026-10-29)

Some columns are filled by the system, not by editors. `markSystemManaged()` in `model.js` sets `systemManaged` for them:

| Column | why | Edit | Create |
|---|---|---|---|
| `created_at`, `updated_at`, `inserted_at`, `modified_at` (date/time) | default `now()` or `moddatetime` trigger | read-only | missing (the DB fills them) |
| Order (`position`, `sort_order`, `sort`, `rank`) | the gallery (image tables, per parent record) or drag-and-drop in the list (D17) sets it | read-only | missing; new rows go to the end |
| Any column with `@cms(readonly)` in the comment | explicit choice | read-only | missing |
| **Image/file path** (`@cms(image|file, …)`) | upload, replace, "Existing file" and "Rename" set it | no input field, the path is shown as text under the preview | likewise; if the image is missing, the field says "Please add an image" |

- This affects **only the forms**. The columns stay readable, the GRANTs unchanged, and the data layer (`writableData`) does not filter them. So the gallery keeps writing the order with the real permissions.
- If a system column has no default in the create form and is required, it appears anyway, otherwise the row could not be created.
- Tests: `model.test.js` ("system-managed columns") and `storage.spec.js` ("forms leave system-filled fields alone").

### D19 Per-brand settings: singleton tables; currency as an enum (2026-10-29)

- A table with `@cms(singleton)` in its comment and a single-column primary key (`r.isSingleton`) has **no list**: the menu item opens the one row (edit or show), or the create form if it is missing; if the role may not create, a notice explains this. No delete, after saving you stay on the page, and the key is not a form field. In the menu it comes first in the brand's group, with a gear icon. If the table is called `settings` and has no `label=…`, it is called "Einstellungen" / "Settings" in the UI (`r.labelKey`).
- The brand bootstrap creates `<schema>.settings` this way (`docs/brand-bootstrap.md`). The key is `smallint` with `check (id = 1)`, not `boolean`: react-admin compares the record's ID with the one from the URL (`true` ≠ `"true"`), and a number survives that.
- **Currency and language:** `products.currency` and `settings.default_currency` are the enum type `<schema>.currency_code`, and `settings.default_locale` is `<schema>.locale_code`, so all three are dropdowns. For enums with a database default, the create form offers "Default (when empty)"; if left empty, the column is omitted (`writableData`) and the database sets `default_currency()` from the settings.
- Tests: `model.test.js` ("settings", "currency"), `e2e/settings.spec.js`.

### D18 Design system (2026-10-29)

The UI follows the SupaPIM design system (tokens mirrored in `src/design/tokens.json`): the design language of Supabase (dark first, one green accent, lines instead of shadows, small radii, dense tables), but never the logo, name or wordmark of Supabase.
- **One source:** `src/design/tokens.json` mirrors the design system's tokens. `src/theme.js` builds the MUI/react-admin themes `darkTheme` (default) and `lightTheme` from it. Values are changed in the design system first, then the file is copied. The code contains no colour or size value as a literal. The tokens are also available as CSS variables (`--bg-default`, `--font-mono` …).
- **Switching:** light/dark through the button in the app bar (react-admin `ToggleThemeButton`, remembered in the store).
- **Fonts:** Geist and Geist Mono via `@fontsource/*`, bundled and served from our own origin (the CSP allows no font host). Paths, roles and schema names are set in `MONO`.
- **Icons:** Lucide (ISC), 1.5 px lines, via `src/icons.jsx`. Our own code no longer uses Material icons. react-admin's internal icons (menu button, pagination, profile) stay Material for now.
- **Forms:** label above the field, field on `bg-surface-200` with a `border-control` border, read-only or disabled fields dashed with the value in `fg-muted`. The focus marker is a 2 px ring in `brand`.
- **Surfaces:** cards, tables and the sidebar have lines instead of shadows; `shadow-overlay` only for dialogs, menus and toasts. The active menu item has `brand-subtle` as its background and a marker in `brand`.

### D17 Reordering by drag-and-drop in the list (2026-10-29)

If a table has an order column (`position`, `sort_order`, `sort`, `rank`, number) and a single-column primary key, and the role may change this column (`r.canReorder`), the list shows it in this order and allows reordering (`src/sortable.jsx`). Example: each brand's FAQ. Gallery tables are excluded, whose order applies per parent record in the gallery (D15).
- You drag a row by its handle. On drop, the new order is saved immediately, as consecutive values and only for rows whose value changes, with the person's token.
- **Keyboard:** focus the handle, then press arrow up or down.
- Reordering is only available in the unfiltered list, sorted by the order column. Otherwise a notice explains why it is not possible right now. The list shows up to 100 rows per page.
- When creating, new rows get "previous maximum + 1", so they land at the end.
- Without `update` on the column (e.g. agencies on the FAQ), it stays the normal list without handles.
- Sortable lists have no bulk selection for deleting; deletion is done one by one in the record.
- Tests: `e2e/sortable.spec.js`, `model.test.js`.

### D15 Gallery: images directly in the record (2026-10-29)

If a child table points to the record through a foreign key and has an image column (`@cms(image, bucket=…)` ) and a readable primary key, it appears in the parent record's edit form as a **gallery** (`src/gallery.jsx`, `galleryOf()`) instead of as a linked list. Example: `products` → `product_images`.

- **Add several images at once.** Each file is uploaded and immediately created as a row (foreign key, path, next position). If the row fails, the gallery rolls the file back.
- **Alt text and title** directly on the card. Saved when leaving the field or with Enter; Enter does not submit the form.
- **Order** through the column `position`, `sort_order`, `sort` or `rank` (number). Moving rewrites the positions as 0…n-1.
- **Remove** deletes the row. The file is only deleted if no row uses it afterwards: an admin checks this through `unreferenced_files`. For other roles it stays and shows up under Admin → "Files without a record".
- **Existing file** (admins only) creates a row for a file that is already in the bucket.
- **Permissions:** Adding needs `insert` on the child table, on the foreign key and on the path, plus the insert policy in the bucket. There must be no required columns without a default. Texts and order follow the `update` of the respective column, removal follows the `delete` of the table. The agency therefore maintains alt text and title in the gallery but can neither add nor remove images.
- **New record:** The gallery needs the parent record's key. The create form therefore shows the hint "Images can be added after the first save". After saving, the edit view opens with the gallery.
- The child table stays in the menu as its own list, for example for searching across all images. In the show view the gallery is read-only.
- Tests: `e2e/gallery.spec.js`.

### D9 Build and delivery

- **Vite**, `base: '/cms/'`, static build to `apps/ui/dist`. **Hash router** (react-admin default). The server therefore needs no SPA fallback, and `/cms/mcp` and `/cms/api/*` stay free.
- **Runtime configuration** instead of build variables: the UI loads `/cms/config.json` with `{ supabaseUrl, anonKey }`. The same image thus serves every project, and no key is in the bundle. A grep over `dist/` finds neither the anon key nor the service key (checked). A Playwright test now checks this permanently (value comparison, see D12).
- **`apps/server/src/ui/index.mjs`** → `mountCmsUi(app, { supabaseUrl, anonKey })`. The two values are passed explicitly; the module reads no further ENV. It serves the static files with a CSP (`connect-src`/`img-src` only `self` + Supabase URL, `script-src 'self'`, `frame-ancestors 'none'`). Hashed assets are cached `immutable`, and `index.html` is served with `no-cache`. In `server.mjs` this is two lines (import + call).
- **One image:** The `Dockerfile` has a build stage `ui` (`npm ci` + `vite build`). Its output lands in `/app/ui` (`CMS_UI_DIR`). The override is unchanged; after the next build, the `cms` container serves the UI at `http://localhost:55380/cms/`.
- **Development:** `npm run dev` starts Vite on **55390** against the gateway `http://localhost:55321`. `config.json` comes from the repo `.env`; only `SUPABASE_PUBLIC_URL` and `ANON_KEY` are read. CORS on the gateway allows `localhost:55390` with all required headers (`accept-profile`, `content-profile`, `prefer`, `apikey`). `content-range` is exposed.
- **E2E:** `npm run e2e` builds the UI and starts the real server `apps/server/server.mjs` on **55391** (`E2E_PORT`): UI, admin API and MCP as shipped, with the UI and `/cms/api/admin` on the same origin. The Playwright tests then run. (`standalone.mjs` still exists to serve only the UI.)

### D10 Tests

| Command | checks |
|---|---|
| `npm test` (apps/ui) | `describe()` → model: permissions → buttons and fields, FK in both directions, field types, hints, defaults, write filter, image columns and bucket permissions; `storage.test.js`: object names, upload and URL logic against a fake client; `format.test.js`: log lines, permission summary, person status; language packs: parity en ↔ de, placeholders, used keys (Node `--test`) |
| `npm run e2e` (apps/ui) | Playwright against the running stack, see README: `roles.spec.js`, `storage.spec.js`, `admin.spec.js`, `auth.spec.js` (2 tests skipped until the override is applied), `i18n.spec.js` |
| `scripts/test.sh` | SQL tests and chain as before, then both UI suites |

The E2E tests **write only to `suedwind`** (storage: objects under `suedwind/e2e-…`, deleted at the end). `scripts/test-chain.mjs` checks the last audit row of `nordwind.products` and counts the admin rows in `nordwind.faq`. Writes there would disturb the chain if both run at the same time. Every write test restores the old state or deletes what it created.

### D12 Audit and admin

**What runs where.** Pure DB operations run as **functions in `cms_api`** with the person's token (`assign_role`, `revoke_role`, `list_users`, `list_assignable_roles`, `record_history`, plus `whoami().can_read_audit`; defined in `install.sql`). Only what GoTrue needs goes through the **admin API** of `apps/server` with the service key: invite, resend invitation, ban/unban. The UI has no access to the key and calls the admin API with the person's token (`src/api.js`, same origin `/cms/api/admin`).

**Why functions in `cms_api` and no direct access to `cms.user_roles`:** The table is writable by nobody and lives in a schema that PostgREST does not see. The functions check the calling role themselves (same pattern as `cms.effective_rights`), write the role change to the log themselves (the generic triggers do not cover `cms`) and prevent anyone from removing their own role. Permissions are not touched.

**History is tied to whether the role may read it.** `describe()` hides the schema `audit`, so `whoami()` additionally reports `can_read_audit` (SELECT on `audit.change_log` or an admin role). The UI shows the block only then. The DB remains authoritative: `record_history` checks again, and on a rejection (`42501`) the block disappears silently. The record's key is the primary key from the model (`{column: value}`); the DB compares the values as text.

**The service key in the admin API.** It is read in `src/admin/index.mjs` and passed only to `src/admin/gotrue.mjs`; there it lives in a closure and is only sent as an `apikey` header to the auth API. `src/admin/gate.mjs` does not know it: it verifies the JWT (JWKS, `iss`, `aud`, expiry) and then asks `cms_api.whoami()` with the person's token; only when `is_admin = true` do the handlers run. The role claim in the token does not count. `config.mjs` stays unchanged and does not know the key; `server.mjs` gets two lines. `scripts/check-no-service-key.sh` and the E2E tests (responses, `dist/` grep) make the rule verifiable.

**Invitations without SMTP:** Without working mail delivery, GoTrue answers `/invite` with 500 and creates nobody. `CMS_ADMIN_INVITE_DELIVERY=link` therefore uses `admin/generate_link` and hands the one-time link to the admin; `mail` (default) lets GoTrue send.

**Dev:** `npm run dev` forwards `/cms/api` to `CMS_API_PROXY` (default `http://127.0.0.1:55381`, `scripts/dev-admin.sh`).

### D13 Auth: AAL2 gate, URL tokens before the router, consent in the UI

- **Two steps, one session.** `authProvider.login({ email, password })` signs in and then checks `mfa.getAuthenticatorAssuranceLevel()`. If the person has a verified TOTP factor and the session is only AAL1 so far, `login` rejects with `code: 'mfa_required'`; the session stays in memory. The sign-in page then shows the code field and calls `login({ mfaCode })` (`challengeAndVerify`). `checkAuth` does **not** let AAL1 with an open second factor into the app; reloading in this state lands on the sign-in page again. A session without a factor is AAL1 and may enter. Setting up and removing: the "Sicherheit" / "Security" page (`security.jsx`); removing requires AAL2 (GoTrue).
- **The database does not enforce AAL2.** The token of an AAL1 session opens PostgREST just the same. This is left open deliberately: a restrictive policy on `auth.jwt()->>'aal'` or the hook variant (no role claim without AAL2) would also enforce MFA for MCP clients, but would also lock out roles without a factor. This is a product decision still to be made.
- **Magic link, invitation, recovery** come back as a URL fragment `…/cms/#access_token=…&refresh_token=…&type=…`. With the hash router (D9) and supabase-js' `detectSessionInUrl`, this would go wrong: on an invitation the client would sign in immediately (without a password) and delete the hash before the auth provider sees the type. So `detectSessionInUrl` is `false`, and `handleUrlAuth()` (`session.js`) runs **once in `main.jsx` before rendering**: magic link → `setSession` and clean the URL; invitation/recovery → rewrite the tokens to `#/set-password?…` (`replaceState`), without a session; error fragment (`#error=…`) → message for the sign-in page. A first attempt to do this in `checkAuth` failed because of concurrent `checkAuth` calls: one cleaned up the URL, the next saw no session and signed out.
- **Setting a password** uses `useSetPassword` from `ra-supabase-core` (`setSession` + `updateUser`). The page is then reloaded: the session came into being outside react-admin's login flow, whose permissions cache (the model) still dates from the time without a session.
- **Local sign-out** (`signOut({ scope: 'local' })`): OAuth tokens of MCP clients are sessions of the same person, and a global sign-out would end them.
- **`ra-supabase-ui-materialui`** (3.5.2, MUI ≤ 7, MIT) is compatible with this version (D3) but not used: it knows neither the magic link nor the code step nor our texts, and the pages are small. Only `useSetPassword` from `ra-supabase-core` is used.
- **Consent page** (`consent.jsx`): `noLayout` route `/consent?authorization_id=…`, reachable without a session (react-admin always renders `CustomRoutes noLayout`). It uses `supabase.auth.oauth.getAuthorizationDetails/approveAuthorization/denyAuthorization` (supabase-js 2.118) with the UI's session. Phases: loading → sign-in (password, code if needed) → question → redirect. If the request is already decided (`redirect_url` instead of details), it goes straight to the client. `apps/server/src/consent.mjs` redirects `/oauth/consent` to `/cms/#/consent?…` (200 with meta refresh instead of 302, so that `scripts/test-chain.mjs` still finds the German text "möchte Zugriff"; the ID is checked against `^[A-Za-z0-9._~-]{1,200}$`). No magic link on this page: it leads to the overview, not to the request.
- **Override:** TOTP on, Mailpit as a separate service (55325/55326), GoTrue SMTP pointed at it, `/cms/` in the redirect allowlist. No effect on `setup.sh`.

### D14 Languages

- `ra-i18n-polyglot` 5.15.5 with `en` (`ra-language-english` + `cms.*`) and `de`. The **default** is the browser language (`resolveBrowserLocale`, `de-AT` → `de`, otherwise `en`); the choice made with the switcher (`LanguageSwitch`) is stored in `localStorage` (`supabase-cms-locale`) and wins. `<html lang>` follows. `DateField`/`NumberField` receive the chosen language (`locales`).
- **German react-admin pack: maintained by us.** Checked on 2026-10-28: `ra-language-german` 3.13.5 (greenbananaCH, MIT, 2021, for react-admin 3: keys from v4/v5 are missing), `@haleos/ra-language-german` 1.0.0 (MIT, 2023, a single push). Neither is maintained. `src/i18n/de.js` translates `ra.*` completely against `ra-language-english` 5.15.5. On a react-admin update, `npm test` reports which keys are missing (parity test en ↔ de, placeholders, `cms.*` keys used in code).
- Our own texts are `cms.*` keys with an English default in the code (`translate(key, { _: 'Default' })`) and complete in `en.js`/`de.js`. Errors from Supabase Auth are mapped to keys through `error.code` (`authErrorKey`); everything else appears in the server's wording.
- **Not translated:** table and column names and comments (they come from the database; `@cms(label=…)` is the way to name them), database messages (e.g. `42501`) and GoTrue error texts that have no code.

## Limits of v1 (deliberate)

- Columns with insert or update permission but without select permission stay invisible (by design). A table that only allows inserting (a form inbox) then has an empty create form.
- PATCH/POST with `return=representation` need read permission on the returned columns and a SELECT policy. A role with update but without select permission cannot save through the UI.
- `bigint` beyond 2^53 loses precision in JSON (standard PostgREST/JS behaviour).
- Multi-column foreign keys remain plain values. With composite primary keys, `ra-data-postgrest` encodes the ID as a JSON array (supported, but without a demo case).
- The bundle is about 1.8 MB (gzip 560 KB). Code splitting follows when needed.
- Lost second factor: the person then cannot set a password through recovery (GoTrue requires AAL2, checked). An admin has to remove the factor; the UI for that is missing in v1.
- After "set password", the page reloads (D13).

## Files

```
apps/ui/
  ARCHITECTURE.md        this note
  index.html, vite.config.js, playwright.config.js, package.json (+ lock)
  src/main.jsx           loads /cms/config.json, starts the app
  src/providers.js       Supabase client, auth provider (D2), data provider (D1, D5), model cache
  src/model.js           describe() → model (D4–D8), pure, unit-tested
  src/fields.jsx         field/input per widget (D6), image/file field (D11)
  src/storage.js         storage API: object names, upload, preview/signed URLs, delete (D11)
  src/views.jsx          generic list/edit/show/create, backward relations (D7)
  src/App.jsx            <Admin>, menu by schema, dashboard, routes
  src/auth.jsx           sign-in (password, link, code), forgot/set password (D13)
  src/security.jsx       "Security" page: set up/remove TOTP
  src/consent.jsx        OAuth consent for MCP clients
  src/session.js         URL tokens (handleUrlAuth), AAL, TOTP helpers
  src/context.js         Supabase client via context
  src/i18n/              en.js, de.js, index.js (provider, default language), LanguageSwitch.jsx (D14)
  test/model.test.js     unit tests, test/fixtures/describe-*.json
  test/storage.test.js   unit tests for src/storage.js
  e2e/roles.spec.js      Playwright, roles
  e2e/storage.spec.js    Playwright, image columns and storage
  src/api.js             rpc() on cms_api.*, admin() on /cms/api/admin (D12)
  src/admin.jsx          administration: people, invitation, role, permissions, role history (D12)
  src/history.jsx        change log per record (D12)
  src/format.js          log lines, permission summary, person status; unit-tested
  test/format.test.js
  e2e/admin.spec.js      Playwright: admin area, history, admin API (401/403), dist grep (D12)
  e2e/auth.spec.js, i18n.spec.js   Playwright, sign-in/MFA/consent and languages (D13, D14)
  e2e/env.js             helpers (throwaway people, TOTP code, generate_link, tokens)
apps/server/src/ui/index.mjs       mountCmsUi(): static UI + /cms/config.json + CSP
apps/server/src/ui/standalone.mjs  UI only (for trying it out locally)
apps/server/src/admin/             admin API (D12): index (routes, only reader of the service key), gate (JWT + whoami), gotrue (auth admin calls), log
```
