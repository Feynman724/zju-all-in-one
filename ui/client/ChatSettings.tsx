import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { profileApi, errorText } from './api.ts'
import { Alert, Field, Select } from './controls.tsx'
import { dateText, clock } from './when.ts'

type Platform = 'wechat' | 'dingtalk'
interface Person {
  id: string
  name: string
  isOwner?: boolean
  /** 最近 30 天在这个聊天里发了几条（只有「最近发言」里的人有）。 */
  count?: number
}
interface Chat {
  id: string
  name: string
  kind: string
  profile?: string
}
interface Track extends Chat {
  key: string
  audience: 'all' | 'managers' | 'selected'
  mode: 'original' | 'summary'
  senders: Person[]
  error: string | null
  checkedAt: string | null
  /** 最近一次 AI 整理跳过了几条闲聊（没有生成通知的）。 */
  skipped?: number
}
interface Snapshot {
  platform: Platform
  enabled: boolean
  busy: boolean
  running: boolean | null
  checkedAt: string | null
  error: string | null
  intervalMinutes: number
  tracks: Track[]
}
interface Page {
  chats?: Chat[]
  members?: Person[]
  /** 最近 30 天发过言的人，发得多的在前；名字取自他们的消息。 */
  recent?: Person[]
  messages?: Message[]
  nextCursor?: string | null
  hasMore: boolean
  roleCoverage?: string
}
export interface Message {
  id: string
  sentAt?: string
  sender?: { name?: string }
  text?: string
  title?: string
  summary?: string
  description?: string
  type?: string
  reference?: Message
  items?: Message[]
}
export function ChatMessage({ message }: { message: Message }) {
  const at = message.sentAt ? new Date(message.sentAt) : null
  return (
    <div className="campus-chat-message">
      {(message.sender?.name || at) && (
        <div className="campus-wechat-meta">
          {message.sender?.name}
          {at && Number.isFinite(at.getTime()) ? ` · ${dateText(at.getTime(), Date.now())} ${clock(at)}` : ''}
        </div>
      )}
      <div className="campus-chat-text">
        {message.text ||
          message.title ||
          message.summary ||
          message.description ||
          `[${({ image: '图片', voice: '语音', video: '视频', file: '文件', sticker: '表情' } as Record<string, string>)[message.type || ''] || message.type || '消息'}]`}
      </div>
      {message.reference && (
        <blockquote>
          <ChatMessage message={message.reference} />
        </blockquote>
      )}
      {message.items?.map((item, i) => (
        <blockquote key={item.id || i}>
          <ChatMessage message={item} />
        </blockquote>
      ))}
    </div>
  )
}
const call = <T,>(platform: Platform, operation: string, input: Record<string, unknown> = {}) =>
  profileApi<T>('chat-watch-' + operation, { platform, ...input })

function ChatPicker({
  platform,
  onClose,
  onAdded
}: {
  platform: Platform
  onClose: () => void
  onAdded: (data: Snapshot) => void
}) {
  const [query, setQuery] = useState(''),
    [profile, setProfile] = useState(''),
    [profiles, setProfiles] = useState<{ id: string; uid: string }[]>([])
  const [data, setData] = useState<Page | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [added, setAdded] = useState<string[]>([])
  const generation = useRef(0),
    [ready, setReady] = useState(platform === 'wechat')
  useEffect(() => {
    let active = true
    if (platform === 'dingtalk')
      call<{ profiles: { id: string; uid: string }[] }>(platform, 'profiles').then(
        (r) => {
          if (active) {
            setProfiles(r.profiles)
            if (r.profiles.length === 1) setProfile(r.profiles[0].id)
            setReady(true)
          }
        },
        (e) => {
          if (active) setError(errorText(e))
        }
      )
    return () => {
      active = false
      generation.current++
    }
  }, [platform])
  useEffect(() => {
    generation.current++
    setData(null)
    setAdded([])
  }, [query, profile])
  const search = async (more = false) => {
    const current = ++generation.current
    setBusy(true)
    setError('')
    try {
      const next = await call<Page>(platform, 'find', {
        query,
        profile,
        ...(more ? { cursor: data?.nextCursor } : {})
      })
      if (current === generation.current)
        setData((old) => ({
          ...next,
          chats: more ? [...(old?.chats || []), ...(next.chats || [])] : next.chats
        }))
    } catch (e) {
      if (current === generation.current) setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const add = async (chat: Chat) => {
    setBusy(true)
    setError('')
    try {
      onAdded(await call<Snapshot>(platform, 'add', { id: chat.id, profile }))
      setAdded((old) => [...old, chat.id])
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title="选择要监控的聊天"
      closeLabel="关闭"
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          完成
        </Button>
      }
    >
      <div className="campus-section">
        {profiles.length > 1 && (
          <Field label="本地账号">
            <Select
              label="本地账号"
              value={profile}
              options={profiles.map((p) => ({ value: p.id, label: p.uid }))}
              onChange={setProfile}
            />
          </Field>
        )}
        <form
          className="campus-chat-search"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <input
            className="campus-input"
            aria-label="聊天名称"
            placeholder="群名或联系人名称，留空列出最近聊天"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button
            variant="outline"
            type="submit"
            disabled={busy || !ready || (profiles.length > 1 && !profile)}
          >
            {busy ? '读取中…' : '查找'}
          </Button>
        </form>
        {error && <Alert>{error}</Alert>}
        <div className="campus-wechat-picker">
          <ul className="campus-rows">
            {data?.chats?.map((chat) => (
              <li className="campus-row" key={chat.id}>
                <div className="campus-wechat-main">
                  <span className="campus-row-title">{chat.name}</span>
                  <span className="campus-wechat-meta">{chat.kind === 'group' ? '群聊' : '个人聊天'}</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || added.includes(chat.id)}
                  onClick={() => {
                    void add(chat)
                  }}
                >
                  {added.includes(chat.id) ? '已添加' : '监控'}
                </Button>
              </li>
            ))}
          </ul>
          {data?.chats?.length === 0 && <p className="campus-note">没有匹配的聊天。</p>}
          {data?.hasMore && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void search(true)
              }}
            >
              更多聊天
            </Button>
          )}
        </div>
        <p className="campus-note">
          从添加时开始收集新消息。客户端运行时自动同步，本机没有同步过的消息暂时读不到。
        </p>
      </div>
    </Modal>
  )
}

function PeoplePicker({
  platform,
  track,
  onClose,
  onSave
}: {
  platform: Platform
  track: Track
  onClose: () => void
  onSave: (people: Person[]) => Promise<void>
}) {
  const [query, setQuery] = useState(''),
    [people, setPeople] = useState<Person[]>(track.senders),
    [data, setData] = useState<Page | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const generation = useRef(0)
  const search = async (more = false) => {
    const current = ++generation.current
    setBusy(true)
    setError('')
    try {
      const next = await call<Page>(platform, 'members', {
        id: track.id,
        profile: track.profile,
        query,
        ...(more ? { cursor: data?.nextCursor } : {})
      })
      if (current === generation.current)
        setData((old) => ({
          ...next,
          members: more ? [...(old?.members || []), ...(next.members || [])] : next.members
        }))
    } catch (e) {
      if (current === generation.current) setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void search()
    return () => {
      generation.current++
    }
  }, [])
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await onSave(people)
      onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={`选择发送者 · ${track.name}`}
      closeLabel="关闭"
      onClose={onClose}
      footer={
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void save()
          }}
        >
          保存选择（{people.length}）
        </Button>
      }
    >
      <div className="campus-section">
        <form
          className="campus-chat-search"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <input
            className="campus-input"
            aria-label="成员名称"
            placeholder="搜索群成员"
            value={query}
            onChange={(e) => {
              generation.current++
              setData(null)
              setQuery(e.target.value)
            }}
          />
          <Button type="submit" variant="outline" disabled={busy}>
            查找
          </Button>
        </form>
        {error && <Alert>{error}</Alert>}
        <p className="campus-note">本地可确认群主身份；其他管理员请在成员中指定。成员名单以本机缓存为准。</p>
        {people.length > 0 && (
          <div className="campus-chat-selected">
            {people.map((p) => (
              <button
                type="button"
                className="campus-textlink"
                key={p.id}
                disabled={busy}
                aria-label={`取消选择 ${p.name}`}
                onClick={() => setPeople((old) => old.filter((v) => v.id !== p.id))}
              >
                {p.name} ×
              </button>
            ))}
          </div>
        )}
        <div className="campus-wechat-picker">
          {!!data?.recent?.length && <p className="campus-note">最近发言</p>}
          <ul className="campus-rows">
            {data?.recent?.map((p) => (
              <li className="campus-row" key={'recent:' + p.id}>
                <label className="campus-chat-person">
                  <input
                    type="checkbox"
                    checked={people.some((v) => v.id === p.id)}
                    disabled={busy}
                    onChange={(e) =>
                      setPeople((old) =>
                        e.target.checked ? [...old, { id: p.id, name: p.name }] : old.filter((v) => v.id !== p.id)
                      )
                    }
                  />
                  <span>
                    {p.name}
                    {p.isOwner ? ' · 群主' : ''}
                    {p.count ? ` · 近 30 天 ${p.count} 条` : ''}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {!!data?.recent?.length && !!data?.members?.length && <p className="campus-note">其他成员</p>}
          <ul className="campus-rows">
            {data?.members?.filter((p) => !data?.recent?.some((r) => r.id === p.id)).map((p) => (
              <li className="campus-row" key={p.id}>
                <label className="campus-chat-person">
                  <input
                    type="checkbox"
                    checked={people.some((v) => v.id === p.id)}
                    disabled={busy}
                    onChange={(e) =>
                      setPeople((old) => (e.target.checked ? [...old, p] : old.filter((v) => v.id !== p.id)))
                    }
                  />
                  <span>
                    {p.name}
                    {p.isOwner ? ' · 群主' : ''}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {data?.hasMore && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void search(true)
              }}
            >
              更多成员
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
function History({ platform, track, onClose }: { platform: Platform; track: Track; onClose: () => void }) {
  const [data, setData] = useState<Page | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    alive = useRef(true)
  const read = async (more = false) => {
    setBusy(true)
    try {
      const next = await call<Page>(platform, 'read', {
        id: track.id,
        profile: track.profile,
        ...(more ? { cursor: data?.nextCursor } : {})
      })
      if (alive.current)
        setData((old) => ({
          ...next,
          messages: more ? [...(old?.messages || []), ...(next.messages || [])] : next.messages
        }))
    } catch (e) {
      if (alive.current) setError(errorText(e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  useEffect(() => {
    alive.current = true
    void read()
    return () => {
      alive.current = false
    }
  }, [])
  return (
    <Modal
      open
      title={track.name}
      closeLabel="关闭"
      onClose={onClose}
      footer={
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="campus-section">
        {error && <Alert>{error}</Alert>}
        <div className="campus-chat-history">
          {data?.messages?.map((m) => (
            <ChatMessage key={m.id} message={m} />
          ))}
          {busy && <p className="campus-note">正在读取…</p>}
          {data?.messages?.length === 0 && <p className="campus-note">本机暂时没有这个聊天的消息。</p>}
        </div>
        {data?.hasMore && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void read(true)
            }}
          >
            更早的消息
          </Button>
        )}
      </div>
    </Modal>
  )
}

export function ChatSettings({ platform }: { platform: Platform }) {
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [adding, setAdding] = useState(false),
    [people, setPeople] = useState<Track | null>(null),
    [history, setHistory] = useState<Track | null>(null)
  const alive = useRef(true)
  const reload = useCallback(async () => {
    try {
      const next = await call<Snapshot>(platform, 'snapshot')
      if (alive.current) setData(next)
    } catch (e) {
      if (alive.current) setError(errorText(e))
    }
  }, [platform])
  useEffect(() => {
    alive.current = true
    void reload()
    const timer = window.setInterval(() => {
      void reload()
    }, 3000)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [reload])
  const change = async (op: string, input: Record<string, unknown> = {}) => {
    setPending(true)
    setError('')
    try {
      const next = await call<Snapshot>(platform, op, input)
      if (alive.current) setData(next)
    } catch (e) {
      if (alive.current) setError(errorText(e))
      throw e
    } finally {
      if (alive.current) setPending(false)
    }
  }
  const run = (op: string, input: Record<string, unknown> = {}) => {
    void change(op, input).catch(() => {})
  }
  if (!data) return error ? <Alert>{error}</Alert> : <p className="campus-note">正在读取设置…</p>
  const busy = pending || data.busy
  return (
    <>
      {(error || data.error) && <Alert>{error || data.error}</Alert>}
      {platform === 'wechat' && window.campusShell?.setupWeChatMac && (
        <section className="campus-section">
          <div className="campus-section-head">
            <h2 className="campus-section-title">Mac 微信授权</h2>
            <Button variant="outline" disabled={busy} onClick={() => {
              void window.campusShell?.setupWeChatMac?.().then(message => {
                if (message) setError(message)
              }, e => setError(errorText(e)))
            }}>初始化 Mac 微信</Button>
          </div>
          <p className="campus-note">首次使用时打开并登录微信，再点击初始化。完成终端中的授权后，点击「立即同步」，然后添加要关注的聊天。</p>
        </section>
      )}
      <section className="campus-section">
        <div className="campus-section-head">
          <h2 className="campus-section-title">自动同步</h2>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run('refresh')}>
            {busy ? '同步中…' : '立即同步'}
          </Button>
        </div>
        <p className="campus-note">
          {data.running === false
            ? `${platform === 'wechat' ? '微信' : '钉钉'}未运行，打开后继续同步。`
            : data.running
              ? '客户端正在运行。'
              : '等待检查客户端。'}
          {data.checkedAt ? ` 上次检查 ${clock(new Date(data.checkedAt))}` : ''}
        </p>
        <Field label="同步间隔">
          <Select
            label="同步间隔"
            value={String(data.intervalMinutes)}
            disabled={busy}
            options={[1, 3, 5, 10, 15, 30, 60].map((n) => ({ value: String(n), label: `每 ${n} 分钟` }))}
            onChange={(value) => run('set', { intervalMinutes: Number(value) })}
          />
        </Field>
      </section>
      <section className="campus-section">
        <div className="campus-section-head">
          <h2 className="campus-section-title">监控的聊天</h2>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setAdding(true)}>
            添加聊天
          </Button>
        </div>
        {!data.tracks.length && (
          <p className="campus-note">选择重要的消息群、年级群或联系人，新消息会出现在「校园事务」的通知里。</p>
        )}
        {data.tracks.map((track) => (
          <div className="campus-chat-track" key={track.key}>
            <div className="campus-section-head">
              <button
                type="button"
                className="campus-textlink campus-chat-name"
                onClick={() => setHistory(track)}
              >
                {track.name}
              </button>
              <button
                type="button"
                className="campus-textlink"
                disabled={busy}
                onClick={() => run('remove', { key: track.key })}
              >
                停止监控
              </button>
            </div>
            {track.error && <Alert tone="warn">{track.error}</Alert>}
            <div className="campus-chat-options">
              <Field label="接收谁的消息">
                <Select
                  label={`${track.name}的发送者`}
                  value={track.audience}
                  disabled={busy}
                  options={[
                    { value: 'all', label: '所有人' },
                    ...(track.kind === 'group'
                      ? [
                          { value: 'managers', label: '群主和指定管理员' },
                          { value: 'selected', label: '指定成员' }
                        ]
                      : [])
                  ]}
                  onChange={(value) => run('set', { key: track.key, audience: value })}
                />
              </Field>
              <Field label="放进通知的方式">
                <Select
                  label={`${track.name}的整理方式`}
                  value={track.mode}
                  disabled={busy}
                  options={[
                    { value: 'original', label: '原样收集' },
                    { value: 'summary', label: 'AI 总结整理' }
                  ]}
                  onChange={(value) => run('set', { key: track.key, mode: value })}
                />
              </Field>
            </div>
            {track.audience !== 'all' && (
              <div className="campus-chat-selected">
                <span className="campus-note">
                  {track.senders.map((p) => p.name).join('、') ||
                    (track.audience === 'managers' ? '当前仅接收群主' : '尚未选择成员')}
                </span>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setPeople(track)}>
                  选择成员
                </Button>
              </div>
            )}
            {track.mode === 'summary' && (
              <p className="campus-note">
                新消息交给当前模型按事项整理，一件事一条通知，附上对应的原文；闲聊不生成通知。整理失败时原样收集。
                {track.skipped ? ` 这次整理跳过 ${track.skipped} 条闲聊。` : ''}
              </p>
            )}
          </div>
        ))}
      </section>
      {adding && <ChatPicker platform={platform} onClose={() => setAdding(false)} onAdded={setData} />}
      {people && (
        <PeoplePicker
          platform={platform}
          track={people}
          onClose={() => setPeople(null)}
          onSave={(senders) => change('set', { key: people.key, senders })}
        />
      )}
      {history && <History platform={platform} track={history} onClose={() => setHistory(null)} />}
    </>
  )
}
