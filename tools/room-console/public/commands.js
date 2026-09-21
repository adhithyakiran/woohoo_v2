import { mountThemeToggle } from '/theme.js';

/* Every stored API request in the estate, searchable. */

const $ = (s) => document.querySelector(s);
const state = { offset: 0, limit: 200, total: 0, rows: [], selected: null };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(path) {
  const res = await fetch(`/api${path}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const num = (n) => new Intl.NumberFormat().format(Number(n) || 0);

async function loadFilters() {
  const [{ properties }, { vendors }] = await Promise.all([api('/properties'), api('/vendors')]);
  $('#property').append(
    ...properties
      .filter((p) => p.commands > 0)
      .map((p) => el('option', { value: p.id }, `${p.name} (${p.commands})`)),
  );
  $('#vendor').append(
    ...vendors.map((v) => el('option', { value: v.vendor }, `${v.vendor} (${v.commands})`)),
  );
}

function query() {
  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(state.offset),
  });
  const q = $('#q').value.trim();
  if (q) params.set('q', q);
  if ($('#property').value) params.set('property', $('#property').value);
  if ($('#vendor').value) params.set('vendor', $('#vendor').value);
  if ($('#inert').checked) params.set('inert', 'true');
  return `/commands?${params}`;
}

async function load() {
  $('#table').replaceChildren(el('p', { class: 'empty', text: 'Loading…' }));
  const data = await api(query());
  state.rows = data.commands;
  state.total = data.total;
  render();
}

function render() {
  $('#total-pill').textContent = `${num(state.total)} commands`;

  if (!state.rows.length) {
    $('#table').replaceChildren(el('p', { class: 'empty', text: 'Nothing matches.' }));
    $('#pager').replaceChildren();
    return;
  }

  const head = el('tr', {},
    ...['id', 'hotel', 'room', 'vendor', 'device', 'state', 'method', 'path', ''].map((h) =>
      el('th', { text: h })));

  const body = state.rows.map((c) =>
    el('tr', {
      class: `${c.inert ? 'inert' : ''}${state.selected === c.id ? ' selected' : ''}`,
      onclick: () => select(c),
    },
      el('td', { class: 'dim', text: c.id }),
      el('td', { text: (c.property ?? '-').slice(0, 26) }),
      el('td', { text: c.roomNo }),
      el('td', { text: c.serviceName }),
      el('td', { text: c.itemName }),
      el('td', { text: c.stateName }),
      el('td', { class: 'method', text: c.apiMethod }),
      el('td', { class: 'path', text: pathOf(c.apiUrl), title: c.apiUrl ?? '' }),
      el('td', { class: 'inert-tag', text: c.inert ? 'ping' : '' })));

  $('#table').replaceChildren(
    el('table', { class: 'grid' }, el('thead', {}, head), el('tbody', {}, ...body)));
  $('#table').scrollTop = 0;
  renderPager();
}

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url ?? '-';
  }
};

function renderPager() {
  const from = state.offset + 1;
  const to = state.offset + state.rows.length;
  const go = (offset) => {
    state.offset = Math.max(0, offset);
    load();
  };
  $('#pager').replaceChildren(
    el('button', { class: 'btn small', disabled: state.offset === 0, onclick: () => go(0) }, '« First'),
    el('button', { class: 'btn small', disabled: state.offset === 0, onclick: () => go(state.offset - state.limit) }, '‹ Prev'),
    el('span', { class: 'muted', text: `${num(from)}–${num(to)} of ${num(state.total)}` }),
    el('button', { class: 'btn small', disabled: to >= state.total, onclick: () => go(state.offset + state.limit) }, 'Next ›'),
  );
}

function block(label, value) {
  return [
    el('div', { class: 'dk', text: label }),
    el('pre', { class: 'dv', text: value }),
  ];
}

function select(c) {
  state.selected = c.id;
  render();

  // The request exactly as the adapter would send it - the point of the page.
  const headers = { 'content-type': 'application/json', ...(c.apiHeaders ?? {}) };
  const curl = [
    `curl -i -X ${c.apiMethod ?? 'GET'} '${c.apiUrl}'`,
    ...Object.entries(headers).map(([k, v]) => `  -H '${k}: ${v}'`),
    c.apiBody ? `  -d '${JSON.stringify(c.apiBody)}'` : null,
  ].filter(Boolean).join(' \\\n');

  // replaceChildren turns a null argument into the text "null"; el() filters children, this does not.
  const parts = [
    el('div', { class: 'detail-head' },
      el('span', { class: 'card-title', text: c.stateName }),
      el('span', { class: 'muted', text: `row ${c.id}` })),
    c.inert
      ? el('div', { class: 'note warn' },
          'This URL is a health check. It answers 200 and controls nothing.')
      : null,
    el('div', { class: 'fields' },
      el('div', { class: 'field' }, el('span', { class: 'fk', text: 'hotel' }), el('span', { class: 'fv', text: c.property ?? '-' })),
      el('div', { class: 'field' }, el('span', { class: 'fk', text: 'room' }), el('span', { class: 'fv', text: `${c.roomNo} (id ${c.roomId})` })),
      el('div', { class: 'field' }, el('span', { class: 'fk', text: 'vendor' }), el('span', { class: 'fv', text: c.serviceName })),
      el('div', { class: 'field' }, el('span', { class: 'fk', text: 'device' }), el('span', { class: 'fv', text: c.itemName })),
      el('div', { class: 'field' }, el('span', { class: 'fk', text: 'type' }), el('span', { class: 'fv', text: `${c.stateType} = ${c.stateValue ?? 'takes a value'}` }))),
    ...block('url', `${c.apiMethod ?? 'GET'} ${c.apiUrl}`),
    ...block('headers', JSON.stringify(headers, null, 2)),
    ...block('body', c.apiBody ? JSON.stringify(c.apiBody, null, 2) : '(none)'),
    ...block('as curl', curl),
    el('button', {
      class: 'btn small',
      onclick: async (e) => {
        await navigator.clipboard.writeText(curl);
        e.target.textContent = 'copied';
        setTimeout(() => (e.target.textContent = 'Copy curl'), 1200);
      },
    }, 'Copy curl'),
  ];
  $('#detail').replaceChildren(...parts.filter(Boolean));
}

let timer;
const reload = () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    state.offset = 0;
    load();
  }, 250);
};

$('#q').addEventListener('input', reload);
$('#property').addEventListener('change', reload);
$('#vendor').addEventListener('change', reload);
$('#inert').addEventListener('change', reload);
$('#limit').addEventListener('change', (e) => {
  state.limit = Number(e.target.value);
  state.offset = 0;
  load();
});

loadFilters()
  .then(load)
  .catch((err) => {
    $('#table').replaceChildren(el('p', { class: 'empty', text: err.message }));
  });

mountThemeToggle(document.querySelector('#topbar-right'));
