import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type SyntheticPkg = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};
export type Registry = {
  url: string;
  port: number;
  stop(): Promise<void>;
  publish(pkg: SyntheticPkg): Promise<void>;
};

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly extra?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'RegistryError';
  }
}

/** gzipped npm tarball (package/ prefix) for a synthetic package, built with the system tar */
function tarball(pkg: SyntheticPkg): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'assay-pkg-'));
  mkdirSync(join(dir, 'package'));
  writeFileSync(
    join(dir, 'package', 'package.json'),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      main: 'index.js',
      dependencies: pkg.dependencies ?? {},
    }),
  );
  writeFileSync(
    join(dir, 'package', 'index.js'),
    `module.exports = '${pkg.name}@${pkg.version}';\n`,
  );
  // COPYFILE_DISABLE keeps macOS bsdtar from adding AppleDouble entries
  execFileSync('tar', ['-czf', 'pkg.tgz', 'package'], {
    cwd: dir,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return readFileSync(join(dir, 'pkg.tgz'));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitUntilReady(url: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 60_000;
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      throw new RegistryError('verdaccio exited before becoming ready', { output: output() });
    }
    try {
      const res = await fetch(`${url}-/ping`);
      if (res.ok) return;
    } catch {
      // not accepting connections yet — retry until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new RegistryError('verdaccio did not become ready in time', { output: output() });
}

/**
 * Hermetic Verdaccio on an ephemeral port: no uplinks, anonymous access/publish.
 *
 * Runs as a child process (not in-process): `relock` and the assay CLI spawn pnpm
 * *synchronously*, which blocks this process's event loop — an in-process registry
 * could never answer them.
 */
export async function startRegistry(): Promise<Registry> {
  const dir = mkdtempSync(join(tmpdir(), 'assay-verdaccio-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  writeFileSync(
    join(dir, 'config.yaml'),
    [
      'storage: ./storage',
      `listen: 127.0.0.1:${port}`,
      'web:',
      '  enable: false',
      'uplinks: {}',
      'packages:',
      "  '**':",
      '    access: $all',
      '    publish: $all',
      'security:',
      '  api:',
      '    legacy: true',
      'log:',
      '  level: fatal',
      '',
    ].join('\n'),
  );

  const verdaccioBin = createRequire(import.meta.url).resolve('verdaccio/bin/verdaccio');
  const child = spawn(process.execPath, [verdaccioBin, '--config', join(dir, 'config.yaml')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  // insurance against leaked children if the test process dies before stop()
  const killOnExit = () => child.kill('SIGKILL');
  process.once('exit', killOnExit);

  await waitUntilReady(url, child, () => output);

  async function publish(pkg: SyntheticPkg): Promise<void> {
    const tgz = tarball(pkg);
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    const tarName = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
    const doc = {
      _id: pkg.name,
      name: pkg.name,
      'dist-tags': { latest: pkg.version },
      versions: {
        [pkg.version]: {
          name: pkg.name,
          version: pkg.version,
          main: 'index.js',
          dependencies: pkg.dependencies ?? {},
          dist: { integrity, tarball: `${url}${encodeURIComponent(pkg.name)}/-/${tarName}` },
        },
      },
      _attachments: {
        [tarName]: {
          content_type: 'application/octet-stream',
          data: tgz.toString('base64'),
          length: tgz.length,
        },
      },
    };
    const res = await fetch(`${url}${encodeURIComponent(pkg.name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!res.ok && res.status !== 409) {
      throw new RegistryError('publish rejected by registry', {
        name: pkg.name,
        version: pkg.version,
        status: res.status,
        body: await res.text(),
      });
    }
  }

  return {
    url,
    port,
    publish,
    stop: () =>
      new Promise<void>((resolve) => {
        process.removeListener('exit', killOnExit);
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
