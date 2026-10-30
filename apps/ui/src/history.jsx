// Change log of one record (audit.change_log through cms_api.record_history), at the bottom of the Edit and
// Show views. Shown only when the role may read it: whoami().can_read_audit (SELECT on audit.change_log,
// or an admin role). The database enforces that again; a refusal just hides the panel.
import { useContext, useEffect, useState } from 'react';
import { usePermissions, useRecordContext } from 'react-admin';
import { Box, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { ApiContext } from './api.js';
import { summarizeChange, whoChanged } from './format.js';

export function HistoryTable({ entries, table }) {
  if (!entries.length) return <Typography variant="body2" color="text.secondary" data-testid="history-empty">No changes recorded.</Typography>;
  return (
    <Table size="small" data-testid="history-table">
      <TableHead>
        <TableRow><TableCell>When</TableCell><TableCell>Who</TableCell><TableCell>Change</TableCell></TableRow>
      </TableHead>
      <TableBody>
        {entries.map((e) => (
          <TableRow key={e.id} data-testid="history-row">
            <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString()}</TableCell>
            <TableCell data-testid="history-who">{whoChanged(e)}{e.jwt_client_id ? ` · ${e.jwt_client_id}` : ''}</TableCell>
            <TableCell>{summarizeChange(e, table).map((l, i) => <Box key={i} sx={{ fontFamily: 'monospace', fontSize: 13 }}>{l}</Box>)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Loads the history of `rowKey` ({pkColumn: value}) of `table` ("schema.table"). `null` = not readable. */
export function useHistory(table, rowKey, enabled = true) {
  const api = useContext(ApiContext);
  const [state, setState] = useState({ entries: null, error: null });
  const keyJson = JSON.stringify(rowKey);
  useEffect(() => {
    if (!enabled || !api || !rowKey) return undefined;
    let live = true;
    api.rpc('record_history', { table_name: table, row_key: rowKey, max_rows: 20 })
      .then((entries) => live && setState({ entries, error: null }))
      .catch((error) => live && setState({ entries: null, error }));
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, table, keyJson, enabled]);
  return state;
}

export function RecordHistory({ resource }) {
  const record = useRecordContext();
  const model = usePermissions().permissions;
  const enabled = Boolean(model?.canReadAudit && resource.primaryKey && record);
  const rowKey = enabled ? Object.fromEntries(resource.primaryKey.map((k) => [k, record[k]])) : null;
  const { entries, error } = useHistory(resource.name, rowKey, enabled);
  if (!enabled || error?.code === '42501' || (!entries && !error)) return null;
  return (
    <Box sx={{ mt: 3, width: '100%' }} data-testid="record-history">
      <Typography variant="h6" gutterBottom>Change history</Typography>
      {error ? <Typography color="error">{error.message}</Typography> : <HistoryTable entries={entries} table={resource.name} />}
    </Box>
  );
}
