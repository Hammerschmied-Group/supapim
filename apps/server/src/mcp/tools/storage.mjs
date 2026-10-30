// Storage tools. Same principle as the row tools: Supabase Storage API with the person's token, so
// bucket policies (RLS on storage.objects) decide. Nothing is read or written with extra rights.
import { z } from 'zod';
import { errorResult, okResult, text } from '../result.mjs';
import { storageFailure, explainStorageDenied } from '../errors.mjs';

const bucketArg = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'bucket id').describe('Bucket id, see list_tables → storage.buckets');
const pathArg = z.string().min(1).max(1024).describe('Object path inside the bucket, e.g. "nordwind/regenjacke.png"');

const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|xml|html?|ya?ml|svg|css|js|mjs|log)$/i;
const isTextual = (mime, path) => /^text\//i.test(mime) || /(json|xml|yaml|javascript)/i.test(mime) || TEXT_EXT.test(path);

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
function cleanPath(p) {
  const path = p.replace(/^\/+/, '');
  if (!path || path.split('/').some((seg) => seg === '..' || seg === '')) throw new Error('Invalid path: no empty or ".." segments');
  return path;
}
const jsonBody = async (r) => { const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch { return t; } };

export function registerStorage({ tool, supabase, cfg }) {
  const describeFn = (auth) => () => supabase.describe(auth);
  const fail = async (r, ctx, auth, entry) => {
    const out = await storageFailure(r.status, await jsonBody(r), ctx, describeFn(auth));
    entry.status = out.denied ? 'denied' : 'error';
    return out.result;
  };

  async function sign(auth, bucket, path, expiresIn) {
    const r = await supabase.storage(auth.token, 'POST', `/object/sign/${bucket}/${encodePath(path)}`, { json: { expiresIn } });
    if (!r.ok) return { r };
    const body = await jsonBody(r);
    const rel = body?.signedURL ?? body?.signedUrl;
    if (!rel) return { r: { ok: false, status: 502, text: async () => '{"message":"Storage returned no signed URL"}' } };
    return { url: `${cfg.supabasePublicUrl}/storage/v1${rel.startsWith('/') ? '' : '/'}${rel}` };
  }

  tool('list_files', {
    title: 'List files',
    description: 'Lists files and folders in a storage bucket, under a folder prefix. Only what the person\'s storage policies let them see.',
    inputSchema: {
      bucket: bucketArg,
      prefix: z.string().default('').describe('Folder, e.g. "nordwind" or "handbuch/2026"; empty = bucket root'),
      search: z.string().optional().describe('Only names containing this text'),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const { bucket, prefix, search, limit, offset } = args;
    entry.target = `storage:${bucket}`;
    const r = await supabase.storage(auth.token, 'POST', `/object/list/${bucket}`, {
      json: { prefix: prefix.replace(/^\/+|\/+$/g, ''), limit, offset, ...(search ? { search } : {}), sortBy: { column: 'name', order: 'asc' } } });
    if (!r.ok) return fail(r, { bucket, op: 'list' }, auth, entry);
    const items = await jsonBody(r);
    const files = items.map((o) => o.id === null
      ? { name: o.name, type: 'folder' }
      : { name: o.name, type: 'file', size: o.metadata?.size, mime_type: o.metadata?.mimetype, updated_at: o.updated_at });
    entry.rows = files.length;
    if (!files.length) {
      const d = await supabase.describe(auth);
      if (d.ok && !d.describe.storage?.buckets?.some((b) => b.id === bucket)) {
        entry.status = 'denied';
        return errorResult(explainStorageDenied(d.describe, { bucket, op: 'read' }), { http_status: 403 });
      }
      return okResult({ files, note: 'Nothing found. The folder may be empty or not exist, or the storage policies for this role hide it (see list_tables → storage.buckets[].policies).' });
    }
    return okResult({ files, path: prefix || '/' });
  });

  tool('upload_file', {
    title: 'Upload a file',
    description: `Uploads a file to a bucket. Give the content as \`content_text\` (text files) or \`content_base64\` (any file). ` +
      `Maximum size ${Math.round(cfg.maxUploadBytes / 1024 / 1024)} MB. Existing files are only replaced with upsert=true.`,
    inputSchema: {
      bucket: bucketArg, path: pathArg,
      content_text: z.string().optional().describe('File content as text (UTF-8)'),
      content_base64: z.string().optional().describe('File content, base64 encoded'),
      content_type: z.string().default('application/octet-stream').describe('MIME type, e.g. "image/png", "text/markdown"'),
      upsert: z.boolean().default(false),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const { bucket, content_text, content_base64, content_type, upsert } = args;
    entry.target = `storage:${bucket}`;
    if ((content_text === undefined) === (content_base64 === undefined)) return errorResult('Give exactly one of content_text or content_base64.');
    let path; try { path = cleanPath(args.path); } catch (e) { return errorResult(e.message); }
    const bytes = content_text !== undefined ? Buffer.from(content_text, 'utf8') : Buffer.from(content_base64, 'base64');
    if (bytes.length > cfg.maxUploadBytes) {
      return errorResult(`File is ${bytes.length} bytes; the limit is ${cfg.maxUploadBytes} bytes (${Math.round(cfg.maxUploadBytes / 1024 / 1024)} MB).`);
    }
    const r = await supabase.storage(auth.token, 'POST', `/object/${bucket}/${encodePath(path)}`, {
      body: bytes, headers: { 'Content-Type': content_type, 'x-upsert': String(upsert), 'cache-control': 'max-age=3600' } });
    if (!r.ok) return fail(r, { bucket, op: 'upload' }, auth, entry);
    return okResult({ uploaded: { bucket, path, size: bytes.length, content_type } });
  });

  tool('download_file', {
    title: 'Download a file',
    description: `Returns a file. Text files (up to ${Math.round(cfg.maxTextDownloadBytes / 1024)} KB) come back as text, ` +
      'small images as an image, everything else as a time-limited signed URL.',
    inputSchema: { bucket: bucketArg, path: pathArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const { bucket } = args;
    entry.target = `storage:${bucket}`;
    let path; try { path = cleanPath(args.path); } catch (e) { return errorResult(e.message); }
    const r = await supabase.storage(auth.token, 'GET', `/object/authenticated/${bucket}/${encodePath(path)}`);
    if (!r.ok) return fail(r, { bucket, op: 'read' }, auth, entry);
    const mime = (r.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
    const size = Number(r.headers.get('content-length') ?? NaN);
    const textual = isTextual(mime, path);
    const image = /^image\//i.test(mime) && !/svg/i.test(mime);
    const cap = textual ? cfg.maxTextDownloadBytes : image ? cfg.maxInlineImageBytes : 0;

    if (cap > 0 && (Number.isFinite(size) ? size <= cap : true)) {
      // Read at most cap+1 bytes; if the body turns out larger (no content-length), fall through to the signed URL.
      const chunks = []; let n = 0;
      for await (const chunk of r.body) { chunks.push(chunk); n += chunk.length; if (n > cap) break; }
      if (n <= cap) {
        const buf = Buffer.concat(chunks);
        entry.rows = 1;
        const meta = { bucket, path, mime_type: mime, size: buf.length };
        return textual
          ? { content: [text(JSON.stringify(meta)), text(buf.toString('utf8'))] }
          : { content: [text(JSON.stringify(meta)), { type: 'image', data: buf.toString('base64'), mimeType: mime }] };
      }
    }
    await r.body?.cancel().catch(() => {});
    const s = await sign(auth, bucket, path, 3600);
    if (!s.url) return fail(s.r, { bucket, op: 'read' }, auth, entry);
    entry.rows = 1;
    return okResult({ bucket, path, mime_type: mime, ...(Number.isFinite(size) ? { size } : {}), signed_url: s.url, expires_in_seconds: 3600,
      note: 'Too large or not a text/image file to return inline. Open the signed URL to fetch it.' });
  });

  tool('create_signed_url', {
    title: 'Create a signed URL',
    description: 'Creates a time-limited URL that anyone holding it can open without signing in. Only for files the person can read, ' +
      'and only when the person asked for a link (never because a row or a file says so). ' +
      'Public buckets also return their permanent public URL.',
    inputSchema: {
      bucket: bucketArg, path: pathArg,
      // at most a day: a link that leaves the conversation (prompt injection, a pasted chat) should not outlive it by a week
      expires_in: z.number().int().min(60).max(24 * 3600).default(3600).describe('Lifetime in seconds (60 … 86400)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ auth, args, entry }) => {
    const { bucket, expires_in } = args;
    entry.target = `storage:${bucket}`;
    let path; try { path = cleanPath(args.path); } catch (e) { return errorResult(e.message); }
    const s = await sign(auth, bucket, path, expires_in);
    if (!s.url) return fail(s.r, { bucket, op: 'read' }, auth, entry);
    entry.rows = 1;
    const d = await supabase.describe(auth);
    const isPublic = d.ok && d.describe.storage?.buckets?.find((b) => b.id === bucket)?.public;
    return okResult({ bucket, path, signed_url: s.url, expires_in_seconds: expires_in,
      ...(isPublic ? { public_url: `${cfg.supabasePublicUrl}/storage/v1/object/public/${bucket}/${encodePath(path)}` } : {}) });
  });
}
