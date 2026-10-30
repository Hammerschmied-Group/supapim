// Access log: one JSON object per tool call on stdout. Time, who, which client, which tool, which
// table/bucket/function, outcome. Deliberately a fixed field list: never data values, never tokens,
// never request arguments.

const FIELDS = ['sub', 'email', 'role', 'client_id', 'tool', 'target', 'status', 'rows', 'code', 'ms'];

export function accessLogLine(entry, now = new Date()) {
  const line = { type: 'access', ts: now.toISOString() };
  for (const k of FIELDS) if (entry[k] !== undefined && entry[k] !== null) line[k] = entry[k];
  return JSON.stringify(line);
}

export function logAccess(entry, out = process.stdout) {
  out.write(accessLogLine(entry) + '\n');
}
