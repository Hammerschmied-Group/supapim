// Access log of the admin API: one JSON line per request on stdout. A fixed field list: who (verified
// token claims; for 401 nobody), what, on whom, outcome. Never tokens, keys, links or request bodies.
const FIELDS = ['sub', 'email', 'role', 'action', 'target', 'status', 'code', 'delivery', 'ms'];

export function adminLogLine(entry, now = new Date()) {
  const line = { type: 'admin_access', ts: now.toISOString() };
  for (const k of FIELDS) if (entry[k] !== undefined && entry[k] !== null) line[k] = entry[k];
  return JSON.stringify(line);
}
export const logAdmin = (entry, out = process.stdout) => out.write(adminLogLine(entry) + '\n');
