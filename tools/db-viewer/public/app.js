/* woohoo db viewer - browse a remote Postgres, copy it to a local one. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  conn: 'source',
  schema: null,
  schemas: [],
  tables: [],
  relation: null,
  columns: [],
  tab: 'data',
  page: { limit: 50, offset: 0, orderBy: null, dir: 'asc', search: '', exactCount: false, filters: [] },
  config: null,
  job: null,
  jobStream: null,
  picker: new Set(),
};

/* ---------- helpers ---------- */

async function api(path, options = {}) {
  const url = path.includes('?') ? `${path}&conn=${state.conn}` : `${path}?conn=${state.conn}`;
  const res = await fetch(`/api${url}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

const fmt = new Intl.NumberFormat();
const num = (n) => fmt.format(Number(n) || 0);

function bytes(n) {
  const v = Number(n) || 0;
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, kind === 'err' ? 7000 : 3500);
}

const KIND = { r: 'table', p: 'partitioned', v: 'view', m: 'matview' };

/* ---------- deep links ---------- */

/** #conn/schema/table/tab - so a reload, a bookmark or a shared link lands in the same place. */
function readHash() {
  const [conn, schema, table, tab] = location.hash.slice(1).split('/').map(decodeURIComponent);
  return { conn, schema, table, tab };
}

let writingHash = false;
function writeHash() {
  const parts = [state.conn, state.schema, state.relation?.name, state.relation ? state.tab : null]
    .filter(Boolean)
    .map(encodeURIComponent);
  const next = `#${parts.join('/')}`;
  if (next === location.hash) return;
  writingHash = true;
  history.replaceState(null, '', next);
  setTimeout(() => {
    writingHash = false;
  }, 0);
}

/* ---------- connection header ---------- */

async function loadConfig() {
  state.config = await api('/config');
  const s = state.config.source;
  $('#conn-source-detail').textContent = `${s.database} · ${s.host.split('.')[0]}`;
  const t = state.config.target;
  $('#conn-local-detail').textContent = `${t.database} · ${t.host}:${t.port}`;
  $('#t-host').value = t.host;
  $('#t-port').value = t.port;
  $('#t-database').value = t.database;
  $('#t-user').value = t.user;
}

async function loadInfo() {
  const info = await api('/info');
  const v = info.info.version.split(' ').slice(0, 2).join(' ');
  $('#server-info').textContent = `${v} · ${bytes(info.info.bytes)}`;
  state.schemas = info.schemas;

  const select = $('#schema-select');
  select.replaceChildren(
    ...info.schemas.map((s) =>
      el('option', { value: s.schema }, `${s.schema} (${s.tables} tables)`),
    ),
  );
  if (!info.schemas.some((s) => s.schema === state.schema)) {
    state.schema = info.schemas.find((s) => s.schema === 'public')?.schema ?? info.schemas[0]?.schema;
  }
  select.value = state.schema;
  return info;
}

async function switchConnection(conn, keepRelation = null) {
  const previous = state.conn;
  state.conn = conn;
  $$('#conn-switch .conn').forEach((b) => b.classList.toggle('active', b.dataset.conn === conn));
  try {
    await loadInfo();
    await loadTables();
    state.relation = null;
    renderRelationHeader();
    $('#tabs').hidden = true;
    $('#grid-wrap').replaceChildren(el('div', { class: 'empty', text: 'Pick a table on the left.' }));
    writeHash();
    // Staying on the same table across a switch makes remote/local easy to compare.
    const same = keepRelation && state.tables.find((t) => t.name === keepRelation);
    if (same) openRelation(same);
  } catch (err) {
    state.conn = previous;
    $$('#conn-switch .conn').forEach((b) => b.classList.toggle('active', b.dataset.conn === previous));
    toast(
      conn === 'local'
        ? `No local database yet - ${err.message}. Use "Replicate to local" to create one.`
        : err.message,
      'err',
    );
  }
}

/* ---------- sidebar ---------- */

async function loadTables() {
  const list = $('#table-list');
  list.replaceChildren(el('div', { class: 'loading', text: 'Loading…' }));
  const { tables } = await api(`/schemas/${encodeURIComponent(state.schema)}/tables`);
  state.tables = tables;
  renderTables();
  const totalRows = tables.reduce((a, t) => a + Number(t.estimated_rows), 0);
  const totalBytes = tables.reduce((a, t) => a + Number(t.bytes), 0);
  $('#sidebar-foot').textContent = `${tables.length} relations · ~${num(totalRows)} rows · ${bytes(totalBytes)}`;
}

function renderTables() {
  const filter = $('#table-filter').value.trim().toLowerCase();
  const matching = state.tables.filter((t) => !filter || t.name.toLowerCase().includes(filter));
  const list = $('#table-list');

  if (!matching.length) {
    list.replaceChildren(el('div', { class: 'empty', text: 'Nothing matches.' }));
    return;
  }

  const nodes = [];
  let lastKind = null;
  for (const t of matching) {
    if (t.kind !== lastKind) {
      lastKind = t.kind;
      nodes.push(el('div', { class: 'list-group', text: `${KIND[t.kind] ?? t.kind}s` }));
    }
    nodes.push(
      el(
        'button',
        {
          class: `table-item${state.relation?.name === t.name ? ' active' : ''}`,
          dataset: { name: t.name },
          title: `${t.name} - ${num(t.estimated_rows)} rows (estimated), ${bytes(t.bytes)}`,
          onclick: () => openRelation(t),
        },
        el('span', { class: 'tname', text: t.name }),
        el('span', { class: 'trows', text: t.estimated_rows > 0 ? num(t.estimated_rows) : '·' }),
      ),
    );
  }
  list.replaceChildren(...nodes);
}

/* ---------- relation ---------- */

async function openRelation(relation) {
  state.relation = relation;
  state.page = {
    limit: state.page.limit,
    offset: 0,
    orderBy: null,
    dir: 'asc',
    search: '',
    exactCount: state.page.exactCount,
    filters: [],
  };
  state.columns = [];
  $('#row-search').value = '';
  renderFilters();
  renderTables();
  renderRelationHeader();
  $('#tabs').hidden = false;
  setTab(state.tab === 'sql' ? 'data' : state.tab);
  writeHash();
}

function renderRelationHeader() {
  if (!state.relation) {
    $('#relation-name').textContent = 'Select a table';
    $('#relation-meta').textContent = '';
    return;
  }
  const r = state.relation;
  $('#relation-name').textContent = r.name;
  $('#relation-meta').textContent =
    `${KIND[r.kind] ?? r.kind} · ${r.columns} columns · ~${num(r.estimated_rows)} rows · ${bytes(r.bytes)}` +
    (r.comment ? ` · ${r.comment}` : '');
  $('#export-csv').href =
    `/api/schemas/${encodeURIComponent(state.schema)}/tables/${encodeURIComponent(r.name)}/export.csv?conn=${state.conn}`;
}

function setTab(tab) {
  state.tab = tab;
  $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  for (const name of ['data', 'structure', 'relations', 'sql']) {
    $(`#panel-${name}`).hidden = name !== tab;
  }
  writeHash();
  if (tab === 'data') loadRows();
  if (tab === 'structure') loadStructure();
  if (tab === 'relations') loadRelations();
}

/* ---------- data grid ---------- */

let rowsToken = 0;

async function loadRows() {
  if (!state.relation) return;
  const token = ++rowsToken;
  const wrap = $('#grid-wrap');
  wrap.replaceChildren(el('div', { class: 'loading', text: 'Reading rows…' }));

  try {
    const p = state.page;
    const data = await api(
      `/schemas/${encodeURIComponent(state.schema)}/tables/${encodeURIComponent(state.relation.name)}/rows`,
      {
        method: 'POST',
        body: JSON.stringify({
          limit: p.limit,
          offset: p.offset,
          orderBy: p.orderBy,
          dir: p.dir,
          search: p.search,
          exactCount: p.exactCount,
          filters: p.filters.filter((f) => f.column && (f.value !== '' || UNARY_OPS.has(f.op))),
        }),
      },
    );
    if (token !== rowsToken) return;
    state.columns = data.columns;
    renderGrid(wrap, data.columns, data.rows, { offset: p.offset, sortable: true });
    renderPager(data);
  } catch (err) {
    if (token !== rowsToken) return;
    wrap.replaceChildren(el('div', { class: 'empty', text: err.message }));
    $('#pager').replaceChildren();
  }
}

function renderGrid(wrap, columns, rows, { offset = 0, sortable = false } = {}) {
  if (!rows.length) {
    wrap.replaceChildren(el('div', { class: 'empty', text: 'No rows.' }));
    return;
  }

  const head = el(
    'tr',
    {},
    el('th', { class: 'rownum' }, '#'),
    ...columns.map((c) =>
      el(
        'th',
        {
          onclick: sortable ? () => sortBy(c.name) : null,
          title: c.type ?? '',
        },
        c.name,
        c.primaryKey ? el('span', { class: 'pk', text: '★' }) : null,
        c.type ? el('span', { class: 'coltype', text: shortType(c.type) }) : null,
        sortable && state.page.orderBy === c.name
          ? el('span', { class: 'sort', text: state.page.dir === 'asc' ? '↑' : '↓' })
          : null,
      ),
    ),
  );

  const body = rows.map((row, i) =>
    el(
      'tr',
      {},
      el('td', { class: 'rownum', text: offset + i + 1 }),
      ...row.map((value, ci) => cell(value, columns[ci])),
    ),
  );

  wrap.replaceChildren(
    el('table', { class: 'grid' }, el('thead', {}, head), el('tbody', {}, ...body)),
  );
  wrap.scrollTop = 0;
}

function cell(value, column) {
  if (value === null) return el('td', { class: 'null', text: 'NULL' });
  const text = String(value);
  const numeric = typeof value === 'number';
  const long = text.length > 48;
  return el('td', {
    class: `${numeric ? 'num' : ''} ${long ? 'clickable' : ''}`.trim(),
    text,
    title: long ? 'Click to expand' : text,
    onclick: long ? () => showCell(column?.name ?? 'value', text) : null,
  });
}

const shortType = (t) =>
  t
    .replace('character varying', 'varchar')
    .replace('timestamp with time zone', 'timestamptz')
    .replace('timestamp without time zone', 'timestamp')
    .replace('double precision', 'float8');

/* ---------- column filters ---------- */

// Mirrors FILTER_OPS on the server; anything else is dropped there rather than here.
const FILTER_OPS = [
  ['eq', '='],
  ['neq', '≠'],
  ['contains', 'contains'],
  ['starts', 'starts with'],
  ['gt', '>'],
  ['gte', '≥'],
  ['lt', '<'],
  ['lte', '≤'],
  ['null', 'is null'],
  ['notnull', 'is not null'],
];
const UNARY_OPS = new Set(['null', 'notnull']);

function renderFilters() {
  const wrap = $('#filters');
  const columns = state.columns ?? [];

  wrap.replaceChildren(
    ...state.page.filters.map((f, i) => {
      const reload = () => {
        state.page.offset = 0;
        loadRows();
      };
      return el(
        'div',
        { class: 'filter' },
        el(
          'select',
          {
            onchange: (e) => {
              f.column = e.target.value;
              reload();
            },
          },
          ...columns.map((c) => el('option', { value: c.name, selected: c.name === f.column }, c.name)),
        ),
        el(
          'select',
          {
            onchange: (e) => {
              f.op = e.target.value;
              renderFilters();
              reload();
            },
          },
          ...FILTER_OPS.map(([value, label]) => el('option', { value, selected: value === f.op }, label)),
        ),
        UNARY_OPS.has(f.op)
          ? null
          : el('input', {
              class: 'value',
              value: f.value,
              placeholder: 'value',
              onchange: (e) => {
                f.value = e.target.value;
                reload();
              },
            }),
        el(
          'button',
          {
            class: 'drop',
            title: 'Remove',
            onclick: () => {
              state.page.filters.splice(i, 1);
              renderFilters();
              reload();
            },
          },
          '×',
        ),
      );
    }),
  );
}

function addFilter() {
  const first = state.columns?.[0];
  if (!first) return toast('Load a table first.', 'err');
  state.page.filters.push({ column: first.name, op: 'eq', value: '' });
  renderFilters();
}

function sortBy(column) {
  const p = state.page;
  if (p.orderBy === column) p.dir = p.dir === 'asc' ? 'desc' : 'asc';
  else {
    p.orderBy = column;
    p.dir = 'asc';
  }
  p.offset = 0;
  loadRows();
}

function renderPager(data) {
  const p = state.page;
  const from = data.rows.length ? p.offset + 1 : 0;
  const to = p.offset + data.rows.length;
  const label = `${num(from)}–${num(to)} of ${data.counted === 'exact' ? num(data.count) : `~${num(data.count)}`}`;

  const go = (offset) => {
    p.offset = Math.max(0, offset);
    loadRows();
  };

  $('#pager').replaceChildren(
    el('button', { class: 'btn small', disabled: p.offset === 0, onclick: () => go(0) }, '« First'),
    el('button', { class: 'btn small', disabled: p.offset === 0, onclick: () => go(p.offset - p.limit) }, '‹ Prev'),
    el('span', { text: label }),
    el(
      'button',
      { class: 'btn small', disabled: to >= data.count, onclick: () => go(p.offset + p.limit) },
      'Next ›',
    ),
    el('span', { class: 'spacer' }),
    el('span', { class: 'muted', text: data.counted === 'exact' ? 'exact count' : 'estimated count' }),
  );
}

function showCell(name, text) {
  $('#cell-drawer-title').textContent = name;
  let body = text;
  try {
    body = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* not JSON - show it raw */
  }
  $('#cell-drawer-body').textContent = body;
  $('#cell-drawer').hidden = false;
}

/* ---------- structure ---------- */

async function loadStructure() {
  const panel = $('#panel-structure');
  panel.replaceChildren(el('div', { class: 'loading', text: 'Reading structure…' }));
  const d = await api(
    `/schemas/${encodeURIComponent(state.schema)}/tables/${encodeURIComponent(state.relation.name)}`,
  );

  const columns = el(
    'section',
    { class: 'section' },
    el('h3', { text: `Columns (${d.columns.length})` }),
    el(
      'table',
      { class: 'flat' },
      el(
        'thead',
        {},
        el('tr', {}, ...['#', 'Name', 'Type', 'Nullable', 'Default', ''].map((h) => el('th', { text: h }))),
      ),
      el(
        'tbody',
        {},
        ...d.columns.map((c) =>
          el(
            'tr',
            {},
            el('td', { class: 'rownum', text: c.position }),
            el('td', { text: c.name }),
            el('td', {}, el('code', { text: c.type })),
            el('td', { text: c.not_null ? 'NOT NULL' : 'null' }),
            el('td', {}, c.default_expr ? el('code', { text: c.default_expr }) : el('span', { class: 'muted', text: '-' })),
            el(
              'td',
              {},
              c.is_primary_key ? el('span', { class: 'tag pk', text: 'PK' }) : null,
              c.identity ? el('span', { class: 'tag', text: 'identity' }) : null,
              c.generated === 's' ? el('span', { class: 'tag', text: 'generated' }) : null,
            ),
          ),
        ),
      ),
    ),
  );

  const indexes = el(
    'section',
    { class: 'section' },
    el('h3', { text: `Indexes (${d.indexes.length})` }),
    d.indexes.length
      ? el(
          'table',
          { class: 'flat' },
          el('thead', {}, el('tr', {}, ...['Name', 'Definition', 'Size', ''].map((h) => el('th', { text: h })))),
          el(
            'tbody',
            {},
            ...d.indexes.map((i) =>
              el(
                'tr',
                {},
                el('td', { text: i.name }),
                el('td', {}, el('code', { text: i.definition })),
                el('td', { text: bytes(i.bytes) }),
                el(
                  'td',
                  {},
                  i.is_primary ? el('span', { class: 'tag pk', text: 'PK' }) : null,
                  !i.is_primary && i.is_unique ? el('span', { class: 'tag uq', text: 'unique' }) : null,
                ),
              ),
            ),
          ),
        )
      : el('p', { class: 'muted', text: 'None.' }),
  );

  const checks = d.constraints.filter((c) => c.type === 'c' || c.type === 'x');
  const constraints = el(
    'section',
    { class: 'section' },
    el('h3', { text: `Checks (${checks.length})` }),
    checks.length
      ? el(
          'table',
          { class: 'flat' },
          el('thead', {}, el('tr', {}, ...['Name', 'Definition'].map((h) => el('th', { text: h })))),
          el(
            'tbody',
            {},
            ...checks.map((c) => el('tr', {}, el('td', { text: c.name }), el('td', {}, el('code', { text: c.definition })))),
          ),
        )
      : el('p', { class: 'muted', text: 'None.' }),
  );

  panel.replaceChildren(el('div', { class: 'scroll-panel' }, columns, indexes, constraints));
}

/* ---------- relations ---------- */

async function loadRelations() {
  const panel = $('#panel-relations');
  panel.replaceChildren(el('div', { class: 'loading', text: 'Reading relationships…' }));
  const d = await api(
    `/schemas/${encodeURIComponent(state.schema)}/tables/${encodeURIComponent(state.relation.name)}`,
  );
  const outgoing = d.constraints.filter((c) => c.type === 'f');

  const jump = (name) => {
    const target = state.tables.find((t) => t.name === name);
    if (target) openRelation(target);
  };

  const table = (rows, emptyText, columns) =>
    rows.length
      ? el(
          'table',
          { class: 'flat' },
          el('thead', {}, el('tr', {}, ...columns.map((h) => el('th', { text: h })))),
          el('tbody', {}, ...rows),
        )
      : el('p', { class: 'muted', text: emptyText });

  panel.replaceChildren(
    el(
      'div',
      { class: 'scroll-panel' },
      el(
        'section',
        { class: 'section' },
        el('h3', { text: `References (${outgoing.length}) - this table points at` }),
        table(
          outgoing.map((c) =>
            el(
              'tr',
              {},
              el('td', { text: c.name }),
              el(
                'td',
                {},
                el('a', { class: 'linkish', onclick: () => jump(c.references_table) }, c.references_table),
              ),
              el('td', {}, el('code', { text: c.definition })),
            ),
          ),
          'This table has no foreign keys.',
          ['Constraint', 'Table', 'Definition'],
        ),
      ),
      el(
        'section',
        { class: 'section' },
        el('h3', { text: `Referenced by (${d.referencedBy.length}) - tables pointing here` }),
        table(
          d.referencedBy.map((c) =>
            el(
              'tr',
              {},
              el('td', { text: c.name }),
              el('td', {}, el('a', { class: 'linkish', onclick: () => jump(c.table) }, c.table)),
              el('td', {}, el('code', { text: c.definition })),
            ),
          ),
          'Nothing references this table.',
          ['Constraint', 'Table', 'Definition'],
        ),
      ),
    ),
  );
}

/* ---------- sql console ---------- */

async function runSql() {
  const sql = $('#sql-input').value.trim();
  if (!sql) return;
  const out = $('#sql-results');
  $('#sql-status').textContent = 'Running…';
  out.replaceChildren(el('div', { class: 'loading', text: 'Running…' }));
  try {
    const r = await api('/query', { method: 'POST', body: JSON.stringify({ sql, limit: 500 }) });
    $('#sql-status').textContent =
      `${r.command ?? 'OK'} · ${num(r.rowCount ?? 0)} rows · ${r.ms} ms${r.truncated ? ' · showing the first 500' : ''}`;
    if (!r.columns.length) {
      out.replaceChildren(el('div', { class: 'empty', text: 'Statement returned no result set.' }));
      return;
    }
    renderGrid(out, r.columns, r.rows);
  } catch (err) {
    $('#sql-status').textContent = 'Failed';
    out.replaceChildren(el('div', { class: 'empty', text: err.message }));
  }
}

/* ---------- replication ---------- */

async function openReplicate() {
  $('#replicate-modal').hidden = false;
  $('#replicate-setup').hidden = false;
  $('#replicate-progress').hidden = true;
  $('#start-replicate').hidden = false;
  $('#cancel-job').hidden = true;
  $('#browse-local').hidden = true;

  if (state.conn !== 'source') {
    toast('Replication always reads the remote database.', '');
  }
  state.picker = new Set(state.tables.filter((t) => t.kind === 'r' || t.kind === 'p').map((t) => t.name));
  renderPicker();
  refreshDocker();
}

function renderPicker() {
  const filter = $('#picker-filter').value.trim().toLowerCase();
  const tables = state.tables.filter((t) => t.kind === 'r' || t.kind === 'p');
  const shown = tables.filter((t) => !filter || t.name.toLowerCase().includes(filter));

  $('#picker-list').replaceChildren(
    ...shown.map((t) =>
      el(
        'label',
        { class: 'picker-item' },
        el('input', {
          type: 'checkbox',
          checked: state.picker.has(t.name),
          onchange: (e) => {
            if (e.target.checked) state.picker.add(t.name);
            else state.picker.delete(t.name);
            updateScopePill();
          },
        }),
        el('span', { text: t.name }),
        el('span', { class: 'rows', text: `${num(t.estimated_rows)} rows · ${bytes(t.bytes)}` }),
      ),
    ),
  );
  updateScopePill();
}

function updateScopePill() {
  const tables = state.tables.filter((t) => state.picker.has(t.name));
  const rows = tables.reduce((a, t) => a + Number(t.estimated_rows), 0);
  $('#scope-pill').textContent = `${tables.length} tables · ~${num(rows)} rows`;
}

async function refreshDocker() {
  const row = $('#docker-row');
  row.replaceChildren(el('span', { text: 'Checking Docker…' }));
  try {
    const d = await api('/docker/status');
    if (!d.engine.available) {
      row.replaceChildren(
        el('span', { text: `Docker not usable (${d.engine.reason}). Point the fields below at any Postgres you already run.` }),
      );
      return;
    }
    const running = d.container.exists && d.container.state === 'running';
    row.replaceChildren(
      el('span', { class: `pill ${running ? 'ok' : ''}`, text: running ? 'container running' : d.container.state }),
      el('span', { text: `${state.config.docker.container} · ${state.config.docker.image} · port ${state.config.docker.port}` }),
      el(
        'button',
        {
          class: 'btn small',
          onclick: async (e) => {
            e.target.disabled = true;
            e.target.textContent = 'Starting…';
            try {
              const r = await api('/docker/up', { method: 'POST' });
              toast(r.ok ? 'Local Postgres is ready.' : 'Container started but is not accepting connections yet.', r.ok ? 'ok' : 'err');
            } catch (err) {
              toast(err.message, 'err');
            }
            refreshDocker();
            testTarget();
          },
        },
        running ? 'Restart check' : 'Start local Postgres',
      ),
    );
  } catch (err) {
    row.replaceChildren(el('span', { text: err.message }));
  }
}

function targetFromForm() {
  const password = $('#t-password').value;
  return {
    host: $('#t-host').value.trim(),
    port: Number($('#t-port').value),
    database: $('#t-database').value.trim(),
    user: $('#t-user').value.trim(),
    ...(password ? { password } : {}),
  };
}

async function testTarget() {
  const pill = $('#target-pill');
  pill.className = 'pill busy';
  pill.textContent = 'testing';
  $('#target-status').textContent = '';
  try {
    const r = await api('/target/test', { method: 'POST', body: JSON.stringify(targetFromForm()) });
    if (r.ok) {
      pill.className = 'pill ok';
      pill.textContent = 'reachable';
      const schemas = r.schemas.map((s) => `${s.schema} (${s.tables})`).join(', ') || 'no user schemas';
      $('#target-status').textContent = `${r.info.version.split(' ').slice(0, 2).join(' ')} · ${schemas}`;
    } else {
      pill.className = 'pill err';
      pill.textContent = 'unreachable';
      $('#target-status').textContent = r.error;
    }
    return r.ok;
  } catch (err) {
    pill.className = 'pill err';
    pill.textContent = 'error';
    $('#target-status').textContent = err.message;
    return false;
  }
}

async function startReplication() {
  const tables = [...state.picker];
  if (!tables.length) return toast('Pick at least one table.', 'err');

  const target = targetFromForm();
  await api('/config/target', { method: 'PUT', body: JSON.stringify(target) });
  await loadConfig();

  const body = {
    target,
    schema: state.schema,
    tables,
    mode: $('#r-mode').value,
    dropExisting: $('#r-drop').checked,
    createDatabase: $('#r-createdb').checked,
    includeViews: $('#r-views').checked,
    rowLimit: $('#r-rowlimit').value || null,
  };

  try {
    // Replication always reads the remote database, whichever one is being browsed.
    const res = await fetch('/api/replicate?conn=source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || 'Could not start');
    state.job = job;
    showProgress(job);
    followJob(job.id);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function showProgress(job) {
  $('#replicate-setup').hidden = true;
  $('#replicate-progress').hidden = false;
  $('#start-replicate').hidden = true;
  $('#cancel-job').hidden = false;
  $('#browse-local').hidden = true;
  $('#job-log').replaceChildren();
  $('#job-tables').replaceChildren();
  $('#job-bar').style.width = '0%';
  $('#job-phase').textContent = 'Starting…';
  $('#job-pill').className = 'pill busy';
  $('#job-pill').textContent = job.status;
  $('#replicate-hint').textContent = `Job ${job.id} · reading ${state.config.source.database} on ${state.config.source.host}`;
}

const jobTables = new Map();

function followJob(id) {
  state.jobStream?.close();
  jobTables.clear();
  const stream = new EventSource(`/api/replicate/${id}/stream`);
  state.jobStream = stream;

  stream.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === 'snapshot') {
      for (const t of event.tables ?? []) upsertJobTable(t);
      return;
    }
    if (event.type === 'log') return appendLog(event);
    if (event.type === 'phase') {
      $('#job-phase').textContent = event.message ?? event.phase;
      return;
    }
    if (event.type === 'plan') {
      for (const t of event.tables) upsertJobTable(t);
      return;
    }
    if (event.type === 'table') {
      upsertJobTable(event);
      return;
    }
    if (event.type === 'done') finishJob(event);
  };

  stream.onerror = () => {
    // The server closes the stream once the job is finished; nothing to recover.
    if (state.job?.status === 'running') appendLog({ level: 'warn', message: 'Lost the progress stream - the job keeps running.', at: Date.now() });
  };
}

function upsertJobTable(t) {
  let row = jobTables.get(t.name);
  if (!row) {
    row = el(
      'div',
      { class: 'job-table', dataset: { status: t.status } },
      el('span', { class: 'jt-name', text: t.name }),
      el('span', { class: 'jt-count' }),
      el('span', { class: 'jt-bar' }, el('span', { class: 'jt-fill' })),
    );
    jobTables.set(t.name, row);
    $('#job-tables').append(row);
  }
  row.dataset.status = t.status;
  const pct = t.expected > 0 ? Math.min(100, (t.rows / t.expected) * 100) : t.status === 'copied' ? 100 : 0;
  row.querySelector('.jt-fill').style.width = `${t.status === 'copied' ? 100 : pct}%`;
  row.querySelector('.jt-count').textContent =
    t.status === 'copied' ? `${num(t.rows)} rows` : t.status === 'copying' ? num(t.rows) : t.status;

  const done = [...jobTables.values()].filter((r) => r.dataset.status === 'copied' || r.dataset.status === 'indexed').length;
  $('#job-bar').style.width = `${(done / Math.max(jobTables.size, 1)) * 100}%`;
  $('#job-totals').textContent = `${done} of ${jobTables.size} tables copied`;
}

function appendLog(event) {
  const time = new Date(event.at).toLocaleTimeString();
  const log = $('#job-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(
    el('div', { class: event.level ?? 'info' }, el('span', { class: 't', text: time }), el('span', { class: 'm', text: event.message })),
  );
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function finishJob(summary) {
  state.job = summary;
  state.jobStream?.close();
  state.jobStream = null;
  $('#cancel-job').hidden = true;
  $('#job-pill').className = `pill ${summary.status === 'succeeded' ? 'ok' : summary.status === 'cancelled' ? 'warn' : 'err'}`;
  $('#job-pill').textContent = summary.status;
  $('#job-bar').style.width = '100%';
  if (summary.status === 'succeeded') {
    $('#browse-local').hidden = false;
    $('#job-totals').textContent = `${num(summary.totals.rows)} rows across ${summary.totals.tables} tables · ${bytes(summary.totals.bytes)} transferred`;
    toast('Replication finished.', 'ok');
  } else {
    $('#start-replicate').hidden = false;
    $('#start-replicate').textContent = 'Retry';
    if (summary.error) toast(summary.error, 'err');
  }
  if (summary.warnings?.length) {
    appendLog({ level: 'warn', at: Date.now(), message: `${summary.warnings.length} warnings - see above.` });
  }
}

/* ---------- wiring ---------- */

function wire() {
  $('#conn-switch').addEventListener('click', (e) => {
    const button = e.target.closest('.conn');
    if (button && button.dataset.conn !== state.conn) {
      switchConnection(button.dataset.conn, state.relation?.name);
    }
  });

  $('#schema-select').addEventListener('change', async (e) => {
    state.schema = e.target.value;
    state.relation = null;
    renderRelationHeader();
    $('#tabs').hidden = true;
    await loadTables();
    writeHash();
  });

  window.addEventListener('hashchange', () => {
    if (!writingHash) applyHash();
  });

  $('#table-filter').addEventListener('input', renderTables);
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) setTab(tab.dataset.tab);
  });

  let searchTimer;
  $('#row-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.page.search = e.target.value;
      state.page.offset = 0;
      loadRows();
    }, 260);
  });

  $('#page-size').addEventListener('change', (e) => {
    state.page.limit = Number(e.target.value);
    state.page.offset = 0;
    loadRows();
  });
  $('#exact-count').addEventListener('change', (e) => {
    state.page.exactCount = e.target.checked;
    loadRows();
  });
  $('#add-filter').addEventListener('click', addFilter);
  $('#refresh-rows').addEventListener('click', loadRows);

  $('#run-sql').addEventListener('click', runSql);
  $('#sql-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runSql();
  });

  $('#cell-close').addEventListener('click', () => ($('#cell-drawer').hidden = true));
  $('#cell-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#cell-drawer-body').textContent);
    toast('Copied.', 'ok');
  });

  $('#open-replicate').addEventListener('click', openReplicate);
  $('#close-replicate').addEventListener('click', () => {
    $('#replicate-modal').hidden = true;
  });
  $('#test-target').addEventListener('click', testTarget);
  $('#picker-filter').addEventListener('input', renderPicker);
  $('#pick-all').addEventListener('click', () => {
    for (const t of state.tables) if (t.kind === 'r' || t.kind === 'p') state.picker.add(t.name);
    renderPicker();
  });
  $('#pick-none').addEventListener('click', () => {
    state.picker.clear();
    renderPicker();
  });
  $('#start-replicate').addEventListener('click', startReplication);
  $('#cancel-job').addEventListener('click', async () => {
    if (state.job) await api(`/replicate/${state.job.id}/cancel`, { method: 'POST' });
  });
  $('#browse-local').addEventListener('click', async () => {
    $('#replicate-modal').hidden = true;
    await switchConnection('local');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#cell-drawer').hidden = true;
      if (state.job?.status !== 'running') $('#replicate-modal').hidden = true;
    }
  });
}

async function applyHash() {
  const wanted = readHash();
  if (wanted.conn === 'local' && state.conn !== 'local') {
    await switchConnection('local', wanted.table);
    return;
  }
  if (wanted.schema && wanted.schema !== state.schema && state.schemas.some((s) => s.schema === wanted.schema)) {
    state.schema = wanted.schema;
    $('#schema-select').value = wanted.schema;
    await loadTables();
  }
  if (wanted.tab) state.tab = wanted.tab;
  const relation = wanted.table && state.tables.find((t) => t.name === wanted.table);
  if (relation) openRelation(relation);
}

async function boot() {
  wire();
  try {
    await loadConfig();
    await loadInfo();
    await loadTables();
    $('#grid-wrap').replaceChildren(el('div', { class: 'empty', text: 'Pick a table on the left.' }));
    if (location.hash.length > 1) await applyHash();
    else writeHash();
  } catch (err) {
    toast(`Could not reach the database: ${err.message}`, 'err');
    $('#grid-wrap').replaceChildren(el('div', { class: 'empty', text: err.message }));
  }
}

boot();
