// List with drag-and-drop ordering, for a table with an order column (position, sort_order …) that the role may
// update (model.js: r.canReorder). Rows are dragged by their handle; the new order is written at once as
// consecutive values, with the person's token, only for rows whose value changes. Keyboard: focus a handle,
// ArrowUp / ArrowDown. Ordering is offered only in the plain list — sorted by the order column, no filter — so
// "before" and "after" mean the same to the person and to the database.
import { useEffect, useState } from 'react';
import {
  RecordContextProvider, useCreatePath, useDataProvider, useListContext, useNotify, useTranslate,
} from 'react-admin';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, CircularProgress, IconButton, Table, TableBody, TableCell, TableHead, TableRow, Tooltip } from '@mui/material';
import { DragHandleIcon } from './icons.jsx';
import { renderField } from './fields.jsx';

export function SortableTable({ model, r, names }) {
  const { data, isPending, refetch, filterValues, sort, page, perPage } = useListContext();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const t = useTranslate();
  const navigate = useNavigate();
  const createPath = useCreatePath();
  const [rows, setRows] = useState(data ?? []);
  const [dragging, setDragging] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRows(data ?? []); }, [data]);
  const pk = r.primaryKey[0];
  const order = r.orderColumn;
  const enabled = Object.keys(filterValues ?? {}).length === 0 && sort?.field === order && sort?.order === 'ASC';
  const base = (page - 1) * perPage;
  const cols = names.map((n) => r.columns.find((c) => c.name === n)).filter(Boolean);

  const persist = async (next) => {
    setBusy(true);
    try {
      for (const [i, row] of next.entries()) {
        if (Number(row[order]) !== base + i) {
          await dataProvider.update(r.name, { id: row[pk], data: { [order]: base + i }, previousData: row });
        }
      }
      notify(t('cms.sortable.saved', { _: 'Order saved' }), { type: 'info' });
    } catch (err) {
      notify(err?.message ?? String(err), { type: 'error' });
    }
    setBusy(false);
    refetch();
  };
  const moveTo = (list, from, to) => { const next = [...list]; const [row] = next.splice(from, 1); next.splice(to, 0, row); return next; };
  const open = (row) => navigate(createPath({ resource: r.name, id: row[pk], type: r.canEdit ? 'edit' : 'show' }));

  if (isPending) return <CircularProgress size={24} sx={{ m: 2 }} />;
  return (
    <Box data-testid="sortable-list">
      {!enabled && (
        <Alert severity="info" sx={{ m: 1 }} data-testid="sortable-off">
          {t('cms.sortable.off', { _: 'To change the order, remove the filters and sort by %{column}.', column: r.columns.find((c) => c.name === order)?.label ?? order })}
        </Alert>
      )}
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell padding="checkbox" />
            {cols.map((c) => <TableCell key={c.name}>{c.label}</TableCell>)}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={row[pk]} hover data-testid="sortable-row" data-id={row[pk]}
              sx={{ cursor: 'pointer', opacity: dragging === row[pk] ? 0.4 : 1 }}
              onClick={() => open(row)}
              onDragOver={(e) => {
                if (!enabled || dragging == null) return;
                e.preventDefault();
                const from = rows.findIndex((x) => x[pk] === dragging);
                if (from !== i) setRows(moveTo(rows, from, i));
              }}
              onDrop={(e) => { e.preventDefault(); }}>
              <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                {enabled && (
                  <Tooltip title={t('cms.sortable.handle', { _: 'Drag to reorder (or focus and use the arrow keys)' })}>
                    <IconButton size="small" draggable disabled={busy} data-testid="sortable-handle" sx={{ cursor: 'grab' }}
                      aria-label={t('cms.sortable.handle', { _: 'Drag to reorder (or focus and use the arrow keys)' })}
                      onDragStart={(e) => { setDragging(row[pk]); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(row[pk])); }}
                      onDragEnd={() => { setDragging(null); if (rows.some((x, k) => x !== data[k])) persist(rows); }}
                      onKeyDown={(e) => {
                        const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : null;
                        if (to == null || to < 0 || to >= rows.length) return;
                        e.preventDefault();
                        const next = moveTo(rows, i, to);
                        setRows(next);
                        persist(next);
                      }}>
                      <DragHandleIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </TableCell>
              {cols.map((c) => (
                <TableCell key={c.name}>
                  <RecordContextProvider value={row}>{renderField(model, c, { inList: true })}</RecordContextProvider>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
