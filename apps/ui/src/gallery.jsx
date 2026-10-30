// Image gallery inside a parent record (e.g. a product's images): a child table that points at the parent
// with a foreign key and has an image column (@cms(image, bucket=…)) is edited right in the parent's form —
// add several images at once, edit alt text and title, reorder, remove — instead of a separate list.
// Every action is written at once through the data provider with the person's token; the child table's
// grants decide which controls appear (insert → add, update per column → edit, delete → remove), and
// Postgres / Storage still check each request.
import { useContext, useEffect, useState } from 'react';
import {
  useDataProvider, useGetManyReference, useNotify, usePermissions, useRecordContext, useTranslate,
} from 'react-admin';
import { Link } from 'react-router-dom';
import {
  Box, Button, Card, CardActions, CardContent, CircularProgress, IconButton, TextField, Tooltip, Typography,
} from '@mui/material';
import { AddImageIcon, DeleteIcon, FolderOpenIcon, MoveLeftIcon, MoveRightIcon, OpenInNewIcon } from './icons.jsx';
import { MONO } from './theme.js';
import { ExistingFileDialog, Preview, RenameFileButton, StorageContext, linkFor } from './fields.jsx';
import { ApiContext } from './api.js';
import { ORDER_COLUMNS } from './model.js';

/**
 * The gallery shape of an incoming foreign key, or null: the child has a readable primary key and an image
 * column, so it can be shown as cards. Its order column (position / sort_order / …) is used when present.
 */
export function galleryOf(model, ref) {
  const child = model.byName[ref.resource];
  if (!child?.primaryKey || child.primaryKey.length !== 1) return null;
  const image = child.columns.find((c) => c.storage?.kind === 'image' && c.storage.known);
  if (!image) return null;
  const col = (name) => (name ? child.columns.find((c) => c.name === name) : null);
  const order = child.columns.find((c) => ORDER_COLUMNS.includes(c.name) && c.category === 'number');
  // a new card only needs the foreign key, the path and the order; anything else must have a default or be nullable
  const filled = new Set([ref.column, image.name, order?.name]);
  const columnsInsertable = !!col(ref.column)?.canInsert && child.columns.every((c) => filled.has(c.name) || c.nullable || c.hasDefault);
  return { child, fk: ref.column, image, alt: col(image.storage.alt), title: col(image.storage.title), order, label: ref.label, columnsInsertable };
}

/** One image: preview, alt text / title (saved when the field is left), move, open, remove. */
function ImageCard({ g, row, index, count, busy, onMove, onRemove, onSaved }) {
  const model = usePermissions().permissions;
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const t = useTranslate();
  const info = g.image.storage;
  const id = row[g.child.primaryKey[0]];
  const [texts, setTexts] = useState({ alt: row[g.alt?.name] ?? '', title: row[g.title?.name] ?? '' });
  useEffect(() => { setTexts({ alt: row[g.alt?.name] ?? '', title: row[g.title?.name] ?? '' }); }, [row, g.alt?.name, g.title?.name]);

  const save = async (which, column) => {
    if (!column || (row[column.name] ?? '') === texts[which]) return;
    try {
      await dataProvider.update(g.child.name, { id, data: { [column.name]: texts[which] }, previousData: row });
      notify(t('cms.gallery.saved', { _: 'Saved' }), { type: 'info' });
      onSaved();
    } catch (err) {
      notify(err?.message ?? String(err), { type: 'error' });
      setTexts((s) => ({ ...s, [which]: row[column.name] ?? '' }));
    }
  };
  const textField = (which, column) => column && (
    <TextField size="small" fullWidth margin="dense" label={column.label} value={texts[which]}
      disabled={!column.canUpdate || busy} onChange={(e) => setTexts((s) => ({ ...s, [which]: e.target.value }))}
      onBlur={() => save(which, column)} inputProps={{ 'data-testid': `gallery-${which}` }}
      // Enter saves this field instead of submitting the record's form around the gallery
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.querySelector('input')?.blur(); } }} />
  );
  const canMove = g.order?.canUpdate && g.child.canEdit;
  return (
    <Card variant="outlined" sx={{ width: 260 }} data-testid="gallery-card" data-path={row[g.image.name]}>
      <Box sx={{ display: 'flex', justifyContent: 'center', pt: 1 }}>
        <Preview info={info} path={row[g.image.name]} alt={texts.alt} title={texts.title || undefined} size={200} />
      </Box>
      <CardContent sx={{ py: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all', fontFamily: MONO, display: 'block' }}>{row[g.image.name]}</Typography>
        {textField('alt', g.alt)}
        {textField('title', g.title)}
      </CardContent>
      <CardActions sx={{ pt: 0 }}>
        {canMove && (
          <>
            <Tooltip title={t('cms.gallery.move_left', { _: 'Move left' })}>
              <span><IconButton size="small" disabled={busy || index === 0} onClick={() => onMove(index, -1)} data-testid="gallery-move-left"><MoveLeftIcon fontSize="small" /></IconButton></span>
            </Tooltip>
            <Tooltip title={t('cms.gallery.move_right', { _: 'Move right' })}>
              <span><IconButton size="small" disabled={busy || index === count - 1} onClick={() => onMove(index, 1)} data-testid="gallery-move-right"><MoveRightIcon fontSize="small" /></IconButton></span>
            </Tooltip>
          </>
        )}
        <Box sx={{ flex: 1 }} />
        {g.image.canUpdate && g.child.canEdit && <RenameFileButton icon info={info} path={row[g.image.name]} disabled={busy} onDone={onSaved} />}
        <Tooltip title={t('cms.gallery.open_record', { _: 'All fields' })}>
          <IconButton size="small" component={Link} to={`/${g.child.name}/${encodeURIComponent(id)}${linkFor(model, g.child.name) === 'show' ? '/show' : ''}`}>
            <OpenInNewIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {g.child.canDelete && (
          <Tooltip title={t('cms.gallery.remove', { _: 'Remove image' })}>
            <span><IconButton size="small" color="error" disabled={busy} onClick={() => onRemove(row)} data-testid="gallery-remove"><DeleteIcon fontSize="small" /></IconButton></span>
          </Tooltip>
        )}
      </CardActions>
    </Card>
  );
}

/** The gallery of one parent record (edit or show view). */
export function Gallery({ g, parentKey, readOnly = false }) {
  const parent = useRecordContext();
  const model = usePermissions().permissions;
  const dataProvider = useDataProvider();
  const storage = useContext(StorageContext);
  const api = useContext(ApiContext);
  const notify = useNotify();
  const t = useTranslate();
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const parentId = parent?.[parentKey];
  const sortField = g.order?.name ?? g.child.primaryKey[0];
  const { data = [], isPending, refetch } = useGetManyReference(g.child.name, {
    target: g.fk, id: parentId, pagination: { page: 1, perPage: 200 }, sort: { field: sortField, order: 'ASC' },
  }, { enabled: parentId != null });
  const info = g.image.storage;
  const canAdd = !readOnly && g.child.canCreate && g.image.canInsert && g.columnsInsertable;
  const canUpload = canAdd && info.insert;
  const nextOrder = () => (g.order ? Math.max(-1, ...data.map((r) => Number(r[g.order.name]) || 0)) + 1 : null);

  const createRow = async (path, order) => {
    const row = { [g.fk]: parentId, [g.image.name]: path };
    if (g.order?.canInsert && order != null) row[g.order.name] = order;
    await dataProvider.create(g.child.name, { data: row });
  };

  const addFiles = async (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    let order = nextOrder();
    let added = 0;
    for (const file of files) {
      let path = null;
      try {
        path = await storage.upload(info, file, { directory: g.child.schema });
        await createRow(path, order);
        order = order == null ? null : order + 1;
        added += 1;
      } catch (err) {
        // the row was not written: the file would be referenced by nothing, take it back
        if (path && info.delete) await storage.remove(info, path).catch(() => {});
        notify(`${file.name}: ${err?.message ?? String(err)}`, { type: 'error' });
      }
    }
    if (added) notify(t('cms.gallery.added', { _: '%{smart_count} image added |||| %{smart_count} images added', smart_count: added }), { type: 'info' });
    setBusy(false);
    refetch();
  };

  const addExisting = async (path) => {
    setPicking(false);
    setBusy(true);
    try { await createRow(path, nextOrder()); refetch(); } catch (err) { notify(err?.message ?? String(err), { type: 'error' }); }
    setBusy(false);
  };

  // swap with the neighbour; positions are rewritten as 0..n-1 where they differ, so duplicates sort out too
  const move = async (index, delta) => {
    const rows = [...data];
    const [row] = rows.splice(index, 1);
    rows.splice(index + delta, 0, row);
    setBusy(true);
    try {
      for (const [i, r] of rows.entries()) {
        if (Number(r[g.order.name]) !== i) {
          await dataProvider.update(g.child.name, { id: r[g.child.primaryKey[0]], data: { [g.order.name]: i }, previousData: r });
        }
      }
    } catch (err) { notify(err?.message ?? String(err), { type: 'error' }); }
    setBusy(false);
    refetch();
  };

  const remove = async (row) => {
    if (!window.confirm(t('cms.gallery.remove_confirm', { _: 'Remove this image from the record?' }))) return;
    setBusy(true);
    const path = row[g.image.name];
    try {
      await dataProvider.delete(g.child.name, { id: row[g.child.primaryKey[0]], previousData: row });
      // the file goes too when no other row uses it — only admins can tell (unreferenced_files); otherwise
      // it stays and shows up in Admin → "Files without a record"
      if (model?.isAdmin && info.delete) {
        const unused = await api.rpc('unreferenced_files', { bucket: info.bucket }).catch(() => []);
        if (unused.some((f) => f.name === path)) await storage.remove(info, path).catch(() => {});
      }
      notify(t('cms.gallery.removed', { _: 'Image removed' }), { type: 'info' });
    } catch (err) { notify(err?.message ?? String(err), { type: 'error' }); }
    setBusy(false);
    refetch();
  };

  if (parentId == null) return null;
  return (
    <Box sx={{ width: '100%', mb: 2 }} data-testid={`gallery-${g.child.name}`}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ mr: 1 }}>{g.label}</Typography>
        {canUpload && (
          <Button component="label" variant="outlined" size="small" startIcon={<AddImageIcon fontSize="small" />} disabled={busy}>
            {t('cms.gallery.add', { _: 'Add images' })}
            <input hidden type="file" multiple accept="image/*" data-testid="gallery-input" onChange={addFiles} />
          </Button>
        )}
        {canAdd && model?.isAdmin && (
          <Button size="small" startIcon={<FolderOpenIcon fontSize="small" />} disabled={busy} onClick={() => setPicking(true)} data-testid="gallery-pick-existing">
            {t('cms.storage.choose_existing', { _: 'Existing file' })}
          </Button>
        )}
        {busy && <CircularProgress size={18} />}
      </Box>
      {isPending ? <CircularProgress size={24} /> : data.length === 0 ? (
        <Typography variant="body2" color="text.secondary" data-testid="gallery-empty">{t('cms.gallery.empty', { _: 'No images yet.' })}</Typography>
      ) : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {data.map((row, i) => (
            <ImageCard key={row[g.child.primaryKey[0]]} g={readOnly ? { ...g, child: { ...g.child, canDelete: false, canEdit: false } } : g}
              row={row} index={i} count={data.length} busy={busy || readOnly} onMove={move} onRemove={remove} onSaved={refetch} />
          ))}
        </Box>
      )}
      {picking && <ExistingFileDialog info={info} onPick={addExisting} onClose={() => setPicking(false)} />}
    </Box>
  );
}

/** Hint in the create form: the gallery needs the record's key, so images come after the first save. */
export function GalleryAfterSaveHint({ g }) {
  const t = useTranslate();
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }} data-testid="gallery-after-save">
      {g.label}: {t('cms.gallery.after_save', { _: 'images can be added after the first save.' })}
    </Typography>
  );
}
