// One field (list/show) and one input (create/edit) per column widget, see model.js widgetFor().
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  AutocompleteInput, BooleanField, BooleanInput, DateField, DateInput, DateTimeInput, FunctionField,
  Labeled, NullableBooleanInput, NumberField, NumberInput, ReferenceField, ReferenceInput, RichTextField,
  SelectArrayInput, SelectInput, TextArrayInput, TextField, TextInput, required, useDataProvider, useLocaleState, useNotify,
  usePermissions, useRecordContext, useTranslate,
} from 'react-admin';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemText,
  TextField as MuiTextField, Typography,
} from '@mui/material';
import { useFormContext, useFormState } from 'react-hook-form';
import { RichTextInput } from 'ra-input-rich-text';
import { directoryOf, objectPath, sanitizeFileName } from './storage.js';
import { ApiContext } from './api.js';
import { FolderOpenIcon, OpenInNewIcon, RenameIcon, UndoIcon, UploadIcon } from './icons.jsx';
import { MONO } from './theme.js';

const truncate = (s, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
const jsonText = (v) => (v == null ? '' : JSON.stringify(v, null, 2));

/** Marks text in a JSON input that does not parse yet, so validation can name it. */
class InvalidJson { constructor(text) { this.text = text; } }
const jsonInputProps = {
  format: (v) => (v instanceof InvalidJson ? v.text : jsonText(v)),
  parse: (s) => { if (!s.trim()) return null; try { return JSON.parse(s); } catch { return new InvalidJson(s); } },
  validate: (v) => (v instanceof InvalidJson ? 'cms.validation.invalid_json' : undefined),
};

// ── image / file columns (D8): preview, upload and alt text / title in one field ─────────────────
/** The Storage API of src/storage.js, provided by <App>. */
export const StorageContext = createContext(null);

/**
 * Files chosen in a create / edit form wait here until the form is saved (column → { file, info, directory }),
 * so a form that is left or fails validation never leaves an upload behind.
 */
export const PendingUploadsContext = createContext(null);

/**
 * For <Create> / <Edit>: transform uploads the pending files right before the row is written and puts their
 * final paths into the data; if writing the row fails, onError removes exactly those uploads again (needs the
 * delete policy; otherwise they show up in Admin → "Files without a record").
 */
export function useDeferredUploads() {
  const storage = useContext(StorageContext);
  const notify = useNotify();
  const pending = useRef(new Map());
  const justUploaded = useRef([]);
  const takeBack = async (list) => {
    for (const u of list) if (u.info.delete) await storage.remove(u.info, u.path).catch(() => {});
  };
  const transform = async (data) => {
    const out = { ...data };
    const uploaded = [];
    try {
      for (const [column, p] of pending.current) {
        const path = await storage.upload(p.info, p.file, { directory: p.directory });
        uploaded.push({ info: p.info, path });
        out[column] = path;
      }
    } catch (err) {
      await takeBack(uploaded);
      notify(err?.message ?? String(err), { type: 'error' });
      throw err;
    }
    justUploaded.current = uploaded;
    return out;
  };
  const onError = async (error) => {
    const list = justUploaded.current;
    justUploaded.current = [];
    await takeBack(list);
    notify(typeof error === 'string' ? error : error?.message || 'ra.notification.http_error', { type: 'error' });
  };
  return { pending, transform, onError };
}

/** Opens the original file in a new tab (signed URL for private buckets). */
function OpenFileButton({ info, path }) {
  const storage = useContext(StorageContext);
  const notify = useNotify();
  const t = useTranslate();
  return (
    <Button size="small" startIcon={<OpenInNewIcon fontSize="small" />} data-testid="open-file"
      onClick={() => storage.fileUrl(info, path).then((url) => window.open(url, '_blank', 'noopener'))
        .catch((e) => notify(e.message, { type: 'error' }))}>
      {t('cms.storage.open', { _: 'Open' })}
    </Button>
  );
}

/**
 * Thumbnail of an image column. imgproxy resizes it on the way (render/image); a private bucket gets
 * a signed URL. Shown only if the role can actually read the object (bucket visible, public or select policy).
 */
export function Preview({ info, path, alt = '', title, size = 160, localUrl = null }) {
  const storage = useContext(StorageContext);
  const t = useTranslate();
  const canPreview = !localUrl && info.kind === 'image' && info.known && (info.public || info.select) && !!path;
  const [state, setState] = useState({ url: null, failed: false });
  useEffect(() => {
    let live = true;
    setState({ url: null, failed: false });
    if (!canPreview) return undefined;
    storage.previewUrl(info, path, { width: size * 2, height: size * 2 })
      .then((url) => live && setState({ url, failed: false }))
      .catch(() => live && setState({ url: null, failed: true }));
    return () => { live = false; };
  }, [storage, info.bucket, info.public, canPreview, path, size]);   // eslint-disable-line react-hooks/exhaustive-deps
  const box = { width: size, height: size, flex: 'none', border: 1, borderColor: 'divider', borderRadius: 1,
    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', bgcolor: 'action.hover' };
  if (info.kind !== 'image') return null;
  if (localUrl) {
    return (
      <Box sx={box}>
        <img data-testid="image-preview-local" src={localUrl} alt={alt ?? ''} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      </Box>
    );
  }
  if (state.url) {
    return (
      <Box sx={box}>
        <img data-testid="image-preview" src={state.url} alt={alt ?? ''} title={title || undefined}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          onError={() => setState({ url: null, failed: true })} />
      </Box>
    );
  }
  return (
    <Box sx={box} data-testid="image-placeholder">
      <Typography variant="caption" color="text.secondary" align="center">
        {!path ? t('cms.storage.none', { _: 'No image' }) : t('cms.storage.no_preview', { _: 'No preview' })}
      </Typography>
    </Box>
  );
}

/** Read-only display (show view, list cell). Alt text and title come from the sibling columns of the same row. */
function StorageField({ c, inList }) {
  const rec = useRecordContext();
  const t = useTranslate();
  if (!rec) return null;
  const info = c.storage;
  const path = rec[c.name];
  if (inList) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Preview info={info} path={path} size={40} />
        <span>{path}</span>
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
      <Preview info={info} path={path} alt={info.alt ? rec[info.alt] : ''} title={info.title ? rec[info.title] : undefined} />
      <Box>
        <Typography variant="body2">{path}</Typography>
        {info.alt && <Typography variant="body2" color="text.secondary">{t('cms.storage.alt', { _: 'Alt text' })}: {rec[info.alt] ?? '—'}</Typography>}
        {info.title && <Typography variant="body2" color="text.secondary">{t('cms.storage.title', { _: 'Title' })}: {rec[info.title] ?? '—'}</Typography>}
        {path && info.kind === 'file' && <OpenFileButton info={info} path={path} />}
      </Box>
    </Box>
  );
}

/**
 * Input for an image / file column. Three columns, three privileges: the object path (plus the
 * upload button) needs insert/update on the path column and an insert policy in the bucket; alt
 * text and title are ordinary inputs that follow their own column grants. So an agency that may
 * only update alt_text / title_attr sees the preview and edits the texts, without an upload button.
 * A chosen file is only uploaded when the form is saved (useDeferredUploads); admins can also pick a
 * file that is already in the bucket and that no row uses yet.
 */
const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif,image/avif';

function StorageInput({ model, r, c, mode }) {
  const notify = useNotify();
  const t = useTranslate();
  const { watch, setValue } = useFormContext();
  const pathError = !!useFormState({ name: c.name }).errors?.[c.name];
  const info = c.storage;
  const writable = mode === 'create' ? c.canInsert : c.canUpdate && !r.primaryKey?.includes(c.name);
  const canUpload = writable && info.known && info.insert;
  const value = watch(c.name) ?? '';
  const pending = useContext(PendingUploadsContext);
  const isAdmin = !!usePermissions().permissions?.isAdmin;
  // the file chosen in this form, not uploaded yet: { url (local preview), name, previous (value before) }
  const [chosen, setChosen] = useState(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => () => { if (chosen?.url) URL.revokeObjectURL(chosen.url); }, [chosen]);
  const sibling = (name) => (name ? r.columns.find((x) => x.name === name) : null);
  const altCol = sibling(info.alt);
  const titleCol = sibling(info.title);
  const set = (path) => setValue(c.name, path, { shouldDirty: true, shouldTouch: true, shouldValidate: true });

  function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const previous = chosen ? chosen.previous : value;
    const directory = directoryOf(previous) || r.schema;
    pending.current.set(c.name, { file, info, directory });
    setChosen({ url: info.kind === 'image' ? URL.createObjectURL(file) : null, name: file.name, previous });
    // the path the upload will most likely get; transform replaces it with the real one on save
    set(objectPath({ directory, fileName: file.name }));
    notify(t('cms.storage.selected', { _: '%{name} selected — it is uploaded when you save', name: file.name }), { type: 'info' });
  }

  function discard() {
    pending.current.delete(c.name);
    set(chosen.previous);
    setChosen(null);
  }

  function pick(path) {
    pending.current.delete(c.name);
    setChosen(null);
    set(path);
    setPicking(false);
  }

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap', width: '100%', mb: 1 }} data-testid={`storage-${c.name}`}>
      <Preview info={info} path={value} localUrl={chosen?.url} alt={altCol ? watch(altCol.name) : ''} title={titleCol ? watch(titleCol.name) : undefined} />
      <Box sx={{ flex: 1, minWidth: 280 }}>
        {/* The path is never typed: upload, replace, existing file and rename set it. The input stays (hidden) so
            the value and the "required" check are part of the form. */}
        <Box sx={{ display: 'none' }}>{renderInput(model, r, { ...c, widget: 'text' }, mode)}</Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, wordBreak: 'break-all', fontFamily: MONO }} data-testid="storage-path">
          {value ? `${info.bucket}/${value}` : t('cms.storage.none_chosen', { _: 'No file chosen yet.' })}
        </Typography>
        {pathError && (
          <Typography variant="caption" color="error" component="p" sx={{ mb: 1 }} data-testid="storage-path-error">
            {info.kind === 'image' ? t('cms.storage.required_image', { _: 'Please add an image.' }) : t('cms.storage.required_file', { _: 'Please add a file.' })}
          </Typography>
        )}
        {(canUpload || (value && info.kind === 'file') || (mode === 'edit' && writable && value && info.update)) && (
          <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
            {canUpload && (
              <Button component="label" variant="outlined" size="small" startIcon={<UploadIcon fontSize="small" />}>
                {value ? t('cms.storage.replace', { _: 'Replace' }) : t('cms.storage.upload', { _: 'Upload' })}
                {/* raster images only: an SVG opened from its storage URL runs script on that origin (docs/security F-02) */}
                <input hidden type="file" accept={info.kind === 'image' ? IMAGE_TYPES : undefined} data-testid="upload-input" onChange={onFile} />
              </Button>
            )}
            {canUpload && isAdmin && (
              <Button size="small" startIcon={<FolderOpenIcon fontSize="small" />} onClick={() => setPicking(true)} data-testid="pick-existing">
                {t('cms.storage.choose_existing', { _: 'Existing file' })}
              </Button>
            )}
            {chosen && (
              <Button size="small" startIcon={<UndoIcon fontSize="small" />} onClick={discard} data-testid="undo-upload">
                {t('cms.storage.discard', { _: 'Discard selection' })}
              </Button>
            )}
            {value && !chosen && info.kind === 'file' && <OpenFileButton info={info} path={value} />}
            {mode === 'edit' && writable && value && !chosen && (
              <RenameFileButton info={info} path={value}
                onDone={(p) => { setValue(c.name, p, { shouldDirty: false }); notify(t('cms.storage.renamed', { _: 'Renamed to %{path}', path: p }), { type: 'info' }); }} />
            )}
          </Box>
        )}
        {canUpload && info.public && (
          <Typography variant="caption" color="warning.main" component="p" sx={{ mt: -1, mb: 1 }} data-testid="bucket-public">
            {t('cms.storage.public_bucket', { _: 'Public bucket: anyone with the link can open this file, without signing in.' })}
          </Typography>
        )}
        {chosen && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: -1, mb: 2 }} data-testid="upload-pending">
            {t('cms.storage.pending', { _: 'Not uploaded yet: %{name} is uploaded when you save.', name: chosen.name })}
          </Typography>
        )}
        {altCol && renderInput(model, r, altCol, mode)}
        {titleCol && renderInput(model, r, titleCol, mode)}
      </Box>
      {picking && <ExistingFileDialog info={info} onPick={pick} onClose={() => setPicking(false)} />}
    </Box>
  );
}

/** Admins: choose a file that is already in the bucket and that no row uses yet (cms_api.unreferenced_files). */
export function ExistingFileDialog({ info, onPick, onClose }) {
  const api = useContext(ApiContext);
  const t = useTranslate();
  const [state, setState] = useState({ files: null, error: null });
  useEffect(() => {
    let live = true;
    api.rpc('unreferenced_files', { bucket: info.bucket })
      .then((files) => live && setState({ files, error: null }))
      .catch((error) => live && setState({ files: null, error }));
    return () => { live = false; };
  }, [api, info.bucket]);
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth data-testid="existing-files">
      <DialogTitle>{t('cms.storage.existing_title', { _: 'Files no record uses yet' })}</DialogTitle>
      <DialogContent>
        {!state.files && !state.error && <CircularProgress size={24} />}
        {state.error && <Alert severity="error">{state.error.message}</Alert>}
        {state.files?.length === 0 && <Typography color="text.secondary">{t('cms.storage.existing_none', { _: 'There are no unused files in this bucket.' })}</Typography>}
        {state.files?.length > 0 && (
          <List dense>
            {state.files.map((f) => (
              <ListItemButton key={f.name} onClick={() => onPick(f.name)} data-testid="existing-file" data-path={f.name} sx={{ gap: 2 }}>
                <Preview info={info} path={f.name} size={56} />
                <ListItemText primary={f.name}
                  secondary={`${f.size != null ? `${Math.round(f.size / 1024)} KB · ` : ''}${new Date(f.created_at).toLocaleString()}`} />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renames a file in its bucket (the folder stays) and moves every row that points at it along: the object is
 * moved in Storage, then each referencing row's path column is updated with the person's token. Refused when a
 * referencing row is invisible to the person or its path column is not theirs to change — those rows would
 * break. If an update fails, the rows already changed and the object are put back.
 * Rights: the bucket's update policy (move) and update on every referencing path column.
 */
export function RenameFileDialog({ info, path, onDone, onClose }) {
  const api = useContext(ApiContext);
  const storage = useContext(StorageContext);
  const dataProvider = useDataProvider();
  const model = usePermissions().permissions;
  const t = useTranslate();
  const directory = directoryOf(path);
  const oldName = directory ? path.slice(directory.length + 1) : path;
  const [name, setName] = useState(oldName);
  const [refs, setRefs] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.rpc('file_references', { bucket: info.bucket, path })
      .then((r) => live && setRefs(r)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [api, info.bucket, path]);

  // why the rename is not possible, if it is not
  const blocker = (() => {
    if (!refs) return null;
    if (refs.total > refs.visible) return t('cms.storage.rename_hidden', { _: 'This file is also used by records you cannot see. Renaming it would break them.' });
    const locked = refs.refs.find((r) => {
      const res = model?.byName[r.resource];
      const col = res?.columns.find((c) => c.name === r.column);
      return !col?.canUpdate || !res.primaryKey || res.primaryKey.length !== 1 || Object.keys(r.key).length !== 1;
    });
    if (locked) return t('cms.storage.rename_no_right', { _: 'You may not change the path in %{resource}.', resource: locked.resource });
    return null;
  })();
  const clean = sanitizeFileName(name.trim());
  const target = directory ? `${directory}/${clean}` : clean;

  const rename = async () => {
    if (!clean || target === path) { onClose(); return; }
    setBusy(true); setError(null);
    const done = [];
    try {
      await storage.move(info, path, target);
      try {
        for (const r of refs.refs) {
          const id = Object.values(r.key)[0];
          await dataProvider.update(r.resource, { id, data: { [r.column]: target }, previousData: { ...r.key, id, [r.column]: path } });
          done.push(r);
        }
      } catch (err) {
        // put back what was changed, then the object
        for (const r of done) {
          const id = Object.values(r.key)[0];
          await dataProvider.update(r.resource, { id, data: { [r.column]: path }, previousData: { ...r.key, id, [r.column]: target } }).catch(() => {});
        }
        await storage.move(info, target, path).catch(() => {});
        throw err;
      }
      onDone(target);
    } catch (err) {
      setError(err.code === 'name_taken' ? t('cms.storage.rename_taken', { _: 'A file with this name already exists.' }) : (err.message ?? String(err)));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth data-testid="rename-file">
      <DialogTitle>{t('cms.storage.rename_title', { _: 'Rename file' })}</DialogTitle>
      <DialogContent>
        <MuiTextField fullWidth margin="dense" label={t('cms.storage.rename_name', { _: 'File name' })} value={name}
          onChange={(e) => setName(e.target.value)} disabled={busy || !!blocker}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!blocker && refs) rename(); } }}
          inputProps={{ 'data-testid': 'rename-input' }}
          helperText={`${info.bucket}/${target}`} FormHelperTextProps={{ sx: { fontFamily: MONO } }} />
        {!refs && !error && <CircularProgress size={20} />}
        {refs && !blocker && (
          <Typography variant="body2" color="text.secondary" data-testid="rename-usage">
            {t('cms.storage.rename_used_in', { _: 'Used by %{smart_count} record; it is updated along. |||| Used by %{smart_count} records; they are updated along.', smart_count: refs.visible })}
          </Typography>
        )}
        {blocker && <Alert severity="warning" sx={{ mt: 1 }} data-testid="rename-blocked">{blocker}</Alert>}
        {error && <Alert severity="error" sx={{ mt: 1 }} data-testid="rename-error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('ra.action.cancel')}</Button>
        <Button variant="contained" onClick={rename} disabled={busy || !refs || !!blocker || !clean} data-testid="rename-confirm">
          {t('cms.storage.rename', { _: 'Rename' })}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Button that opens the rename dialog; shown only when the role may move objects in the bucket. */
export function RenameFileButton({ info, path, onDone, disabled = false, icon = false }) {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  if (!info.update || !path) return null;
  return (
    <>
      {icon
        ? <Button size="small" sx={{ minWidth: 0 }} onClick={() => setOpen(true)} disabled={disabled} data-testid="rename-open" title={t('cms.storage.rename', { _: 'Rename' })}><RenameIcon fontSize="small" /></Button>
        : <Button size="small" startIcon={<RenameIcon fontSize="small" />} onClick={() => setOpen(true)} disabled={disabled} data-testid="rename-open">{t('cms.storage.rename', { _: 'Rename' })}</Button>}
      {open && <RenameFileDialog info={info} path={path} onClose={() => setOpen(false)} onDone={(p) => { setOpen(false); onDone(p); }} />}
    </>
  );
}

export function linkFor(model, resource) {
  const r = model.byName[resource];
  return r?.canEdit ? 'edit' : 'show';
}

// Callers set the React key (cloneElement / DataTable.Col): keys must not travel in spread props.

// Dates and numbers follow the language chosen in the app, not the browser's.
const LocalDate = (props) => { const [locale] = useLocaleState(); return <DateField locales={locale} {...props} />; };
const LocalNumber = (props) => { const [locale] = useLocaleState(); return <NumberField locales={locale} {...props} />; };

/** Read-only display of one column. inList = compact cell. */
export function renderField(model, c, { inList = false } = {}) {
  const common = { source: c.name, label: c.label };
  switch (c.widget) {
    case 'reference': {
      const target = model.byName[c.reference.resource];
      return (
        <ReferenceField {...common} reference={c.reference.resource} link={linkFor(model, c.reference.resource)}>
          {target.labelColumn ? <TextField source={target.labelColumn} /> : undefined}
        </ReferenceField>
      );
    }
    case 'boolean': return <BooleanField {...common} />;
    case 'number': return <LocalNumber {...common} />;
    case 'date': return <LocalDate {...common} />;
    case 'datetime': return <LocalDate {...common} showTime />;
    case 'json':
      return <FunctionField {...common} render={(rec) => (inList ? truncate(JSON.stringify(rec[c.name]) ?? '')
        : <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{jsonText(rec[c.name])}</pre>)} />;
    case 'textArray':
    case 'enumArray':
      return <FunctionField {...common} render={(rec) => (rec[c.name] ?? []).join(', ')} />;
    case 'opaque': return <FunctionField {...common} sortable={false} render={() => `‹${c.type}›`} />;
    case 'image':
    case 'file':
      return c.storage ? <StorageField c={c} inList={inList} {...common} /> : <TextField {...common} />;
    case 'html': return inList ? <TextField {...common} /> : <RichTextField {...common} />;
    case 'markdown':
    case 'textarea':
      return inList ? <FunctionField {...common} render={(rec) => truncate(rec[c.name] ?? '')} />
        : <TextField {...common} sx={{ whiteSpace: 'pre-wrap' }} />;
    default: return <TextField {...common} />;
  }
}

/**
 * Input for one column. mode = 'create' | 'edit'. Columns the role may not write in this mode
 * are rendered read-only (edit) — create forms only receive insertable columns (views.jsx).
 */
export function renderInput(model, r, c, mode) {
  const isKey = r.primaryKey?.includes(c.name);
  const writable = !c.systemManaged && (mode === 'create' ? c.canInsert : c.canUpdate && !isKey);
  const mustFill = !c.nullable && (mode === 'edit' || !c.hasDefault);
  const common = {
    source: c.name, label: c.label, helperText: c.help ?? false,
    readOnly: !writable, validate: writable && mustFill ? required() : undefined,
    ...(mode === 'create' && c.defaultValue !== undefined ? { defaultValue: c.defaultValue } : {}),
  };
  const wide = { ...common, fullWidth: true };

  switch (c.widget) {
    case 'reference': {
      const target = model.byName[c.reference.resource];
      if (!writable) return <Labeled label={c.label}>{renderField(model, c)}</Labeled>;
      return (
        <ReferenceInput source={c.name} reference={c.reference.resource}>
          <AutocompleteInput label={c.label} optionText={target.labelColumn ?? 'id'} validate={common.validate}
            helperText={common.helperText} filterToQuery={(q) => (target.labelColumn ? { [`${target.labelColumn}@ilike`]: q } : {})} />
        </ReferenceInput>
      );
    }
    case 'enum':
      // nothing chosen on create → the database default applies (e.g. the brand's default currency)
      return <SelectInput {...common} choices={c.enum.map((v) => ({ id: v, name: v }))}
        emptyText={c.nullable ? '—' : mode === 'create' && c.hasDefault ? 'cms.field.db_default' : undefined} />;
    case 'enumArray':
      return <SelectArrayInput {...common} choices={c.enum.map((v) => ({ id: v, name: v }))} />;
    case 'textArray': return <TextArrayInput {...wide} />;
    case 'boolean': return c.nullable ? <NullableBooleanInput {...common} /> : <BooleanInput {...common} />;
    case 'number': return <NumberInput {...common} />;
    case 'date': return <DateInput {...common} />;
    case 'datetime': return <DateTimeInput {...common} />;
    case 'json': return <TextInput {...wide} multiline minRows={3} {...jsonInputProps}
      validate={[jsonInputProps.validate, ...(common.validate ? [common.validate] : [])]}
      sx={{ '& textarea': { fontFamily: 'monospace' } }} />;
    case 'html':
      return writable ? <RichTextInput {...wide} /> : <Labeled label={c.label}>{renderField(model, c)}</Labeled>;
    case 'markdown':
      return <TextInput {...wide} multiline minRows={6} sx={{ '& textarea': { fontFamily: 'monospace' } }} />;
    case 'textarea': return <TextInput {...wide} multiline minRows={3} />;
    case 'opaque': return <Labeled label={c.label}>{renderField(model, c)}</Labeled>;
    case 'image':
    case 'file':
      return c.storage ? <StorageInput model={model} r={r} c={c} mode={mode} /> : <TextInput {...wide} />;
    default: return <TextInput {...wide} />;
  }
}
