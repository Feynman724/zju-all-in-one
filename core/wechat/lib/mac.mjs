import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fail, memoryDatabase } from '../../chat/common.mjs'
import { Query } from './query.mjs'
import { messageTypes } from './content.mjs'
import { readSnapshot, verifyKey } from './snapshot.mjs'

const exec = promisify(execFile)
export const macHelper = fileURLToPath(new URL('../../../.local-tools/wechat-mac-key', import.meta.url))
export const macDataRoot = path.join(os.homedir(), 'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files')
export function macProfile(root = macDataRoot) {
  const profiles = (fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [])
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'db_storage/contact/contact.db')))
  if (!profiles.length) fail('wechat_database_missing', '未找到 Mac 微信 4.x 的本地聊天数据库，请先登录电脑版微信。')
  if (profiles.length !== 1) fail('multiple_wechat_profiles', '本机有多个微信账号数据目录，暂不自动选择。')
  return { id: profiles[0].name, storage: path.join(root, profiles[0].name, 'db_storage') }
}
export function databasePaths(storage, op) {
  const paths = [path.join(storage, 'contact/contact.db')]
  if (['list', 'info', 'read', 'search', 'init', 'status'].includes(op)) paths.push(path.join(storage, 'session/session.db'))
  if (['read', 'search', 'init'].includes(op)) {
    const directory = path.join(storage, 'message')
    const shards = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^message_\d+\.db$/.test(name)).sort() : []
    if (!shards.length) fail('wechat_database_missing', '本机尚未同步聊天记录，请先在微信中打开要读取的聊天。')
    paths.push(...shards.map(name => path.join(directory, name)))
  }
  return paths
}
export function firstPage(file) {
  const fd = fs.openSync(file, 'r'), page = Buffer.alloc(4096)
  try {
    let at = 0
    while (at < page.length) {
      const n = fs.readSync(fd, page, at, page.length - at, at)
      if (!n) throw Error('Incomplete header')
      at += n
    }
    return page
  } finally { fs.closeSync(fd) }
}
export const keyAccount = (file, page) => createHash('sha256').update(fs.realpathSync(file)).update(page.subarray(0, 16)).digest('hex')
export async function cachedKey(file, page) {
  try {
    const { stdout } = await exec(macHelper, ['get', keyAccount(file, page)], { encoding: 'buffer', timeout: 30000, maxBuffer: 1024 })
    if (verifyKey(stdout, page)) return stdout
    stdout.fill(0)
  } catch {}
  return null
}
export async function wechatPid() {
  try {
    const { stdout } = await exec('/usr/bin/pgrep', ['-x', 'WeChat'], { encoding: 'utf8', timeout: 3000 })
    const ids = stdout.trim().split(/\s+/).map(Number).filter(n => Number.isSafeInteger(n) && n > 0)
    if (ids.length > 1) fail('multiple_wechat_processes', '同时运行了多个微信，请保留一个账号后重试。')
    return ids[0] || 0
  } catch (error) {
    if (error.status) throw error
    return 0
  }
}
export async function readMac(query, {
  root = macDataRoot, helper = macHelper, loadKey = cachedKey, snapshot = readSnapshot, pid = wechatPid
} = {}) {
  if (!fs.existsSync(helper)) fail('wechat_mac_setup_required', '请在微信聊天插件页点击「初始化 Mac 微信」，完成首次授权。')
  if (query.op === 'download') fail('unsupported_operation', 'Mac 版暂不支持导出微信附件；请在微信中保存附件。')
  if (query['data-dir']) fail('invalid_input', 'Mac 版仅从当前系统用户的微信数据目录读取。')
  if (query.type && !messageTypes.includes(query.type)) fail('invalid_input', '不支持的消息类型。')
  const profile = macProfile(root)
  if (query.profile && query.profile !== profile.id) fail('profile_not_found', '当前微信账号与所选聊天不一致，请重新选择聊天。')
  const paths = databasePaths(profile.storage, query.op)
  const reader = new Query({ ...query, profile: profile.id })
  let skipped = 0, messages = 0
  for (const file of paths) {
    const page = firstPage(file)
    let key, image, db
    try {
      key = await loadKey(file, page)
      if (!key) {
        if (/^message_\d+\.db$/.test(path.basename(file))) { skipped++; continue }
        fail('wechat_mac_setup_required', 'Mac 微信尚未授权或密钥已失效，请在微信聊天插件页点击「初始化 Mac 微信」。')
      }
      if (query.op === 'status') continue
      try { image = snapshot(file, key) } catch { fail('snapshot_failed', '微信数据库正在变化或未通过完整性校验，请稍后重试。') }
      db = memoryDatabase(image)
      reader.read(path.basename(file), db)
      if (/^message_\d+\.db$/.test(path.basename(file))) messages++
    } finally { db?.close(); image?.fill(0); key?.fill(0); page.fill(0) }
  }
  if (query.op === 'status') return { ok: true, running: (await pid()) > 0 }
  if (skipped && !messages) fail('wechat_key_unavailable', '未取得聊天记录库密钥，请打开相关聊天后重新初始化 Mac 微信。')
  return {
    ...reader.result(),
    ...(skipped ? { partial: true, skippedShards: skipped, partialNote: '部分聊天记录库尚未授权，结果不完整。请打开相关聊天后重新初始化 Mac 微信。' } : {})
  }
}
