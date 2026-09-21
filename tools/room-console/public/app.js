import { mountThemeToggle } from '/theme.js';

/* Room console - press a control, watch the request leave. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = { propertyId: null, rooms: [], devices: [], room: null, detail: null, tab: 'capabilities', mode: 'rooms', onlyControllable: true };

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

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => node.remove(), kind === 'err' ? 6000 : 3000);
}

/* ---------- properties and rooms ---------- */

async function loadProperties() {
  const { properties } = await api('/properties');
  $('#property-select').replaceChildren(
    ...properties.map((p) =>
      el('option', { value: p.id }, `${p.name} - ${p.rooms} rooms, ${p.commands} commands`),
    ),
  );
  // Property 167 is the WooHoo test hotel: smallest, and the vendor spread is widest.
  state.propertyId = properties.some((p) => p.id === 167) ? 167 : properties[0]?.id;
  $('#property-select').value = state.propertyId;
  await loadRooms();
}

async function loadRooms() {
  const [{ rooms }, { devices }] = await Promise.all([
    api(`/properties/${state.propertyId}/rooms`),
    api(`/properties/${state.propertyId}/devices`),
  ]);
  state.rooms = rooms;
  state.devices = devices;
  renderRooms();
}

function renderFoot() {
  if (state.mode === 'devices') {
    const online = state.devices.filter((d) => d.connectionStatus === 'online').length;
    $('#sidebar-foot').textContent = `${state.devices.length} devices · ${online} online`;
    return;
  }
  const commands = state.rooms.reduce((a, r) => a + r.commands, 0);
  const controllable = state.rooms.filter((r) => r.commands > 0).length;
  $('#sidebar-foot').textContent =
    `${state.rooms.length} rooms · ${controllable} controllable · ${commands} commands`;
}

function renderRooms() {
  renderFoot();
  const filter = $('#room-filter').value.trim().toLowerCase();
  const list = $('#room-list');

  if (state.mode === 'devices') {
    const shown = state.devices.filter(
      (d) =>
        !filter ||
        String(d.roomNo).includes(filter) ||
        (d.hubId ?? '').toLowerCase().includes(filter) ||
        (d.name ?? '').toLowerCase().includes(filter),
    );
    list.replaceChildren(
      ...shown.map((d) =>
        el(
          'button',
          {
            class: `room-item${state.room?.id === d.room_id ? ' active' : ''}${d.commands ? '' : ' dead'}`,
            onclick: () => openRoom({ id: d.room_id, roomNo: d.roomNo, commands: d.commands }),
            title: `${d.hubId} · ${d.macAddress ?? ''} · ${d.ipAddress ?? ''} · fw ${d.firmwareVersion ?? '?'}`,
          },
          el('span', { class: `dot ${d.connectionStatus ?? ''}` }),
          el('span', { class: 'no', text: d.roomNo }),
          el('span', { class: 'meta', text: (d.hubId ?? '').slice(0, 12) }),
        ),
      ),
    );
    if (!shown.length) list.replaceChildren(el('p', { class: 'empty', text: 'No devices.' }));
    return;
  }

  const shown = state.rooms.filter((r) => {
    if (state.onlyControllable && !r.commands) return false;
    if (!filter) return true;
    return String(r.roomNo).includes(filter) || (r.vendors ?? '').toLowerCase().includes(filter);
  });

  list.replaceChildren(
    ...shown.map((r) =>
      el(
        'button',
        {
          class:
            `room-item${state.room?.id === r.id ? ' active' : ''}` +
            `${r.commands ? '' : ' dead'}`,
          onclick: () => openRoom(r),
          title: `${r.vendors ?? 'no automation'} · hub ${r.hubId ?? 'none'}`,
        },
        el('span', { class: `dot ${r.hub_status ?? ''}` }),
        el('span', { class: 'no', text: r.roomNo }),
        // A room whose commands all hit a ping endpoint looks equipped and controls nothing.
        r.inert && r.inert === r.commands ? el('span', { class: 'warn-dot', text: '!' }) : null,
        el('span', { class: 'meta', text: r.commands ? `${r.commands} cmds` : 'none' }),
      ),
    ),
  );
  if (!shown.length) list.replaceChildren(el('p', { class: 'empty', text: 'Nothing matches.' }));
}

async function openRoom(room) {
  state.room = room;
  renderRooms();
  if (!room.commands) {
    $('#tabs').hidden = true;
    $('#room-title').textContent = `Room ${room.roomNo}`;
    $('#room-meta').textContent = 'This room has no automation commands - nothing to drive.';
    $('#controls').replaceChildren(
      el('p', { class: 'empty', text: 'No commands stored for this room in masterdb.' }),
    );
    return;
  }
  $('#tabs').hidden = false;
  $('#room-title').textContent = `Room ${room.roomNo}`;
  $('#room-meta').textContent = 'loading…';
  $('#controls').replaceChildren(el('p', { class: 'empty', text: 'Loading…' }));

  state.detail = await api(`/rooms/${room.id}`);
  const d = state.detail;
  $('#room-meta').textContent =
    `${d.room.property ?? '-'} · masterdb id ${d.room.id} · hub ${d.room.hubId ?? 'none'}` +
    ` (${d.room.hub_status ?? 'unknown'}) · ${d.commands.length} commands`;
  renderControls();
  renderCommands();
}

/* ---------- capabilities ---------- */

function renderControls() {
  const d = state.detail;
  const nodes = [];

  const inert = d.commands.filter((c) => c.inert).length;
  if (inert) {
    nodes.push(
      el('div', { class: 'note warn' },
        `${inert} of ${d.commands.length} commands in this room point at a health-check endpoint. ` +
        `They will answer 200 and control nothing - a production config bug, not a console problem.`),
    );
  }

  nodes.push(
    el('div', { class: 'note' },
      'These are what the agent can ask for. Pressing one runs the same path a guest utterance takes: ' +
      'capability → adapter → the room’s own stored request.'),
  );

  // Two physical devices under one capability is a gap in the model, not a rendering quirk.
  for (const clash of d.collisions ?? []) {
    nodes.push(
      el('div', { class: 'note warn' },
        el('strong', { text: clash.items.join(' and ') }),
        ` both answer to ${clash.key}. The agent has no way to say which, so it drives ` +
        `whichever comes first. Buttons below are labelled by device.`),
    );
  }

  if (!d.controls.length) {
    nodes.push(el('p', { class: 'empty', text: 'Nothing in this room mapped to a capability.' }));
  }

  for (const control of d.controls) {
    nodes.push(
      el(
        'div',
        { class: 'control' },
        el(
          'div',
          { class: 'label' },
          el('div', { class: 'cap', text: control.capability }),
          control.zone ? el('div', { class: 'zone', text: control.zone }) : null,
        ),
        el('div', { class: 'actions' }, ...actionsFor(control)),
      ),
    );
  }

  if (d.unmapped.length) {
    nodes.push(el('div', { class: 'group-title', text: 'not exposed to the agent' }));
    for (const u of d.unmapped) {
      nodes.push(
        el('div', { class: 'note' },
          el('strong', { text: `${u.itemName} / ${u.stateName}` }),
          ` - ${u.reason}`),
      );
    }
  }

  $('#controls').replaceChildren(...nodes);
}

function actionsFor(control) {
  if (control.kind === 'number') {
    const input = el('input', { class: 'input', type: 'number', value: '21', min: '16', max: '30' });
    return [
      input,
      el('button', {
        class: 'btn on',
        onclick: (e) => fireCapability(e.target, control, Number(input.value)),
      }, 'Set'),
    ];
  }
  // When several devices share a control the plain On/Off label is a lie about which one.
  const items = new Set(control.options.map((o) => o.item));
  const ambiguous = items.size > 1;
  return control.options.map((option) =>
    el('button', {
      class: `btn${option.value === true ? ' on' : ''}`,
      title: `row ${option.rowId} · ${option.item}`,
      onclick: (e) => fireCapability(e.target, control, option.value, option.rowId),
    }, ambiguous ? `${option.item} ${option.label}` : option.label),
  );
}

async function fireCapability(button, control, value, rowId) {
  const label = button.textContent;
  button.disabled = true;
  button.classList.add('busy');
  button.textContent = '…';
  try {
    const result = await api(`/rooms/${state.room.id}/capability`, {
      method: 'POST',
      body: JSON.stringify({
        capability: control.capability,
        zone: control.zone,
        value,
        propertyId: state.propertyId,
      }),
    });
    logCapability(control, value, result, rowId);
    if (result.status === 'rejected') toast(result.message ?? 'rejected', 'err');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
    button.textContent = label;
  }
}

/* ---------- raw commands ---------- */

function renderCommands() {
  const d = state.detail;
  $('#commands').replaceChildren(
    el('div', { class: 'note' },
      'The rows underneath, fired exactly as stored. Use these when a capability is missing ' +
      'and you need to know whether the command exists at all.'),
    ...d.commands.map((cmd) =>
      el(
        'div',
        { class: `cmd${cmd.inert ? ' inert' : ''}` },
        el('span', { class: 'id', text: cmd.id }),
        el('span', { class: 'name', text: cmd.stateName }),
        el('span', { class: 'method', text: cmd.apiMethod }),
        el('span', { class: 'path', text: pathOf(cmd.apiUrl), title: cmd.apiUrl }),
        cmd.inert ? el('span', { class: 'inert-tag', text: 'PING - controls nothing' }) : null,
        el('button', {
          class: 'btn small',
          onclick: (e) => fireCommand(e.target, cmd),
        }, 'Fire'),
      ),
    ),
  );
}

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url ?? '-';
  }
};

async function fireCommand(button, cmd) {
  button.disabled = true;
  button.textContent = '…';
  try {
    const result = await api(`/rooms/${state.room.id}/command`, {
      method: 'POST',
      body: JSON.stringify({ commandId: cmd.id, ...(cmd.stateValue === null ? { value: 21 } : {}) }),
    });
    logCommand(cmd, result);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Fire';
  }
}

/* ---------- wire log ---------- */

function entry(status, title, subtitle, lines) {
  const log = $('#wire-log');
  if (log.querySelector('.empty')) log.replaceChildren();
  const ok = status === 'pending' || status === 'applied';
  log.prepend(
    el(
      'div',
      { class: 'entry' },
      el(
        'div',
        { class: 'entry-head' },
        el('span', { class: `status ${ok ? 'ok' : 'bad'}`, text: status }),
        el('span', { text: title }),
        el('span', { class: 'when', text: new Date().toLocaleTimeString() }),
      ),
      el(
        'div',
        { class: 'entry-body' },
        subtitle ? el('div', { class: 'line' }, el('span', { class: 'k', text: '' }), el('span', { class: 'v', text: subtitle })) : null,
        ...lines.map(([k, v, sent]) =>
          el('div', { class: 'line' },
            el('span', { class: 'k', text: k }),
            el('span', { class: `v${sent ? ' sent' : ''}`, text: v })),
        ),
      ),
    ),
  );
  while (log.children.length > 40) log.lastChild.remove();
}

function logCapability(control, value, result, rowId) {
  const lines = [['asked', JSON.stringify(result.asked), true], ['took', `${result.ms}ms`]];
  // If the adapter chose a different row than the button, the ambiguity just bit.
  const chosen = /row (\d+)/.exec(result.message ?? '')?.[1];
  if (rowId && chosen && Number(chosen) !== rowId) {
    lines.unshift(['note', `you pressed row ${rowId}; the adapter chose row ${chosen}`]);
  }
  entry(
    result.status,
    `${control.capability}${control.zone ? `/${control.zone}` : ''} = ${value}`,
    result.message ?? '',
    lines,
  );
}

function logCommand(cmd, result) {
  const lines = [
    ['sent', `${result.request.method} ${result.request.url}`, true],
    ...(result.request.body ? [['body', JSON.stringify(result.request.body), true]] : []),
    ...(result.response ? [['reply', `${result.response.status} ${result.response.body}`]] : []),
    ...(result.error ? [['error', result.error]] : []),
    ['took', `${result.ms}ms`],
  ];
  entry(result.status, `${cmd.stateName} (row ${cmd.id})`, cmd.serviceName, lines);
}

/* ---------- head-end status ---------- */

async function pollHeadEnd() {
  try {
    const c = await api('/captured');
    const pill = $('#head-end-pill');
    pill.className = `pill ${c.reachable ? 'ok' : 'err'}`;
    pill.textContent = c.reachable ? `head-end · ${c.count} received` : 'head-end down';
  } catch {
    $('#head-end-pill').className = 'pill err';
    $('#head-end-pill').textContent = 'head-end down';
  }
}

/* ---------- wiring ---------- */

function wire() {
  $('#property-select').addEventListener('change', async (e) => {
    state.propertyId = Number(e.target.value);
    state.room = null;
    $('#tabs').hidden = true;
    $('#room-title').textContent = 'Pick a room';
    $('#room-meta').textContent = '';
    $('#controls').replaceChildren();
    await loadRooms();
  });

  $('#room-filter').addEventListener('input', renderRooms);

  $('#side-mode').addEventListener('click', (e) => {
    const button = e.target.closest('.seg-btn');
    if (!button) return;
    state.mode = button.dataset.mode;
    $$('#side-mode .seg-btn').forEach((b) => b.classList.toggle('active', b === button));
    $('#only-controllable').closest('.check').hidden = state.mode === 'devices';
    renderRooms();
  });

  $('#only-controllable').addEventListener('change', (e) => {
    state.onlyControllable = e.target.checked;
    renderRooms();
  });

  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.tab = tab.dataset.tab;
    $$('#tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#panel-capabilities').hidden = state.tab !== 'capabilities';
    $('#panel-commands').hidden = state.tab !== 'commands';
  });

  $('#clear-wire').addEventListener('click', async () => {
    $('#wire-log').replaceChildren(el('p', { class: 'empty', text: 'Cleared.' }));
    await api('/captured', { method: 'DELETE' }).catch(() => {});
    pollHeadEnd();
  });
}

async function boot() {
  wire();
  try {
    await loadProperties();
  } catch (err) {
    toast(`Could not load rooms: ${err.message}`, 'err');
  }
  pollHeadEnd();
  setInterval(pollHeadEnd, 5000);
}

boot();

mountThemeToggle(document.querySelector('#topbar-right'));
