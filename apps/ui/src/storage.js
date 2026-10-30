// Storage API for image / file columns (ARCHITECTURE D8). Everything goes through the supabase-js
// client of src/providers.js, so every call carries the signed-in person's token and Storage
// applies the object policies of that role. The helpers at the top are pure (unit-tested).

/** Lifetime of signed URLs for private buckets. */
export const SIGNED_URL_SECONDS = 3600;

/** "Größe & Preis (1).PNG" → "Grosse-Preis-1.PNG": object names that survive URLs and every policy. */
export function sanitizeFileName(fullName) {
  const name = fullName.split(/[\\/]/).pop();   // never a path
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ''];
  const clean = (s) => s.replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 80);
  return `${clean(stem) || 'file'}${clean(ext) ? `.${clean(ext).toLowerCase()}` : ''}`;
}

/** "nordwind/fleece.png" → "nordwind"; "fleece.png" → "". */
export function directoryOf(path) {
  const i = (path ?? '').lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

/** Object path for an upload: <directory>/<clean file name>, with an optional suffix before the extension. */
export function objectPath({ directory, fileName, suffix = '' }) {
  const clean = sanitizeFileName(fileName);
  const dot = clean.lastIndexOf('.');
  const name = suffix ? (dot > 0 ? `${clean.slice(0, dot)}-${suffix}${clean.slice(dot)}` : `${clean}-${suffix}`) : clean;
  return directory ? `${directory.replace(/^\/+|\/+$/g, '')}/${name}` : name;
}

const isDuplicate = (error) => String(error?.statusCode ?? error?.status) === '409' || /already exists|duplicate/i.test(error?.message ?? '');

export function createStorage(supabase) {
  const bucket = (info) => supabase.storage.from(info.bucket);

  return {
    /**
     * URL for an <img>: imgproxy through /storage/v1/render/image/…, public URL for public buckets,
     * signed URL for private ones (which needs the person's select policy on the object).
     */
    async previewUrl(info, path, { width = 320, height = 320 } = {}) {
      const transform = { width, height, resize: 'contain' };
      if (info.public) return bucket(info).getPublicUrl(path, { transform }).data.publicUrl;
      const { data, error } = await bucket(info).createSignedUrl(path, SIGNED_URL_SECONDS, { transform });
      if (error) throw error;
      return data.signedUrl;
    },

    /** URL of the original file (opened in a new tab). */
    async fileUrl(info, path) {
      if (info.public) return bucket(info).getPublicUrl(path).data.publicUrl;
      const { data, error } = await bucket(info).createSignedUrl(path, SIGNED_URL_SECONDS);
      if (error) throw error;
      return data.signedUrl;
    },

    /**
     * Uploads a new object (never overwrites: that would need update rights and could replace a file
     * another row still uses). If the name is taken, a short suffix is added. Returns the object path.
     */
    async upload(info, file, { directory }) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const suffix = attempt === 0 ? '' : Math.random().toString(36).slice(2, 8);
        const path = objectPath({ directory, fileName: file.name, suffix });
        const { error } = await bucket(info).upload(path, file, { upsert: false, contentType: file.type || undefined });
        if (!error) return path;
        if (!isDuplicate(error)) throw error;
      }
      throw new Error('Could not find a free file name');
    },

    /**
     * Renames (moves) one object inside its bucket. Never overwrites: Storage answers 409 when the new name is
     * taken. Needs the update policy on the object; the rows that point at the old path are the caller's job.
     */
    async move(info, from, to) {
      const { error } = await bucket(info).move(from, to);
      if (!error) return;
      if (isDuplicate(error)) throw Object.assign(new Error('name_taken'), { code: 'name_taken' });
      throw error;
    },

    /** Removes one object. Storage answers 200 with an empty list when the policy hides the object. */
    async remove(info, path) {
      const { data, error } = await bucket(info).remove([path]);
      if (error) throw error;
      if (!data?.length) throw new Error('Storage did not remove the file (no permission or already gone)');
    },
  };
}
