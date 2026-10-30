# Compatibility

As of 2026-10-29, SupaPIM **0.1.0** (database schema version 3). "Tested" here means a script in the repo has proven it; everything else is explicitly marked "not tested".

## Matrix

| Environment | Version | Status | Evidence |
|---|---|---|---|
| **Self-hosted, Envoy** (default gateway) | Supabase `self-hosted/v0.8.3` (2026-10-16), Envoy 1.39.1 | ✅ tested | `scripts/test-package.sh envoy`: fresh stack, installation from the archive, smoke test, sign-in with role claim, admin API, end-to-end chain (OAuth 2.1 → hook → MCP → PostgREST/Storage → audit) |
| **Self-hosted, Kong** | `self-hosted/v0.8.3`, Kong 3.9.3 | ✅ tested | `scripts/test-package.sh kong`: same as for Envoy |
| Self-hosted, Postgres **17** | `supabase/postgres:17.6.1.136` (default in v0.8.3) | ✅ tested | Stack runs above; SQL tests (128) in `scripts/test-sql.sh` |
| Self-hosted, Postgres **15** | `supabase/postgres:15.14.1.122` (SQL tests), upstream override `docker-compose.pg15.yml` | ⚠️ SQL tested, **no stack run** | `scripts/test-sql.sh 15.14.1.122` and the CI matrix `.github/workflows/sql.yml`; the migration requires Postgres ≥ 15 and aborts with a message below that |
| Self-hosted, other `v0.8.x` | v0.8.0 to v0.8.2 | not tested | The package replaces gateway volumes; if they do not match, startup aborts with a message. The gateway behavior (open discovery routes) changed between 0.8.2 and 0.8.3 (upstream changelog). |
| Self-hosted, `v0.9` and newer | – | not tested | Add it here only after a run of `scripts/test-package.sh` |
| **Upstream proxy** Caddy / nginx (`docker-compose.caddy.yml`, `…nginx.yml`) | | ⚠️ **not tested, needs an addition** | Both forward only fixed paths to the gateway; everything else goes to Studio. The paths `/cms`, `/oauth/consent` and `/.well-known/oauth-protected-resource` must be added, see [`install-selfhosted.md`](install-selfhosted.md#tls-and-reverse-proxy). `cms/install.sh check` shows whether they get through. |
| **File storage: volume** (default) | Storage API v1.81.0 | ✅ tested | `scripts/test-storage.mjs` |
| **File storage: Hetzner Object Storage** (S3) | `hel1`, Storage API v1.81.0 | ✅ tested | `scripts/test-storage.mjs` (upload/download byte-identical, imgproxy, signed URL, 18 MB multipart, TUS, policies); [`storage-s3.md`](storage-s3.md) |
| **Supabase Cloud** | – | ❌ **not tested** | See [`install-cloud.md`](install-cloud.md). Open: whether `/auth/v1/oauth/*` is reachable without an API key, hook and OAuth server in the Cloud (documentation status there), PostgREST version. Storage cannot be swapped there. |
| Container image | `linux/amd64` and `linux/arm64`, Node 22 | ✅ built and started | `scripts/build-image.sh`; both architectures start and answer on `/health` |

## What SupaPIM requires from Supabase

| Requirement | Why | If not met |
|---|---|---|
| Postgres ≥ 15 | Functions, `security invoker` views, catalog | `install.sql` aborts |
| GoTrue with **Custom Access Token Hook** and **OAuth 2.1 server** (tested: v2.197.0) | Role in the token, MCP sign-in via DCR + PKCE | Without the hook there are no roles; without the OAuth server there is no MCP; the UI works without the OAuth server |
| **Asymmetric signing keys** (ES256, JWKS) | The MCP server verifies tokens through the JWKS; ID token for `openid` | `docker-compose.cms.yml` refuses to start without `JWT_KEYS` and prints instructions |
| PostgREST ≥ 13 (tested: v14.18) | `Prefer: handling=strict, max-affected=N` limits UPDATE/DELETE by agents; required schemas | Older versions: MCP write tools run without this safety net |
| Docker Compose ≥ 2.24 | `!override`/`!reset` in the overrides (tested: 2.40) | `docker compose config` reports an error |
| Gateway route `/auth/v1/oauth/` without an API key | MCP clients do not send an API key | The package adds it for Envoy and Kong (upstream opens only the discovery routes) |

The container itself does not need Node on the host; the image ships Node 22.

## Approving a new combination

1. Run `scripts/test-package.sh envoy` and `scripts/test-package.sh kong` with the new tag in `stack/SUPABASE_VERSION` (if the tests should start from a fresh upstream state).
2. Run `scripts/test-sql.sh <postgres-tag>` for every Postgres version the matrix lists.
3. Add a row here with the evidence.
