import { describe, expect, it } from 'vitest';

import {
  constraintStatements,
  createEnum,
  createSequence,
  createTable,
  schemaScript,
  standaloneIndexes,
} from './ddl.js';
import { ident, literal, qualify } from './introspect.js';

const column = (over = {}) => ({
  name: 'id',
  type: 'integer',
  not_null: true,
  default_expr: null,
  identity: '',
  generated: '',
  comment: null,
  ...over,
});

const table = (over = {}) => ({
  name: 'rooms',
  schema_source: 'public',
  comment: null,
  columns: [column()],
  indexes: [],
  constraints: [],
  ...over,
});

describe('identifier quoting', () => {
  it('quotes camel case and escapes embedded quotes', () => {
    expect(ident('roomNo')).toBe('"roomNo"');
    expect(ident('we"ird')).toBe('"we""ird"');
    expect(qualify('public', 'about-items')).toBe('"public"."about-items"');
  });

  it('escapes apostrophes in literals', () => {
    expect(literal("it's")).toBe("'it''s'");
  });
});

describe('createTable', () => {
  it('carries defaults, nullability and comments-free column order', () => {
    const sql = createTable(
      'public',
      table({
        columns: [
          column({ default_expr: "nextval('rooms_id_seq'::regclass)" }),
          column({ name: 'roomNo', type: 'character varying(10)', not_null: false }),
        ],
      }),
    );
    expect(sql).toContain('CREATE TABLE "public"."rooms"');
    expect(sql).toContain(`"id" integer DEFAULT nextval('rooms_id_seq'::regclass) NOT NULL`);
    expect(sql).toContain('"roomNo" character varying(10)');
    expect(sql).not.toContain('"roomNo" character varying(10) NOT NULL');
  });

  it('reproduces identity and generated columns instead of their defaults', () => {
    const sql = createTable(
      'public',
      table({
        columns: [
          column({ identity: 'a' }),
          column({ name: 'total', type: 'integer', generated: 's', default_expr: '(a + b)' }),
        ],
      }),
    );
    expect(sql).toContain('"id" integer GENERATED ALWAYS AS IDENTITY NOT NULL');
    expect(sql).toContain('"total" integer GENERATED ALWAYS AS ((a + b)) STORED NOT NULL');
  });
});

describe('enums and sequences', () => {
  it('quotes every label', () => {
    expect(createEnum('public', { name: 'scope', labels: ['default', "guest's"] })).toBe(
      `CREATE TYPE "public"."scope" AS ENUM ('default', 'guest''s')`,
    );
  });

  it('spells out every sequence parameter so the copy starts where the source is', () => {
    const sql = createSequence('public', {
      name: 'rooms_id_seq',
      data_type: 'bigint',
      start: '1',
      increment: '1',
      min_value: '1',
      max_value: '9223372036854775807',
      cache: '1',
      cycle: false,
    });
    expect(sql).toContain('CREATE SEQUENCE IF NOT EXISTS "public"."rooms_id_seq" AS bigint');
    expect(sql).toContain('START WITH 1');
    expect(sql).toContain('NO CYCLE');
  });
});

describe('indexes and constraints', () => {
  const withKeys = table({
    indexes: [
      { name: 'rooms_pkey', definition: 'CREATE UNIQUE INDEX rooms_pkey ON public.rooms USING btree (id)', is_primary: true, is_unique: true },
      { name: 'rooms_hubId_key', definition: 'CREATE UNIQUE INDEX "rooms_hubId_key" ON public.rooms USING btree ("hubId")', is_primary: false, is_unique: true },
      { name: 'rooms_hubId_idx', definition: 'CREATE INDEX "rooms_hubId_idx" ON public.rooms USING btree ("hubId")', is_primary: false, is_unique: false },
    ],
    constraints: [
      { name: 'rooms_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
      { name: 'rooms_hubId_key', type: 'u', definition: 'UNIQUE ("hubId")' },
      { name: 'rooms_hubId_fkey', type: 'f', definition: 'FOREIGN KEY ("hubId") REFERENCES hubs(id)' },
    ],
  });

  it('skips the indexes Postgres builds for a key on its own', () => {
    const names = standaloneIndexes('public', withKeys).map((i) => i.name);
    expect(names).toEqual(['rooms_hubId_idx']);
  });

  it('splits keys from foreign keys so they can be applied in different phases', () => {
    expect(constraintStatements('public', withKeys, ['p', 'u']).map((c) => c.name)).toEqual([
      'rooms_pkey',
      'rooms_hubId_key',
    ]);
    const [fk] = constraintStatements('public', withKeys, ['f']);
    expect(fk.sql).toBe(
      'ALTER TABLE "public"."rooms" ADD CONSTRAINT "rooms_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES hubs(id)',
    );
  });
});

describe('schemaScript', () => {
  const script = schemaScript({
    schema: 'public',
    enums: [{ name: 'scope', labels: ['a'] }],
    sequences: [
      {
        name: 'rooms_id_seq',
        data_type: 'bigint',
        start: '1',
        increment: '1',
        min_value: '1',
        max_value: '99',
        cache: '1',
        cycle: false,
        owned_by_table: 'rooms',
        owned_by_column: 'id',
      },
    ],
    views: [{ name: 'v_rooms', kind: 'v', definition: 'SELECT id FROM rooms;' }],
    tables: [
      table({
        comment: 'guest rooms',
        constraints: [
          { name: 'rooms_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
          { name: 'rooms_hubId_fkey', type: 'f', definition: 'FOREIGN KEY ("hubId") REFERENCES hubs(id)' },
        ],
      }),
    ],
  });

  const at = (needle) => script.indexOf(needle);

  it('creates types and sequences before the tables that use them', () => {
    expect(at('CREATE TYPE')).toBeLessThan(at('CREATE SEQUENCE'));
    expect(at('CREATE SEQUENCE')).toBeLessThan(at('CREATE TABLE'));
  });

  it('leaves foreign keys until after every table exists', () => {
    expect(at('CREATE TABLE')).toBeLessThan(at('rooms_pkey'));
    expect(at('rooms_pkey')).toBeLessThan(at('rooms_hubId_fkey'));
  });

  it('includes ownership, comments and views', () => {
    expect(script).toContain('ALTER SEQUENCE "public"."rooms_id_seq" OWNED BY "public"."rooms"."id"');
    expect(script).toContain(`COMMENT ON TABLE "public"."rooms" IS 'guest rooms'`);
    expect(script).toContain('CREATE VIEW "public"."v_rooms" AS');
  });
});
