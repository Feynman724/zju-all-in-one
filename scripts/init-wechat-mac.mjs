// The privileged child only scans memory. Keychain writes run as the logged-in user.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { macProfile, databasePaths, firstPage, keyAccount, cachedKey, macHelper, wechatPid, requireReadableWeChat } from '../core/wechat/lib/mac.mjs'
import { verifyKey } from '../core/wechat/lib/snapshot.mjs'

async function storeKey(account, key) {
  await new Promise((resolve, reject) => {
    const child = spawn(macHelper, ['store', account], { stdio: ['pipe', 'pipe', 'ignore'] })
    child.on('error', reject)
    child.stdin.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(Error('系统钥匙串保存失败，请允许访问钥匙串后重试。')))
    child.stdin.end(key)
  })
}
try {
  if (process.platform !== 'darwin' || process.getuid() === 0) throw Error('请以当前登录用户运行初始化入口，不要对整个脚本使用 sudo。')
  const pid = await wechatPid()
  if (!pid) throw Error('请先打开并登录电脑版微信。')
  const profile = macProfile(), paths = databasePaths(profile.storage, 'init')
  const pending = []
  for (const file of paths) {
    const page = firstPage(file), key = await cachedKey(file, page)
    if (key) key.fill(0)
    else pending.push(file)
    page.fill(0)
  }
  if (pending.length) {
    // Reject a protected release build before asking for a password that cannot fix it.
    await requireReadableWeChat(async () => pid)
    // Obtain sudo authorization before stdout becomes a binary-only pipe.
    await new Promise((resolve, reject) => {
      const auth = spawn('/usr/bin/sudo', ['-v'], { stdio: 'inherit' })
      auth.on('error', reject)
      auth.on('close', code => code === 0 ? resolve() : reject(Error('未完成管理员授权。')))
    })
    console.log('正在读取微信内存中的数据库密钥（最多 90 秒）。不会输出密钥或聊天内容。')
    let output
    try {
      const result = await promisify(execFile)('/usr/bin/sudo', ['-n', macHelper, 'scan', String(pid), ...pending],
        { encoding: 'buffer', timeout: 110000, maxBuffer: 64 * 1024 })
      output = result.stdout
    } catch (error) {
      // Native helper stderr contains only fixed diagnostics, never process bytes or keys.
      error.stdout?.fill?.(0)
      if (error.code === 3) throw Error('macOS 拒绝读取微信进程，本次未取得密钥。可能涉及开发者工具权限或微信进程保护；不要反复提交管理员密码。')
      throw Error('未取得可验证的数据库密钥。请在微信中打开目标聊天后重试；当前微信版本也可能不兼容。')
    }
    try {
      if (output.length % 36) throw Error('密钥读取结果不完整。')
      for (let at = 0; at < output.length; at += 36) {
        const index = output.readUInt32LE(at), key = output.subarray(at + 4, at + 36)
        if (index >= pending.length) throw Error('密钥读取结果无效。')
        const file = pending[index], page = firstPage(file)
        try {
          if (!verifyKey(key, page)) throw Error('数据库已变化，请重新初始化。')
          await storeKey(keyAccount(file, page), key)
        } finally { page.fill(0) }
      }
    } finally { output.fill(0) }
  }
  let missing = 0, requiredMissing = false
  for (const file of paths) {
    const page = firstPage(file), key = await cachedKey(file, page)
    if (!key) { missing++; if (!/message_\d+\.db$/.test(file)) requiredMissing = true }
    key?.fill(0); page.fill(0)
  }
  if (requiredMissing) throw Error('联系人或会话数据库尚未解锁。请在微信中打开聊天列表后重试。')
  console.log(`已授权 ${paths.length - missing}/${paths.length} 个数据库；密钥保存在系统钥匙串。`)
  if (missing) console.log('部分旧记录库的密钥不在内存中。请打开相关聊天历史，再运行初始化补齐。')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
