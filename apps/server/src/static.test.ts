import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from './server';

let server: RunningServer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg3d-'));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html>INDEX');
  writeFileSync(join(web, 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'SECRET'); // right next to the web directory
  server = await startServer(0, [], web);
});
afterAll(async () => { await server.close(); });

describe('static web app', () => {
  it('serves files with their content type and falls back to index.html', async () => {
    const js = await fetch(`${server.url}/app.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript');
    expect(await (await fetch(`${server.url}/sala/ABC123`)).text()).toContain('INDEX');
  });

  it('never serves files outside the web directory', async () => {
    for (const path of ['/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%5csecret.txt', '/%2e%2e%2f%2e%2e%2fweb%2f..%2fsecret.txt']) {
      const res = await fetch(`${server.url}${path}`);
      expect(await res.text()).not.toContain('SECRET');
    }
  });
});
