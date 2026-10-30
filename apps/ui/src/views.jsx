// Generic List / Edit / Show / Create views, built from one resource of the model.
// Components are created once per resource (componentsFor) so react-admin does not remount them.
import { cloneElement } from 'react';
import {
  BulkDeleteButton, Create, DataTable, DeleteButton, Edit, Labeled, List, Loading, Pagination, ReferenceManyField,
  SaveButton, SelectInput, Show, SimpleForm, SimpleShowLayout, TextInput, Title, Toolbar, useCreatePath, useDataProvider,
  useGetList, usePermissions, useTranslate,
} from 'react-admin';
import { Navigate } from 'react-router-dom';
import { Alert } from '@mui/material';
import { PendingUploadsContext, renderField, renderInput, linkFor, useDeferredUploads } from './fields.jsx';
import { formColumns } from './model.js';
import { RecordHistory } from './history.jsx';
import { Gallery, GalleryAfterSaveHint, galleryOf } from './gallery.jsx';
import { SortableTable } from './sortable.jsx';

const keyed = (el, key) => cloneElement(el, { key });

function columns(model, r, names) {
  return names.map((n) => r.columns.find((c) => c.name === n)).filter(Boolean)
    .map((c) => (
      <DataTable.Col key={c.name} source={c.name} label={c.label} disableSort={c.widget === 'opaque'}>
        {renderField(model, c, { inList: true })}
      </DataTable.Col>
    ));
}

function filtersFor(r) {
  const f = [];
  if (r.labelColumn) f.push(<TextInput key="q" source={`${r.labelColumn}@ilike`} label="ra.action.search" alwaysOn resettable />);
  for (const c of r.columns) {
    if (c.widget === 'enum') f.push(<SelectInput key={c.name} source={c.name} label={c.label} choices={c.enum.map((v) => ({ id: v, name: v }))} />);
  }
  return f;
}

/**
 * Rows of other tables that point at this record (incoming foreign keys). A child table with an image column
 * is a gallery that is edited right here (gallery.jsx); everything else is a list linking to its rows.
 */
function referencedBy(model, r, mode = 'edit') {
  return r.referencedBy.map((ref) => {
    const g = galleryOf(model, ref);
    if (g) return <Gallery key={`${ref.resource}.${ref.column}`} g={g} parentKey={r.primaryKey[0]} readOnly={mode === 'show'} />;
    const other = model.byName[ref.resource];
    return (
      <Labeled key={`${ref.resource}.${ref.column}`} label={`${ref.label} (${ref.column})`} fullWidth>
        <ReferenceManyField reference={ref.resource} target={ref.column} source={r.primaryKey[0]} perPage={25}>
          <DataTable rowClick={linkFor(model, ref.resource)} bulkActionButtons={false}>
            {columns(model, other, other.listColumns.filter((n) => n !== ref.column))}
          </DataTable>
        </ReferenceManyField>
      </Labeled>
    );
  });
}

function useModel() {
  return usePermissions().permissions;
}

/** "schema · label", with the label in the UI language where it has a key (Settings). */
function useTitle(r) {
  const t = useTranslate();
  return `${r.schema} · ${t(r.labelKey ?? r.label, { _: r.label })}`;
}

/** Columns of the forms: a singleton's key (always the same value) is no field for the editor. */
const singletonForm = (r) => (c) => !(r.isSingleton && r.primaryKey?.includes(c.name));

/** A singleton (@cms(singleton), e.g. the brand's settings) has no list: open its one row, or create it. */
function makeSingletonList(r) {
  return function SingletonList() {
    const t = useTranslate();
    const title = useTitle(r);
    const createPath = useCreatePath();
    const { data, isPending, error } = useGetList(r.name, {
      pagination: { page: 1, perPage: 1 }, sort: { field: r.primaryKey[0], order: 'ASC' }, filter: {} });
    if (isPending) return <Loading />;
    if (error) return <Alert severity="error" sx={{ mt: 2 }}>{error.message ?? String(error)}</Alert>;
    const row = data?.[0];
    if (row) return <Navigate replace to={createPath({ resource: r.name, id: row.id, type: r.canEdit ? 'edit' : 'show' })} />;
    if (r.canCreate) return <Navigate replace to={createPath({ resource: r.name, type: 'create' })} />;
    return (
      <>
        <Title title={title} />
        <Alert severity="info" sx={{ mt: 2 }} data-testid="singleton-empty">
          {t('cms.settings.empty', { _: 'This brand has no settings yet, and your role may not create them.' })}
        </Alert>
      </>
    );
  };
}

function makeList(r) {
  if (r.isSingleton) return makeSingletonList(r);
  return function ResourceList() {
    const model = useModel();
    const title = useTitle(r);
    if (!model) return null;
    // a table with an order column the role may change is listed in that order and reordered by drag-and-drop
    if (r.canReorder) {
      return (
        <List filters={filtersFor(r)} sort={{ field: r.orderColumn, order: 'ASC' }} perPage={100} title={title}
          exporter={false} pagination={<Pagination rowsPerPageOptions={[25, 50, 100]} />}>
          <SortableTable model={model} r={r} names={r.listColumns} />
        </List>
      );
    }
    const sortField = r.labelColumn ?? r.primaryKey?.[0] ?? r.readColumns[0];
    return (
      <List filters={filtersFor(r)} sort={{ field: sortField, order: 'ASC' }} perPage={25} title={title}
        exporter={false}>
        <DataTable rowClick={r.primaryKey ? (r.canEdit ? 'edit' : 'show') : false}
          bulkActionButtons={r.canDelete ? <BulkDeleteButton mutationMode="pessimistic" /> : false}>
          {columns(model, r, r.listColumns)}
        </DataTable>
      </List>
    );
  };
}

function makeEdit(r) {
  const EditToolbar = () => (
    <Toolbar sx={{ justifyContent: 'space-between' }}>
      <SaveButton />
      {r.canDelete && !r.isSingleton && <DeleteButton mutationMode="pessimistic" />}
    </Toolbar>
  );
  return function ResourceEdit() {
    const model = useModel();
    const uploads = useDeferredUploads();
    const title = useTitle(r);
    if (!model) return null;
    // a singleton stays on its page after saving (its list would only lead back here)
    return (
      <Edit mutationMode="pessimistic" title={title} transform={uploads.transform} mutationOptions={{ onError: uploads.onError }}
        redirect={r.isSingleton ? false : 'list'} actions={r.isSingleton ? false : undefined}>
        <PendingUploadsContext.Provider value={uploads.pending}>
          <SimpleForm toolbar={<EditToolbar />}>
            {formColumns(r, singletonForm(r)).map((c) => keyed(renderInput(model, r, c, 'edit'), c.name))}
            {referencedBy(model, r)}
            <RecordHistory resource={r} />
          </SimpleForm>
        </PendingUploadsContext.Provider>
      </Edit>
    );
  };
}

function makeShow(r) {
  return function ResourceShow() {
    const model = useModel();
    const title = useTitle(r);
    if (!model) return null;
    return (
      <Show actions={false} title={title}>
        <SimpleShowLayout>
          {formColumns(r, singletonForm(r)).map((c) => keyed(renderField(model, c), c.name))}
          {referencedBy(model, r, 'show')}
          <RecordHistory resource={r} />
        </SimpleShowLayout>
      </Show>
    );
  };
}

function makeCreate(r) {
  return function ResourceCreate() {
    const model = useModel();
    const uploads = useDeferredUploads();
    const dataProvider = useDataProvider();
    const title = useTitle(r);
    // a new row goes to the end of an ordered list (order column = current maximum + 1)
    const orderCol = r.orderColumn && !r.isGallery ? r.columns.find((c) => c.name === r.orderColumn) : null;
    const transform = async (data) => {
      const out = await uploads.transform(data);
      if (orderCol?.canInsert && out[orderCol.name] == null) {
        const { data: last } = await dataProvider.getList(r.name, {
          pagination: { page: 1, perPage: 1 }, sort: { field: orderCol.name, order: 'DESC' }, filter: {} });
        out[orderCol.name] = last.length ? (Number(last[0][orderCol.name]) || 0) + 1 : 0;
      }
      return out;
    };
    if (!model) return null;
    // keys with a default (uuid, identity) are left to the database
    // system-filled columns (timestamps, gallery order) are left out when the database fills them on its own
    const cols = formColumns(r, (c) => singletonForm(r)(c) && c.canInsert && !(r.primaryKey?.includes(c.name) && c.hasDefault)
      && !(c.systemManaged && (c.hasDefault || c.nullable)));
    return (
      <Create redirect={r.canEdit ? 'edit' : r.primaryKey ? 'show' : 'list'} title={title}
        transform={transform} mutationOptions={{ onError: uploads.onError }}>
        <PendingUploadsContext.Provider value={uploads.pending}>
          <SimpleForm>
            {cols.map((c) => keyed(renderInput(model, r, c, 'create'), c.name))}
            {r.referencedBy.map((ref) => galleryOf(model, ref)).filter(Boolean)
              .map((g) => <GalleryAfterSaveHint key={g.child.name} g={g} />)}
          </SimpleForm>
        </PendingUploadsContext.Provider>
      </Create>
    );
  };
}

const cache = new Map();
/** { list, edit?, show?, create? } for <Resource>, keyed by a fingerprint of the resource. */
export function componentsFor(r) {
  const key = JSON.stringify([r.name, r.columns, r.canEdit, r.canCreate, r.canDelete, r.primaryKey, r.referencedBy, r.isSingleton]);
  if (!cache.has(key)) {
    cache.set(key, {
      list: r.canList ? makeList(r) : undefined,
      edit: r.canEdit ? makeEdit(r) : undefined,
      show: !r.canEdit && r.canList && r.primaryKey ? makeShow(r) : undefined,
      create: r.canCreate ? makeCreate(r) : undefined,
    });
  }
  return cache.get(key);
}
