// Pure helpers for the admin area and the change log (no React): unit-tested in test/format.test.js.

const clip = (v, n = 80) => {
  if (v == null) return '∅';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * One change-log row (audit.change_log, as returned by cms_api.record_history) → readable lines.
 * UPDATE: one line per column "col: old → new". INSERT / DELETE: one line. Role assignments
 * (table cms.user_roles) are phrased as such.
 */
export function summarizeChange(entry, table = '') {
  const c = entry.changes ?? {};
  if (table === 'cms.user_roles') {
    const who = c.email ?? 'the person';
    if (entry.op === 'INSERT') return [`assigned role ${c.db_role} to ${who}`];
    if (entry.op === 'DELETE') return [`removed role ${c.db_role} from ${who}`];
    return [`changed the role of ${who}: ${c.db_role?.old} → ${c.db_role?.new}`];
  }
  if (entry.op === 'INSERT') return ['created'];
  if (entry.op === 'DELETE') return ['deleted'];
  return Object.entries(c).map(([col, v]) => `${col}: ${clip(v?.old)} → ${clip(v?.new)}`);
}

/** The person behind a change: JWT e-mail, else the database role (e.g. a direct SQL session). */
export const whoChanged = (entry) => entry.jwt_email || `${entry.db_role} (no sign-in)`;

/**
 * effective_rights(role) / describe() → what an admin wants to see per role: one row per table with
 * its privileges and the updatable columns, plus the storage buckets.
 */
export function summarizeRights(rights) {
  const tables = [];
  for (const s of rights?.schemas ?? []) {
    for (const t of s.tables ?? []) {
      const cols = t.columns ?? [];
      tables.push({
        name: `${s.name}.${t.name}`,
        kind: t.kind,
        select: !!t.privileges?.select, insert: !!t.privileges?.insert, update: !!t.privileges?.update, delete: !!t.privileges?.delete,
        updatableColumns: cols.filter((c) => c.privileges?.update).map((c) => c.name),
        readOnlyColumns: cols.filter((c) => c.privileges?.select && !c.privileges?.update).map((c) => c.name),
        rls: !!t.rls?.enabled,
        policies: (t.rls?.policies ?? []).length,
      });
    }
  }
  const storage = rights?.storage ?? {};
  return {
    role: rights?.role,
    tables,
    buckets: (storage.buckets ?? []).map((b) => ({ id: b.id, public: !!b.public, policies: (b.object_policies ?? []).length })),
    objectPrivileges: storage.object_privileges ?? null,
  };
}

/** Status of a person from list_users(): blocked > invited (not signed in yet) > active. */
export function userStatus(u, now = Date.now()) {
  if (u.banned_until && new Date(u.banned_until).getTime() > now) return 'blocked';
  if (!u.last_sign_in_at) return 'invited';
  return 'active';
}
