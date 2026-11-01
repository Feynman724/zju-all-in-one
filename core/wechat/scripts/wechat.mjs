import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { argumentsFor, main, fail } from '../../chat/common.mjs'
import { messageTypes } from '../lib/content.mjs'
const explanations = {
  wechat_not_running: '电脑版微信没有运行，请打开并登录微信。',
  wechat_database_missing: '未找到本机微信已同步的聊天数据库。',
  multiple_wechat_processes: '同时运行了多个微信，请保留一个账号后重试。',
  multiple_wechat_profiles: '本机有多个微信账号数据目录，暂不支持自动选择。',
  wechat_key_unavailable: '未取得数据库密钥，请确认微信已登录；当前微信版本也可能不兼容。',
  wechat_offline_key_unavailable: '尚未准备好离线密钥，请打开微信后再试。',
  wechat_key_cache_failed: '无法保存由 Windows 当前用户加密保护的密钥缓存。',
  runtime_missing: '应用的 Node 运行时不支持内存数据库，请更新应用。',
  snapshot_failed: '微信数据库快照未通过校验，请稍后重试。',
  local_reader_failed: '读取本机微信失败。'
}
await main(async () => {
  if (process.env.WECHAT_CHAT_DISABLED === '1')
    fail('plugin_disabled', '这个聊天插件已关闭，请先在插件页打开。')
  const query = argumentsFor(process.argv.slice(2), { media: true })
  if (query.help)
    return {
      ok: true,
      usage:
        'status | chat list/contacts/info/members/read/search [--chat ID] [--query 关键词] [--since ISO] [--sender ID] [--type 类型] [--limit 1..500] [--cursor 游标] [--offline] | chat download --message ID --out 目录'
    }
  if (process.platform === 'darwin') {
    const { readMac } = await import('../lib/mac.mjs')
    return readMac(query)
  }
  if (process.platform !== 'win32') fail('unsupported_platform', '微信聊天读取支持 Windows 和 macOS。')
  if (query.op === 'status') {
    const { stdout } = await promisify(execFile)(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tasklist.exe'),
      ['/FI', 'IMAGENAME eq Weixin.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true }
    )
    return { ok: true, running: /"Weixin\.exe"/i.test(stdout) }
  }
  if (query.type && !messageTypes.includes(query.type)) fail('invalid_input', '不支持的消息类型。')
  if (query.op === 'download') {
    if (!/^[^:]+:(?:\d+|message_\d+\.db:\d+)$/.test(query.message || '') || !query.out?.trim())
      fail('invalid_input', 'download 需要消息 ID 和保存目录。')
    if (query.offline) fail('invalid_input', '媒体导出不支持 --offline。')
    query.chat = query.message.split(':')[0]
    query.limit = 1
  }
  const check = new DatabaseSync(':memory:')
  const supported = typeof check.deserialize === 'function'
  check.close()
  if (!supported) fail('runtime_missing', explanations.runtime_missing)
  const powershell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    ),
    script = fileURLToPath(new URL('./local/read-chat.ps1', import.meta.url))
  const output = await promisify(execFile)(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-NodePath',
      process.execPath,
      '-QueryBase64',
      Buffer.from(JSON.stringify(query)).toString('base64')
    ],
    {
      windowsHide: true,
      timeout: 600000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  ).then(
    (r) => r.stdout,
    (e) => e.stdout || ''
  )
  let result
  try {
    result = JSON.parse(output)
  } catch {
    fail('local_reader_failed', explanations.local_reader_failed)
  }
  if (result.error) fail(result.error, explanations[result.error] || explanations.local_reader_failed)
  // 读取器跳过了微信近来没打开过、内存里没有密钥的旧消息库：结果不全，照实交代。
  if (result.ok && result.partial)
    result.partialNote = `有 ${result.skippedShards} 个较早的聊天记录库这次没能解开（微信最近没有打开过它），结果里少了那一段时间的消息。只查最近的消息时加 --since 就不会碰到它。`
  if (!result.ok || query.op !== 'download') return result
  const { saveMedia } = await import('../lib/chat-media.ts')
  return saveMedia(result, query.out)
})
