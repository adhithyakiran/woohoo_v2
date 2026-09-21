/* What is physically in a room: the voice hub, and the devices it can drive. */
import { mountThemeToggle } from '/theme.js';

const $ = (s) => document.querySelector(s);
const state = { propertyId: null, rooms: [], room: null, onlyControllable: true };

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

/* ---------- rooms ---------- */

async function loadProperties() {
  const { properties } = await api('/properties');
  const withRooms = properties.filter((p) => p.rooms > 0);
  $('#property-select').replaceChildren(
    ...withRooms.map((p) =>
      el('option', { value: p.id }, `${p.name} - ${p.rooms} rooms, ${p.commands} commands`),
    ),
  );
  state.propertyId = withRooms.some((p) => p.id === 167) ? 167 : withRooms[0]?.id;
  $('#property-select').value = state.propertyId;
  await loadRooms();
}

async function loadRooms() {
  const { rooms } = await api(`/properties/${state.propertyId}/rooms`);
  state.rooms = rooms;
  renderRooms();
}

function renderRooms() {
  const filter = $('#room-filter').value.trim().toLowerCase();
  const shown = state.rooms.filter((r) => {
    if (state.onlyControllable && !r.commands) return false;
    return !filter || String(r.roomNo).toLowerCase().includes(filter);
  });

  $('#sidebar-foot').textContent =
    `${state.rooms.length} rooms · ${state.rooms.filter((r) => r.commands).length} controllable`;

  $('#room-list').replaceChildren(
    ...shown.map((r) =>
      el(
        'button',
        {
          class: `room-item${state.room === r.id ? ' active' : ''}${r.commands ? '' : ' dead'}`,
          onclick: () => openRoom(r.id),
        },
        el('span', { class: `dot ${r.hub_status ?? ''}` }),
        el('span', { class: 'no', text: r.roomNo }),
        el('span', { class: 'meta', text: r.commands ? `${r.commands} cmds` : 'none' }),
      ),
    ),
  );
  if (!shown.length) {
    $('#room-list').replaceChildren(el('p', { class: 'empty', text: 'Nothing matches.' }));
  }
}

/* ---------- one room ---------- */

const field = (label, value) =>
  el('div', { class: 'field' },
    el('span', { class: 'fk', text: label }),
    el('span', { class: 'fv', text: value ?? '-' }));

const ZONE_LABEL = {
  bedroom: 'Bedroom',
  bathroom: 'Bathroom',
  living: 'Living room',
  entrance: 'Entrance',
};

/** A glyph per device kind - enough to scan a room without reading every label. */
function iconFor(item) {
  const name = `${item.item} ${item.capability ?? ''}`.toLowerCase();
  if (name.includes('curtain') || name.includes('drape')) return '▤';
  if (name.includes('temperature') || name.includes('setpoint')) return '☀';
  if (name.includes('fan')) return '✵';
  if (name.includes('dnd') || name.includes('disturb')) return '⛔';
  if (name.includes('tv')) return '▭';
  if (name.includes('mur') || name.includes('make up')) return '⚑';
  return '●';
}

function hubCard(hub) {
  if (!hub) {
    return el('div', { class: 'note warn' },
      'No hub is bound to this room. Nothing can hear a guest here, and no device certificate resolves to it.');
  }
  const online = hub.connectionStatus === 'online';
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('span', { class: 'device-icon', text: '◉' }),
      el('span', { class: 'card-title', text: hub.name || hub.hubId }),
      el('span', { class: `pill ${online ? 'ok' : 'err'}`, text: hub.connectionStatus ?? 'unknown' })),
    el('div', { class: 'fields' },
      field('hub id', hub.hubId),
      field('mac', hub.macAddress),
      field('ip', hub.ipAddress),
      field('wifi', `${hub.wifiName ?? '-'} (${hub.wifiStatus ?? '-'})`),
      field('battery', hub.battery != null ? `${hub.battery}%` : null),
      field('app', hub.appVersion),
      field('firmware', hub.firmwareVersion),
      field('locale', hub.locale),
      field('timezone', hub.timeZone),
      field('last seen', hub.lastLogin ? new Date(hub.lastLogin).toLocaleString() : null)));
}

/** One device, with every endpoint it can be driven through. */
function deviceCard(item) {
  const dead = item.inert === item.states.length;
  return el('div', { class: `card device${dead ? ' dead' : ''}` },
    el('div', { class: 'card-head' },
      el('span', { class: 'device-icon', text: iconFor(item) }),
      el('span', { class: 'card-title', text: item.item }),
      el('span', { class: 'muted', text: `${item.kind} · ${item.vendors.join(', ')}` }),
      item.capability
        ? el('span', { class: 'pill ok', text: item.capability })
        : el('span', { class: 'pill warn', text: 'not addressable by the agent' })),
    item.unmappedReason && !item.capability
      ? el('div', { class: 'note warn', text: item.unmappedReason })
      : null,
    dead
      ? el('div', { class: 'note warn' },
          'Every command for this device points at a health-check endpoint. It answers 200 and controls nothing.')
      : null,
    el('table', { class: 'states' },
      el('tbody', {},
        ...item.states.map((st) =>
          el('tr', { class: st.inert ? 'inert' : '' },
            el('td', { class: 'sid', text: st.id }),
            el('td', { class: 'sname', text: st.stateName }),
            el('td', { class: 'sval', text: st.stateValue ?? 'takes a value' }),
            el('td', { class: 'smethod', text: st.method ?? '' }),
            el('td', { class: 'spath', text: st.path ?? '', title: st.path ?? '' }),
            el('td', { class: 'sinert', text: st.inert ? 'ping' : '' }))))));
}

async function openRoom(roomId) {
  state.room = roomId;
  renderRooms();
  $('#detail').replaceChildren(el('p', { class: 'empty', text: 'Loading…' }));

  const d = await api(`/rooms/${roomId}/devices`);
  $('#room-title').textContent = `Room ${d.room.roomNo}`;
  $('#room-meta').textContent =
    `${d.room.property ?? '-'} · masterdb id ${d.room.id} · ${d.room.type ?? 'no type'} · status ${d.room.status ?? '-'}`;

  // Laid out by the zone each device lives in, so the page reads like the room rather
  // than like the table it came from. Room-wide devices get their own group.
  const groups = new Map();
  for (const item of d.items) {
    const zone = item.capability?.includes('/') ? item.capability.split('/')[1] : null;
    const key = zone ?? 'whole room';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const ordered = [...groups].sort((a, b) =>
    a[0] === 'whole room' ? 1 : b[0] === 'whole room' ? -1 : a[0].localeCompare(b[0]));

  const zones = ordered.map(([zone, items]) => {
    const broken = items.filter((i) => i.inert === i.states.length).length;
    return el('section', { class: 'zone' },
      el('div', { class: 'zone-head' },
        el('span', { class: 'zone-name', text: ZONE_LABEL[zone] ?? zone }),
        el('span', { class: 'muted', text: `${items.length} device${items.length === 1 ? '' : 's'}` }),
        broken ? el('span', { class: 'pill warn', text: `${broken} inert` }) : null),
      el('div', { class: 'zone-devices' }, ...items.map(deviceCard)));
  });

  $('#detail').replaceChildren(
    el('div', { class: 'group-title', text: 'voice hub' }),
    hubCard(d.hub),
    el('div', { class: 'group-title', text: `devices in the room (${d.items.length})` }),
    d.items.length
      ? el('div', { class: 'zones' }, ...zones)
      : el('p', { class: 'empty', text: 'No devices - this room has no automation commands.' }),
  );
}

/* ---------- wiring ---------- */

$('#property-select').addEventListener('change', async (e) => {
  state.propertyId = Number(e.target.value);
  state.room = null;
  $('#room-title').textContent = 'Pick a room';
  $('#room-meta').textContent = '';
  $('#detail').replaceChildren();
  await loadRooms();
});
$('#room-filter').addEventListener('input', renderRooms);
$('#only-controllable').addEventListener('change', (e) => {
  state.onlyControllable = e.target.checked;
  renderRooms();
});

mountThemeToggle($('#topbar-right'));
loadProperties().catch((err) => {
  $('#detail').replaceChildren(el('p', { class: 'empty', text: err.message }));
});
