/** Private bridge: never print the Cookie, account details or remote error response. */
import { openPta } from '../core/zju/lib/pta/client.ts'
let client
try {
  let raw = ''
  for await (const chunk of process.stdin) {
    raw += chunk
    if (raw.length > 65536) throw new Error('oversized')
  }
  client = await openPta()
  await client.importCookie(raw)
  process.stdout.write(JSON.stringify({ status: 'saved' }))
} catch (error) {
  const status = error?.code === 'AUTH_EXPIRED' || error?.code === 'BAD_RESPONSE' ? 'pending'
    : error?.code === 'NEEDS_USER' && error.message.includes('不是同一个') ? 'mismatch' : 'error'
  process.stdout.write(JSON.stringify({ status }))
} finally { client?.close() }
