import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A local Postgres to replicate into, for the common case where the machine has
 * Docker but no server installed. Everything here is best-effort: if Docker is
 * missing the UI just falls back to asking for connection details.
 */

async function docker(args, timeout = 60_000) {
  const { stdout } = await run('docker', args, { timeout, windowsHide: true });
  return stdout.trim();
}

export async function available() {
  try {
    const version = await docker(['version', '--format', '{{.Server.Version}}'], 15_000);
    return { available: true, version };
  } catch (err) {
    return { available: false, reason: reasonFor(err) };
  }
}

/** Docker's failure output is several lines of daemon paths; the UI wants one line. */
function reasonFor(err) {
  if (err.code === 'ENOENT') return 'Docker is not installed';
  const detail = `${err.stderr || err.message}`.split('\n').find((l) => l.trim());
  if (/daemon|pipe|connect/i.test(detail ?? '')) return 'the Docker daemon is not running';
  return (detail ?? 'unknown error').slice(0, 140);
}

export async function status(name) {
  try {
    const out = await docker([
      'inspect',
      name,
      '--format',
      '{{.State.Status}}|{{.State.Health.Status}}|{{.Config.Image}}',
    ], 15_000);
    const [state, health, image] = out.split('|');
    return { exists: true, state, health: health === '<no value>' ? null : health, image };
  } catch {
    return { exists: false, state: 'absent', health: null, image: null };
  }
}

export async function up({ container, image, port, password, database = 'postgres' }) {
  const steps = [];
  const existing = await status(container);

  if (!existing.exists) {
    steps.push(`Pulling ${image} (first run only)…`);
    await docker(['pull', image], 300_000).catch(() => {
      steps.push('Pull failed - trying the local image cache.');
    });
    steps.push(`Creating container ${container} on port ${port}.`);
    await docker(
      [
        'run',
        '-d',
        '--name', container,
        '-e', `POSTGRES_PASSWORD=${password}`,
        '-e', `POSTGRES_DB=${database}`,
        '-p', `${port}:5432`,
        '--restart', 'unless-stopped',
        '--health-cmd', 'pg_isready -U postgres',
        '--health-interval', '3s',
        '--health-retries', '20',
        image,
      ],
      300_000,
    );
  } else if (existing.state !== 'running') {
    steps.push(`Starting existing container ${container}.`);
    await docker(['start', container], 60_000);
  } else {
    steps.push(`Container ${container} is already running.`);
  }

  steps.push('Waiting for Postgres to accept connections…');
  const ready = await waitReady(container);
  steps.push(ready ? 'Postgres is ready.' : 'Timed out waiting for Postgres to become ready.');
  return { ok: ready, steps, status: await status(container) };
}

export async function stop(container) {
  await docker(['stop', container], 60_000);
  return status(container);
}

async function waitReady(container, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await docker(['exec', container, 'pg_isready', '-U', 'postgres'], 10_000);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}
