# Files in Hetzner Object Storage (S3 backend)

Supabase Storage has two parts:

- **Storage API:** checks the token and policies, stores metadata in `storage.objects`, signs URLs and serves image previews through imgproxy.
- **Backend:** the place where the files themselves live. This is either the local volume (`file`) or an S3-compatible bucket (`s3`).

With the S3 backend, files live in **Hetzner Object Storage**. Everything else stays the same: per-role permissions (the agency sees only its folder, HR only `hr-files`), upload in the CMS UI, the MCP storage tools, signed URLs and image previews. The CMS and MCP server still talk only to the Storage API and do not know where the bytes are.

**Don't do this:** attach a Hetzner bucket directly to the CMS or MCP server and bypass the Storage API. Neither policies nor roles apply then.

## Setup

1. In the Hetzner Console, create a **dedicated, private** bucket, plus S3 credentials. Do not use another project's bucket.
2. Add them to `.env`. The file is listed in `.gitignore`. The values do not belong in chat or in Git.

   ```
   STORAGE_BACKEND=s3
   S3_BACKEND_HOST=hel1.your-objectstorage.com   # location from the Hetzner Console: fsn1 / nbg1 / hel1
   S3_BACKEND_REGION=hel1
   S3_BACKEND_BUCKET=…
   S3_BACKEND_KEY_ID=…
   S3_BACKEND_SECRET=…
   ```

3. Recreate the storage container and upload the demo files:

   ```bash
   source scripts/lib.sh && compose up -d --no-deps --wait storage
   ```

   ```bash
   scripts/seed.sh --storage-only
   ```

4. Verify:

   ```bash
   node scripts/test-storage.mjs
   ```

   The test also runs as part of `scripts/test.sh`.

Technically, with `STORAGE_BACKEND=s3`, `scripts/lib.sh` adds the file [`stack/storage-s3.yml`](../stack/storage-s3.yml) to the Compose files. It only sets the Storage API's `STORAGE_S3_*` variables. Upstream files stay unchanged.

**Back to the local volume:** remove `STORAGE_BACKEND` from `.env` (or set `file`) and recreate `storage`, as in step 3.

## Existing files

**Switching does not move any files.** The metadata in `storage.objects` stays, but the bytes remain in the old backend.

- **Local demo stack:** `scripts/seed.sh --storage-only` uploads the demo files again. Other uploaded files have to be uploaded again.
- **Real project:** copy the files before switching, for example with `rclone` or `aws s3 sync`. The Storage API's path scheme (tenant, bucket, path, version ID) must be preserved. Then verify with `node scripts/test-storage.mjs` and spot checks.
- **Never change or delete files directly in the Hetzner bucket.** The Storage API does not know about such changes, and `storage.objects` no longer matches.

## Verified on 2026-10-29 (Hetzner, `hel1`)

`node scripts/test-storage.mjs` with the token of a real person (`cms_admin`):

| Check | Result |
|---|---|
| Upload and download, byte-identical | ✅ |
| Image preview through imgproxy (`/render/image`) | ✅ |
| Signed URL without a key | ✅ |
| 18 MB upload (multipart), byte-identical | ✅ |
| Resumable upload (TUS, 3 × 6 MB), byte-identical | ✅ |
| Upsert, list, delete | ✅ |
| Policies: the agency cannot read an HR file, HR reads its file | ✅ |

In addition, the full `scripts/test.sh` run is green: 125 SQL tests, the MCP chain with storage tools, 44 Playwright tests including upload in the UI. Since the switch, no file lands in the local volume any more.

## Good to know

- **`scripts/reset.sh --wipe` with the S3 backend:** the database is deleted, but the files in the Hetzner bucket stay. They are then orphaned because they are missing from `storage.objects`. `scripts/seed.sh` only empties what the Storage API knows about. Delete orphaned files in the Hetzner Console or with `rclone`.
- **Public Supabase buckets stay public**, regardless of the backend. For `images`, the Storage API serves every file without sign-in. The Hetzner bucket itself stays private; only the Storage API accesses it with the credentials.
- **Supabase Cloud:** you cannot change the backend there. The S3 backend is an option for self-hosted stacks. SupaPIM works with any backend because it only uses the Storage API.
