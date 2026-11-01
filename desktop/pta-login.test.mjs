import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
const { createPtaLogin, cookieHeader, ptaUrl, importCookies } = createRequire(import.meta.url)('./pta-login.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(verify) {
  let window, rows = [], cleared = 0
  const cookies = Object.assign(new EventEmitter(), { get: async () => rows })
  const partition = { cookies, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, clearStorageData: async () => { cleared++ } }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = fn => { this.popup = fn }; window = this }
    loadURL(url) { this.url = url; return Promise.resolve() }
    isDestroyed() { return !!this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    close() { this.destroy() }
    show() {} focus() {}
  }
  const intervals = new Set(), timeouts = new Set()
  const timers = { setInterval: fn => (intervals.add(fn), fn), clearInterval: fn => intervals.delete(fn), setTimeout: fn => (timeouts.add(fn), fn), clearTimeout: fn => timeouts.delete(fn) }
  const login = createPtaLogin({ BrowserWindow: Window, session: { fromPartition: () => partition }, verify, timers })
  return { login, window: () => window, intervals, timeouts, cleared: () => cleared, change: async value => { rows = value; cookies.emit('changed'); await tick() } }
}
const cookie = value => [{ name: 'PTASession', value, domain: '.pintia.cn' }]

test('only PTA session cookies and HTTPS PTA navigation are accepted', () => {
  assert.equal(cookieHeader([...cookie('fixture'), {name:'tracking',value:'other',domain:'.pintia.cn'}, {name:'JSESSIONID',value:'bad',domain:'evil.test'}]), 'PTASession=fixture')
  for (const url of ['https://pintia.cn/auth/login', 'https://passport.pintia.cn/login']) assert.equal(ptaUrl(url), true)
  for (const url of ['http://pintia.cn', 'https://pintia.cn.evil.test', 'file:///tmp/a', 'https://pintia.cn:8443']) assert.equal(ptaUrl(url), false)
})
test('pending session is checked once; changed valid cookie saves and closes login, without exposing it', async () => {
  const calls = []
  const f = fixture(async raw => { calls.push(raw); return { status: calls.length === 1 ? 'pending' : 'saved' } })
  const result = f.login.open()
  assert.equal(f.login.open(), result)
  assert.equal(f.window().options.webPreferences.nodeIntegration, false)
  assert.equal(f.window().options.webPreferences.sandbox, true)
  await f.change(cookie('pending')); await f.change(cookie('pending'))
  assert.equal(calls.length, 1)
  await f.change(cookie('valid'))
  assert.deepEqual(await result, { status: 'saved' })
  assert.equal(f.intervals.size + f.timeouts.size, 0)
  assert.equal(f.cleared(), 1)
})
test('wrong account does not report success; closing a login aborts in-flight verification', async () => {
  const wrong = fixture(async () => ({ status: 'mismatch' }))
  const result = wrong.login.open(); await wrong.change(cookie('fixture'))
  assert.equal((await result).status, 'error')
  let resolve, signal
  const f = fixture((_raw, options) => { signal = options.signal; return new Promise(r => { resolve = r }) })
  const cancelled = f.login.open(); await f.change(cookie('fixture')); f.login.close()
  assert.equal(signal.aborted, true)
  resolve({ status: 'saved' }); await tick()
  assert.deepEqual(await cancelled, { status: 'cancelled' })
  assert.equal(f.intervals.size + f.timeouts.size, 0)
})
test('bridge sends cookies via stdin, never argv, and returns only an allowlisted status', async () => {
  let input = '', args, env
  const run = (_runtime, argv, options) => {
    args = argv; env = options.env
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} })
    child.stdin.on('data', chunk => { input += chunk })
    child.stdin.on('finish', () => { child.stdout.write(JSON.stringify({ status: 'saved', cookie: 'must-not-escape' })); child.emit('close', 0) })
    return child
  }
  assert.deepEqual(await importCookies('PTASession=private-fixture', '/isolated/profile', { run, runtime: '/fixture/node' }), { status: 'saved' })
  assert.equal(input, 'PTASession=private-fixture')
  assert.equal(args.some(arg => arg.includes('private-fixture')), false)
  assert.equal(env.CAMPUS_PROFILE_DIR, '/isolated/profile')
})

test('Core verifies imported session with GET only and never persists an account mismatch', async t => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { Pta } = await import('../core/zju/lib/pta/client.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pta-login-core-'))
  const before = process.env.ZJU_DATA_DIR
  process.env.ZJU_DATA_DIR = dir
  t.after(() => { if (before === undefined) delete process.env.ZJU_DATA_DIR; else process.env.ZJU_DATA_DIR = before; fs.rmSync(dir, {recursive:true,force:true}) })
  let email = 'other@example.test'
  const requests = []
  const ctx = { http: {}, close() {}, fetch: async (url, options) => {
    requests.push({ url, method: options.method ?? 'GET' })
    return { status: 200, headers: {}, json: () => ({ user: { id: 'fixture', email } }) }
  } }
  const client = new Pta(ctx, { username: 'student@example.test', password: 'never-submit' })
  await assert.rejects(client.importCookie('PTASession=fixture'), /不是同一个/)
  assert.equal(client.store.status().exists, false)
  email = 'student@example.test'
  await client.importCookie('PTASession=fixture; ignored=not-imported')
  assert.equal(client.store.status().exists, true)
  assert.deepEqual(requests, Array(2).fill({ url: 'https://passport.pintia.cn/api/u/current', method: 'GET' }))
  assert.deepEqual(client.store.load().jar.toJSON().map(c => c.name), ['PTASession'])
})

test('an unchanged browser session is rechecked after login completes server-side', async () => {
  let loggedIn = false, attempts = 0
  const f = fixture(async () => { attempts++; return { status: loggedIn ? 'saved' : 'pending' } })
  const result = f.login.open()
  await f.change(cookie('stable-session'))
  loggedIn = true
  for (const callback of f.intervals) callback()
  await tick()
  assert.equal(attempts, 2, 'same cookie must be revalidated after the server authenticates it')
  assert.deepEqual(await result, { status: 'saved' })
})
