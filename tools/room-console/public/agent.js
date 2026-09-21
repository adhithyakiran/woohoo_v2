/**
 * Every turn the agent handles, and the exact API requests it caused.
 *
 * The gateway already records a `vendorCalls` list per turn, so nothing here is
 * time-correlated or guessed: each request shown belongs to the turn above it.
 */
import { mountThemeToggle } from '/theme.js';

const $ = (s) => document.querySelector(s);
const GATEWAY = 'http://localhost:8443';
const turns = new Map();
let selected = null;

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

const time = (iso) => new Date(iso ?? Date.now()).toLocaleTimeString();

function renderList() {
  const list = $('#turns');
  const ordered = [...turns.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  if (!ordered.length) {
    list.replaceChildren(el('p', { class: 'empty', text: 'Waiting for a turn…' }));
    return;
  }

  list.replaceChildren(
    ...ordered.map((t) => {
      const calls = t.vendorCalls ?? [];
      const failed = (t.calls ?? []).some((c) => c.ok === false);
      return el(
        'button',
        {
          class: `turn${selected === t.turnId ? ' selected' : ''}`,
          onclick: () => {
            selected = t.turnId;
            renderList();
            renderDetail(t);
          },
        },
        el('div', { class: 'turn-head' },
          el('span', { class: `tag ${t.lane ?? ''}`, text: t.lane ?? 'turn' }),
          el('span', { class: 'muted', text: time(t.at) }),
          calls.length
            ? el('span', { class: 'pill ok', text: `${calls.length} api` })
            : el('span', { class: 'pill', text: 'no api call' }),
          failed ? el('span', { class: 'pill err', text: 'tool failed' }) : null),
        el('div', { class: 'turn-said', text: t.transcript ?? '' }),
        el('div', { class: 'turn-reply', text: t.speech ?? '' }),
      );
    }),
  );
}

function kv(k, v) {
  return el('div', { class: 'field' },
    el('span', { class: 'fk', text: k }),
    el('span', { class: 'fv', text: v ?? '-' }));
}

function block(label, value) {
  return [el('div', { class: 'dk', text: label }), el('pre', { class: 'dv', text: value })];
}

function renderDetail(t) {
  const parts = [
    el('div', { class: 'detail-head' },
      el('span', { class: 'card-title', text: t.transcript ?? '(no transcript)' }),
      el('span', { class: 'muted', text: t.turnId ?? '' })),
    el('div', { class: 'fields' },
      kv('reply', t.speech),
      kv('lane', t.lane),
      kv('total', t.totalMs != null ? `${t.totalMs} ms` : null),
      kv('cost', t.costUsd != null ? `$${Number(t.costUsd).toFixed(6)}` : null),
      kv('escalated', String(Boolean(t.escalated)))),
  ];

  // What the model proposed and what the policy did about it.
  const calls = t.calls ?? [];
  parts.push(el('div', { class: 'dk', text: `tools proposed (${calls.length})` }));
  if (!calls.length) {
    parts.push(el('p', { class: 'empty', text: 'The agent answered without calling anything.' }));
  }
  for (const c of calls) {
    parts.push(
      el('div', { class: `card${c.ok === false ? ' dead' : ''}` },
        el('div', { class: 'card-head' },
          el('span', { class: 'card-title', text: c.tool }),
          el('span', { class: 'pill', text: c.tier ?? '' }),
          el('span', { class: `pill ${c.verdict === 'ALLOW' ? 'ok' : 'err'}`, text: c.verdict ?? '' }),
          c.ok === false ? el('span', { class: 'pill err', text: c.error ?? 'failed' }) : null),
        c.reason ? el('div', { class: 'muted', text: c.reason }) : null),
    );
  }

  // The requests that actually left the building.
  const vendor = t.vendorCalls ?? [];
  parts.push(el('div', { class: 'dk', text: `api requests sent (${vendor.length})` }));
  if (!vendor.length) {
    parts.push(el('p', { class: 'empty', text: 'No request reached a head-end for this turn.' }));
  }
  for (const v of vendor) {
    const inert = /health-check/.test(v.note ?? '');
    parts.push(
      el('div', { class: `card${inert ? ' dead' : ''}` },
        el('div', { class: 'card-head' },
          el('span', { class: 'method', text: v.method }),
          el('span', { class: 'card-title mono', text: v.url }),
          el('span', { class: `pill ${v.ok ? 'ok' : 'err'}`, text: String(v.status) }),
          el('span', { class: 'muted', text: `${v.ms} ms` })),
        inert
          ? el('div', { class: 'note warn', text: 'This endpoint is a health check. It answered 200 and controlled nothing.' })
          : null,
        el('div', { class: 'fields' },
          kv('vendor', v.vendor),
          kv('capability', `${v.capability ?? '-'}${v.zone ? ` / ${v.zone}` : ''}`),
          kv('object', v.objectId),
          kv('source', v.note)),
        ...block('request body', v.requested === undefined ? '(none)' : JSON.stringify(v.requested, null, 2)),
        ...block('response', typeof v.observed === 'string' ? v.observed : JSON.stringify(v.observed ?? '(none)', null, 2))),
    );
  }

  $('#detail').replaceChildren(...parts.filter(Boolean));
}

function connect() {
  const source = new EventSource(`${GATEWAY}/v1/events`);

  source.onopen = () => {
    $('#feed-pill').className = 'pill ok';
    $('#feed-pill').textContent = 'feed live';
  };
  source.onerror = () => {
    $('#feed-pill').className = 'pill err';
    $('#feed-pill').textContent = 'gateway down';
  };
  source.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!event.turnId) return;

    // turn.received arrives first and carries no result; turn.completed replaces it.
    const existing = turns.get(event.turnId) ?? {};
    turns.set(event.turnId, { ...existing, ...event });
    if (turns.size > 100) turns.delete([...turns.keys()][0]);

    renderList();
    if (selected === event.turnId) renderDetail(turns.get(event.turnId));
  };
}

$('#clear').addEventListener('click', () => {
  turns.clear();
  selected = null;
  renderList();
  $('#detail').replaceChildren(el('p', { class: 'empty', text: 'Cleared.' }));
});

mountThemeToggle($('#topbar-right'));
renderList();
connect();
