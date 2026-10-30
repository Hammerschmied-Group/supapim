// Tool results: JSON text, size-capped so one `select *` over a vector column cannot flood the model.

export const text = (s) => ({ type: 'text', text: s });

export function okResult(data, { maxChars = 200_000, extra } = {}) {
  let body = { ...data };
  let s = JSON.stringify(body, null, 2);
  if (s.length > maxChars && Array.isArray(body.rows)) {
    const total = body.rows.length;
    let rows = body.rows;
    while (rows.length > 1 && s.length > maxChars) {
      rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
      s = JSON.stringify({ ...body, rows, truncated: true }, null, 2);
    }
    body = { ...body, rows, truncated: true,
      note: `Result too large: showing ${rows.length} of ${total} rows. Select fewer columns (not whole vector or text columns) or lower the limit.` };
    s = JSON.stringify(body, null, 2);
  }
  return { content: [text(s), ...(extra ?? [])] };
}

// An error the model can act on. `detail` is machine-readable context (Postgres error, http status).
export function errorResult(message, detail) {
  return { isError: true, content: [text(JSON.stringify({ error: message, ...detail }, null, 2))] };
}
