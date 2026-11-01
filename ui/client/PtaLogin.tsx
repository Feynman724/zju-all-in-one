import { useState } from 'react'

/** No session secret crosses this UI bridge. */
export function PtaLogin({ disabled = false, beforeOpen, onSaved }: { disabled?: boolean, beforeOpen?: () => Promise<void>, onSaved?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  if (!window.campusShell?.loginPta) return null
  async function login() {
    setBusy(true); setMessage('请在打开的 PTA 窗口中登录并完成验证。'); setFailed(false)
    try {
      await beforeOpen?.()
      const result = await window.campusShell!.loginPta()
      setFailed(result.status === 'error')
      setMessage(result.status === 'saved' ? 'PTA 登录已保存。' : result.status === 'cancelled' ? '已取消登录。' : result.message || '登录失败，请重试。')
      if (result.status === 'saved') onSaved?.()
    } catch { setFailed(true); setMessage('未能打开登录，请先确认账号已保存后重试。') }
    finally { setBusy(false) }
  }
  return <span className="campus-pta-login">
    <button type="button" className="campus-textlink" disabled={disabled || busy} aria-busy={busy} onClick={() => { void login() }}>{busy ? '等待 PTA 登录…' : '登录 PTA'}</button>
    {message && <span className={failed ? 'campus-form-error' : 'campus-note'} role={failed ? 'alert' : 'status'}>{message}</span>}
  </span>
}
