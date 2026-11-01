/** Interactive PTA login. Cookies stay in the main process and reach Core only over stdin. */
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { nodeExecutable } = require('./node.cjs')

function ptaUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.port && (url.hostname === 'pintia.cn' || url.hostname.endsWith('.pintia.cn')) } catch { return false }
}
function cookieHeader(cookies) {
  return cookies.filter(cookie => ['PTASession', 'JSESSIONID'].includes(cookie.name) && ['pintia.cn', '.pintia.cn'].includes(cookie.domain))
    .map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}
function importCookies(raw, profileDir, { run = spawn, runtime = nodeExecutable(), signal } = {}) {
  return new Promise(resolve => {
    const child = run(runtime, [path.join(__dirname, 'pta-import.mjs')], {
      env: { ...process.env, CAMPUS_PROFILE_DIR: profileDir }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = '', done = false
    const finish = result => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(result) }
    const cancel = () => { child.kill(); finish({ status: 'error' }) }
    const timer = setTimeout(() => { child.kill(); finish({ status: 'error' }) }, 30_000)
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-1024) })
    child.stdin.on('error', () => {})
    child.on('error', () => finish({ status: 'error' }))
    child.on('close', () => {
      try {
        const result = JSON.parse(output)
        finish(['saved', 'pending', 'mismatch', 'error'].includes(result.status) ? { status: result.status } : { status: 'error' })
      } catch { finish({ status: 'error' }) }
    })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    else child.stdin.end(raw)
  })
}

function createPtaLogin({ BrowserWindow, session, parent, profileDir, verify = (raw, options) => importCookies(raw, profileDir, options), timers = globalThis }) {
  let active
  return {
    open() {
      if (active) { active.window.show(); active.window.focus(); return active.promise }
      const partition = session.fromPartition(`pta-login-${randomUUID()}`)
      partition.setPermissionRequestHandler((_contents, _permission, reply) => reply(false))
      partition.setPermissionCheckHandler(() => false)
      const window = new BrowserWindow({ parent, width: 1000, height: 760, title: '登录 PTA · 完成后自动保存',
        webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      const abort = new AbortController()
      let settle, finished = false, checking = false, last = ''
      const promise = new Promise(resolve => { settle = resolve })
      active = { window, promise }
      const finish = result => {
        if (finished) return
        finished = true
        abort.abort()
        timers.clearInterval(interval); timers.clearTimeout(timeout)
        partition.cookies.removeListener('changed', check)
        active = undefined
        if (!window.isDestroyed()) window.destroy()
        void partition.clearStorageData().catch(() => {})
        settle(result)
      }
      async function check() {
        if (finished || checking) return
        checking = true
        try {
          const raw = cookieHeader(await partition.cookies.get({ url: 'https://pintia.cn/' }))
          if (!raw.includes('PTASession=') || raw === last) return
          last = raw
          const result = await verify(raw, { signal: abort.signal })
          if (finished) return
          if (result.status === 'saved') finish({ status: 'saved' })
          else if (result.status === 'mismatch') finish({ status: 'error', message: '网页登录的 PTA 邮箱与应用里保存的不一致，请使用同一个账号。' })
          else if (result.status === 'error') finish({ status: 'error', message: '验证登录状态失败，请检查网络后重试。' })
        } catch { if (!finished) finish({ status: 'error', message: '无法读取登录状态，请重新打开 PTA 登录窗口。' }) }
        finally { checking = false }
      }
      const interval = timers.setInterval(check, 2000)
      const timeout = timers.setTimeout(() => finish({ status: 'error', message: '登录窗口已超时，请重新打开。' }), 15 * 60_000)
      partition.cookies.on('changed', check)
      window.webContents.on('did-finish-load', () => { last = ''; void check() })
      for (const event of ['will-navigate', 'will-redirect']) window.webContents.on(event, (event, url) => { if (!ptaUrl(url)) event.preventDefault() })
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (ptaUrl(url)) void window.loadURL(url).catch(() => finish({ status: 'error', message: 'PTA 页面打开失败，请检查网络后重试。' }))
        return { action: 'deny' }
      })
      window.once('closed', () => finish({ status: 'cancelled' }))
      void window.loadURL('https://pintia.cn/auth/login').catch(() => finish({ status: 'error', message: 'PTA 页面打开失败，请检查网络后重试。' }))
      return promise
    },
    close() { if (active && !active.window.isDestroyed()) active.window.close() },
  }
}
module.exports = { createPtaLogin, cookieHeader, ptaUrl, importCookies }
