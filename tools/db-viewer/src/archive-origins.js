#!/usr/bin/env node
import { rawClient } from './db.js';
import { source, target } from './config.js';

/**
 * Record where each command originally pointed, without re-planting the credential.
 *
 * sanitise-local.sql rewrites every apiUrl to the local head-end, which is the whole point
 * - but it also erases the answer to "what does this actually call in the hotel?". This
 * reads the production row (read-only) and stores the vendor URL and the *names* of the
 * headers it carried. Values are never copied: a working bearer token on a laptop is the
 * exact thing the sanitise exists to prevent.
 *
 *   npm run archive-origins
 */

const ARCHIVE = 'roomAutomationServiceOrigins';

async function main() {
  const src = await rawClient(source);
  const dst = await rawClient(target);

  try {
    await dst.query(`
      CREATE TABLE IF NOT EXISTS "${ARCHIVE}" (
        id            integer PRIMARY KEY,
        "apiMethod"   text,
        "apiUrl"      text,
        host          text,
        "headerNames" text[],
        "capturedAt"  timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await src.query(
      `select s.id, s."apiMethod", s."apiUrl",
              case when s."apiHeaders" is null then '{}'::text[]
                   else array(select key from json_each(s."apiHeaders")) end as "headerNames"
         from "roomAutomationServices" s
        where s."deletedAt" is null`,
    );

    let written = 0;
    const batch = 500;
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch);
      const values = [];
      const params = [];
      slice.forEach((r, n) => {
        const b = n * 5;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
        params.push(r.id, r.apiMethod, r.apiUrl, hostOf(r.apiUrl), r.headerNames);
      });
      await dst.query(
        `insert into "${ARCHIVE}" (id, "apiMethod", "apiUrl", host, "headerNames")
         values ${values.join(',')}
         on conflict (id) do update set
           "apiMethod" = excluded."apiMethod",
           "apiUrl"    = excluded."apiUrl",
           host        = excluded.host,
           "headerNames" = excluded."headerNames"`,
        params,
      );
      written += slice.length;
    }

    const { rows: hosts } = await dst.query(
      `select host, count(*)::int as commands from "${ARCHIVE}"
        where host is not null and host <> '' group by 1 order by 2 desc limit 8`,
    );

    console.log(`archived ${written} original endpoints into ${ARCHIVE}`);
    console.log('  (urls and header names only - no header values were copied)\n');
    for (const h of hosts) console.log(`  ${String(h.commands).padStart(6)}  ${h.host}`);
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
