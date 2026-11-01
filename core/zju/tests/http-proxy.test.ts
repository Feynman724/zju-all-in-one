import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpClient } from '../lib/core/http.ts';

test('campus HTTP requests honor the configured proxy and NO_PROXY', async t => {
  const keys = ['HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const requests: string[] = [];
  const proxy = http.createServer((req, res) => { requests.push(req.url!); res.end('via-proxy'); });
  const direct = http.createServer((_req, res) => { res.end('direct'); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => direct.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as import('node:net').AddressInfo).port;
  const directPort = (direct.address() as import('node:net').AddressInfo).port;
  delete process.env.http_proxy; delete process.env.no_proxy;
  process.env.HTTP_PROXY = `http://127.0.0.1:${port}`; process.env.NO_PROXY = '127.0.0.1';
  const client = new HttpClient({ timeout: 1000 });
  t.after(() => { client.destroy(); proxy.close(); direct.close(); for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  assert.equal((await client.request('http://campus-proxy-test.invalid/path')).body, 'via-proxy');
  assert.equal((await client.request(`http://127.0.0.1:${directPort}/`)).body, 'direct');
  assert.deepEqual(requests, ['http://campus-proxy-test.invalid/path']);
});
