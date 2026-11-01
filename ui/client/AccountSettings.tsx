/**
 * 插件详情页里的账号表单，排法照引擎插件设置页：一个账号一组，组里并排两项，标签在上。
 * 密码直接填在框里，默认遮住，点眼睛才显示。能填好几个的账号（CC98）下面有「添加另一个账号」。
 */
import { useEffect, useState } from 'react'
import { Button, IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { ACCOUNTS, MAX_ACCOUNTS, TRANSPORT, accountIndexes, numberedKeys, type AccountId } from '../profile/catalog.mjs'
import { errorText, profileApi, type AccountSnapshot } from './api.ts'
import { PtaLogin } from './PtaLogin.tsx'
import { Choice, Field } from './controls.tsx'

function Eye({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open
        ? <><path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8Z" /><circle cx="8" cy="8" r="2" /></>
        : <path d="M2 6.4c1.3 2 3.4 3.4 6 3.4s4.7-1.4 6-3.4M8 9.8V12M4.8 9l-1.1 1.8M11.2 9l1.1 1.8" />}
    </svg>
  )
}

/** 密码框：默认遮住，右边的眼睛切换显示。 */
function SecretInput({ id, name, value, disabled, onChange }: { id: string, name: string, value: string, disabled: boolean, onChange: (value: string) => void }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="campus-secret">
      <input id={id} className="campus-input" type={shown ? 'text' : 'password'} autoComplete="new-password" spellCheck={false}
        value={value} disabled={disabled} onChange={(event) => { onChange(event.target.value) }} />
      <button type="button" className="campus-secret-eye" aria-label={shown ? `隐藏${name}` : `显示${name}`} aria-pressed={shown} onClick={() => { setShown(old => !old) }}>
        <Eye open={shown} />
      </button>
    </div>
  )
}

export function AccountForm({ accounts, onSaved }: { accounts: readonly AccountId[], onSaved: (next: AccountSnapshot) => void }) {
  const [data, setData] = useState<AccountSnapshot | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [refresh, setRefresh] = useState(0)
  // 能填好几个的账号，页面上现在列着第几个、第几个：已经存着的，加上刚点「添加」还没保存的。
  const [slots, setSlots] = useState<Record<string, number[]>>({})
  const show = (next: AccountSnapshot) => {
    setData(next); setEdits({})
    setSlots(Object.fromEntries(accounts.filter(id => ACCOUNTS[id].multiple).map(id => [id, accountIndexes(next.values, id)])))
  }

  useEffect(() => {
    let active = true
    profileApi<AccountSnapshot>('account-read')
      .then((value) => { if (active) { show(value); setError('') } })
      .catch((err) => { if (active) setError(errorText(err)) })
    return () => { active = false }
  }, [refresh])

  const reread = <button type="button" className="campus-textlink" disabled={busy} onClick={() => { setRefresh(n => n + 1) }}>重新读取</button>
  if (!data) return error ? <div className="campus-form-foot"><p className="campus-form-error" role="alert">{error}</p>{reread}</div> : null

  const value = (key: string) => edits[key] ?? data.values[key] ?? ''
  const edit = (key: string, next: string) => { setEdits(old => ({ ...old, [key]: next })); setError(''); setSaved(false) }
  const dirty = Object.entries(edits).some(([key, next]) => next !== (data.values[key] ?? ''))

  async function save() {
    if (!data) return
    setBusy(true); setError(''); setSaved(false)
    try {
      const next = await profileApi<AccountSnapshot>('account-save', { revision: data.revision, values: edits })
      show(next); setSaved(true); onSaved(next)
    } catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }

  // 添加：用最小的空号，先在页面上多出一组，填了保存才写进文件。移除：这一组收起来，保存时把它清掉。
  const freeSlot = (id: AccountId) => Array.from({ length: MAX_ACCOUNTS - 1 }, (_, n) => n + 2).find(index => !(slots[id] ?? [1]).includes(index))
  const addSlot = (id: AccountId, index: number) => { setSlots(old => ({ ...old, [id]: [...(old[id] ?? [1]), index].sort((a, b) => a - b) })) }
  const removeSlot = (id: AccountId, index: number) => {
    const keys = numberedKeys(id, index)
    if (keys.user) edit(keys.user, '')
    edit(keys.secret, '')
    setSlots(old => ({ ...old, [id]: (old[id] ?? [1]).filter(item => item !== index) }))
  }

  return (
    <form className="campus-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      {accounts.map((id) => {
        const { title, user, secret, multiple } = ACCOUNTS[id]
        const free = multiple ? freeSlot(id) : undefined
        return (
          <div className="campus-form-accounts" key={id}>
            {(multiple ? slots[id] ?? [1] : [1]).map((index) => {
              const keys = numberedKeys(id, index)
              const heading = `campus-account-${id}${index > 1 ? `-${index}` : ''}`, name = index > 1 ? `${title} 账号 ${index}` : title
              return (
                <section className="campus-form-group" key={index} aria-labelledby={heading}>
                  <div className="campus-form-headline">
                    <h3 className="campus-form-heading" id={heading}>{name}</h3>
                    {index > 1 && <button type="button" className="campus-textlink" data-danger disabled={busy} onClick={() => { removeSlot(id, index) }}>移除</button>}
                  </div>
                  <div className="campus-form-grid">
                    {user !== undefined && keys.user !== undefined && (
                      <Field id={`${heading}-user`} label={user.label}>
                        <input id={`${heading}-user`} className="campus-input" type="text" placeholder={user.placeholder} autoComplete="off" spellCheck={false}
                          value={value(keys.user)} disabled={busy} onChange={(event) => { edit(keys.user!, event.target.value) }} />
                      </Field>
                    )}
                    <Field id={`${heading}-secret`} label={secret.label}>
                      <SecretInput id={`${heading}-secret`} name={`${name}${secret.label}`} value={value(keys.secret)} disabled={busy} onChange={(next) => { edit(keys.secret, next) }} />
                    </Field>
                  </div>
                  {id === 'pta' && <PtaLogin disabled={busy} beforeOpen={async () => {
                    if (!dirty) return
                    const next = await profileApi<AccountSnapshot>('account-save', { revision: data.revision, values: edits })
                    show(next); setSaved(true); onSaved(next)
                  }} />}
                  {id === 'webvpn' && (
                    <Field label={TRANSPORT.label}>
                      <Choice label={TRANSPORT.label} value={value(TRANSPORT.key) || TRANSPORT.options[0]!.value} disabled={busy}
                        options={TRANSPORT.options} onChange={(next) => { edit(TRANSPORT.key, next) }} />
                    </Field>
                  )}
                </section>
              )
            })}
            {free !== undefined && (
              <div className="campus-form-more">
                <Button type="button" size="sm" variant="outline" icon={<IconPlusOutlineRegular size={14} />} disabled={busy} onClick={() => { addSlot(id, free) }}>添加另一个账号</Button>
              </div>
            )}
          </div>
        )
      })}
      <div className="campus-form-foot">
        <button type="submit" className="campus-save" disabled={busy || !dirty}>{busy ? '保存中…' : saved && !dirty ? '已保存' : '保存'}</button>
        {error && <><p className="campus-form-error" role="alert">{error}</p>{reread}</>}
      </div>
    </form>
  )
}
