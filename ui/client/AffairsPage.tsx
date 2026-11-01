/**
 * 校园事务：手上有什么事。左栏是要办的：各系统里快到期的作业（现在接了学在浙大和 PTA，默认只看两周内要交的），
 * 下面是自己记的备忘录（Memos.tsx）；右栏是外面发来的通知（Feed.tsx，分「校园通知」「个人消息」两个页签），右栏略宽一点，主区域窄的时候排到下面。
 * 打开时先照上一次读到的画出来，后台再去各系统重新读，哪个读完就先换上哪个的结果；
 * 多出来和没了的作业带进出的动画（Flow.tsx）。点一张卡片看这份作业的要求、下载附件，也可以把它交给助手（handoff.tsx）。
 * 作业的数据和缓存在引擎侧的 ui/profile/affairs.mjs。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconDownloadOutlineRegular, IconFolderOpenOutlineRegular, IconNewChatOutlineRegular,
  IconRefreshOutlineRegular, MarkdownText, Tag, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { CAMPUS_PLUGINS } from '../profile/catalog.mjs'
import { errorText, profileApi } from './api.ts'
import { Alert, Choice, Crumb } from './controls.tsx'
import { PtaLogin } from './PtaLogin.tsx'
import { FeedColumn, useFeedBusy, visitFeed } from './Feed.tsx'
import { Flow } from './Flow.tsx'
import { HandIconButton, handToAssistant } from './handoff.tsx'
import { useMemos } from './Memos.tsx'
import { openPlugin } from './PluginsPage.tsx'
import { DAY, HOUR, MINUTE, agoText, clock, dateText, joined, midnight, mixed, useNow } from './when.ts'

interface Task { id: string, source: string, title: string, course: string, kind: string, deadline: string | null, note?: string }
/** state：ready 能读，account 账号还没填，off 插件关着。plugin 是去插件页的哪一项处理。 */
interface Source { id: string, name: string, state: 'ready' | 'account' | 'off', plugin: string, fetchedAt: string | null, error: string | null }
interface Snapshot { items: Task[], sources: Source[] }
interface State { snapshot: Snapshot | null, busy: readonly string[], error: string }
/** 点开一条看到的：正文（作业要求或题目集说明）、几行「名称：内容」、附件的名字、小题的表。 */
interface Detail {
  body: string, format: 'text' | 'markdown', facts: { label: string, value: string }[], files: string[]
  table?: { columns: string[], rows: string[][] }, note?: string
}
/**
 * partial：正文只是列表顺带读到的，完整的还没读过。more：这一条还能去系统读到更多。
 * downloadable：附件能不能在这里下载。saved：下载过、现在还在原处的附件，名字对着本机的路径。
 */
interface Opened {
  item: Task, detail: Detail | null, partial: boolean, more: boolean, fetchedAt: string | null, error: string | null
  downloadable?: boolean, saved?: Record<string, string>
}

/** 页面的状态放在组件外面：离开这一页再回来直接照上一次的画，正在进行的读取也不会断。 */
let state: State = { snapshot: null, busy: [], error: '' }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const update = (patch: Partial<State>) => { state = { ...state, ...patch }; for (const listener of [...listeners]) listener() }
/** 点开过的作业上一次读到的内容，再点开时先照它画。 */
const opened = new Map<string, Opened>()

/** 进页面、回到窗口、点刷新时调用。先拿缓存，再让后台去每个系统读；刚读过的后台自己会跳过，force 时照读。 */
async function visit(force = false): Promise<void> {
  let snapshot: Snapshot
  try { snapshot = await profileApi<Snapshot>('affairs-read') } catch (error) { update({ error: errorText(error) }); return }
  update({ snapshot, error: '' })
  await Promise.all(snapshot.sources.filter(source => source.state === 'ready' && !state.busy.includes(source.id)).map(async (source) => {
    update({ busy: [...state.busy, source.id] })
    try { update({ snapshot: await profileApi<Snapshot>('affairs-refresh', { source: source.id, force }) }) }
    catch (error) { update({ error: errorText(error) }) }
    finally { update({ busy: state.busy.filter(id => id !== source.id) }) }
  }))
}

/** 默认只看这么久以内要交的。 */
const SOON_MS = 14 * DAY
/** 先露出这么多项，其余的收起来。 */
const LIMIT = 5
const RANGES = [{ value: 'soon', label: '两周内' }, { value: 'all', label: '全部' }] as const
type Range = typeof RANGES[number]['value']
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' }

/** 截止在哪一天、几点：三天内说今天、明天、后天，再远写日期和星期。 */
function dueText(at: number, now: number): string {
  const date = new Date(at), days = Math.round((midnight(at) - midnight(now)) / DAY)
  if (days >= 0 && days <= 2) return `${['今天', '明天', '后天'][days]} ${clock(date)}`
  return `${dateText(at, now)} ${WEEKDAYS[date.getDay()]} ${clock(date)}`
}

function leftText(at: number, now: number): string {
  const left = at - now
  if (left <= 0) return '已截止'
  if (left < HOUR) return `还有 ${Math.max(1, Math.floor(left / MINUTE))} 分钟`
  if (left < DAY) return `还有 ${Math.floor(left / HOUR)} 小时`
  return `还有 ${Math.floor(left / DAY)} 天`
}

const taskKey = (task: Task) => task.id
const pluginTitle = (id: string) => CAMPUS_PLUGINS.find(plugin => plugin.id === id)?.title ?? '插件'

/**
 * 交给助手时替用户写好的那段话。课程名和作业名照原样写，助手要拿它们去系统里找；
 * 截止时间写日期，不写「明天」，过几天再看这段对话也不会错。
 */
function handoffText(task: Task, source: string, now: number): string {
  const what = task.course ? `《${task.course}》的「${task.title}」` : `「${task.title}」`
  const due = task.deadline === null ? '' : `，${dateText(Date.parse(task.deadline), now)} ${clock(new Date(task.deadline))} 截止`
  return `${mixed(`帮我看看${source}上的这份${task.kind}：`)}${what}${due}。先把要求、附件和我现在的进度读一遍，告诉我要交什么、还差什么，再等我说下一步。`
}

/** 详情页右上角的「交给助手」，带字；列表里每张卡片上的是只有图标的那一个（handoff.tsx）。 */
function HandButton({ onClick }: { onClick: () => void }) {
  return <Button size="sm" variant="primary" icon={<IconNewChatOutlineRegular size={14} />} onClick={onClick}>交给助手</Button>
}

function DueText({ task, now }: { task: Task, now: number }) {
  if (task.deadline === null) return <span className="campus-task-due"><span className="campus-task-left">没有截止时间</span></span>
  const at = Date.parse(task.deadline)
  return (
    <span className="campus-task-due" data-urgent={at > now && at - now < DAY ? '' : undefined}>
      <time dateTime={task.deadline}>{dueText(at, now)}</time>
      <span className="campus-task-left">{leftText(at, now)}</span>
    </span>
  )
}

/** 列表里的一张卡片。整张都能点开，右边「交给助手」的图标保留自己的点击。 */
function TaskCard({ task, source, now, onOpen, onHand }: { task: Task, source: string, now: number, onOpen: () => void, onHand: () => void }) {
  return (
    <article className="campus-task">
      <div className="campus-task-main">
        <button type="button" className="campus-task-open" onClick={onOpen}>{task.title}</button>
        <span className="campus-task-meta">
          {task.course && <span className="campus-task-course">{task.course}</span>}
          <Tag>{source}</Tag>
          {task.note && <span>{task.note}</span>}
        </span>
      </div>
      <DueText task={task} now={now} />
      <HandIconButton onClick={onHand} />
    </article>
  )
}

/**
 * 点开的一份作业：上面是哪门课、哪个系统、什么时候截止，下面是要求、附件和小题。
 * 和列表一样先照上一次读到的画，再去系统读完整的；只有从没读到过内容的第一次会说一句在读。
 */
function TaskView({ task, source, now, problem, onBack, onHand }: {
  task: Task, source: string, now: number
  /** 页面那一层出的错（比如没能交给助手）。 */
  problem: string
  onBack: () => void, onHand: () => void
}) {
  const [data, setData] = useState<Opened | null>(() => opened.get(task.id) ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** 正在下载的附件，和没下成的附件各自的原因。 */
  const [fetching, setFetching] = useState<readonly string[]>([])
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<{ text: string, seq: number } | null>(null)
  const live = useRef(true)
  const apply = (next: Opened) => { opened.set(task.id, next); if (live.current) setData(next) }
  useEffect(() => {
    live.current = true
    void (async () => {
      try {
        const cached = await profileApi<Opened>('affairs-detail', { id: task.id })
        apply(cached)
        if (!cached.more) return
        if (live.current) setBusy(true)
        apply(await profileApi<Opened>('affairs-detail-refresh', { id: task.id }))
      } catch (reason) { if (live.current) setError(errorText(reason)) } finally { if (live.current) setBusy(false) }
    })()
    return () => { live.current = false }
  }, [task.id])

  const download = async (name: string) => {
    setFetching(old => [...old, name]); setFailed(({ [name]: _gone, ...rest }) => rest)
    try {
      apply(await profileApi<Opened>('affairs-file-download', { id: task.id, name }))
      if (live.current) setToast(old => ({ text: `「${name}」下载好了`, seq: (old?.seq ?? 0) + 1 }))
    } catch (reason) { if (live.current) setFailed(old => ({ ...old, [name]: errorText(reason) })) }
    finally { if (live.current) setFetching(old => old.filter(item => item !== name)) }
  }
  const reveal = async (name: string) => {
    try { apply(await profileApi<Opened>('affairs-file-reveal', { id: task.id, name })) } catch (reason) {
      if (live.current) setFailed(old => ({ ...old, [name]: errorText(reason) }))
      // 多半是文件被挪走了：重读一次，这一行就变回「下载」。
      profileApi<Opened>('affairs-detail', { id: task.id }).then(apply, () => {})
    }
  }

  const detail = data?.detail ?? null
  // 正文空着的时候说清楚是哪一种：还在第一次读、这一类本来就读不到、老师没写；没读到时下面另有说明。
  const blank = busy && !detail ? '第一次读这份作业，要等一会儿。'
    : !data || (data.error && !detail) ? ''
    : !data.more ? mixed(`这类内容要到${source}里打开看。`)
    : task.source === 'pta' ? '这份题目集没有文字说明。' : '老师没有写文字说明。'
  return (
    <div className="campus-detail">
      <Crumb text="校园事务" onBack={onBack} />
      <div className="campus-detail-head" data-wrap="">
        <div className="campus-detail-main">
          <h1 className="campus-page-title">{task.title}</h1>
        </div>
        <div className="campus-actions"><HandButton onClick={onHand} /></div>
      </div>
      {(problem || error) && <div className="campus-detail-notices">{problem && <Alert>{problem}</Alert>}{error && <Alert>{error}</Alert>}</div>}
      <dl className="campus-props">
        {task.course && <div><dt>课程</dt><dd>{task.course}</dd></div>}
        <div><dt>系统</dt><dd>{source}</dd></div>
        <div>
          <dt>截止</dt>
          <dd>{task.deadline === null ? '没有截止时间' : `${dueText(Date.parse(task.deadline), now)}，${leftText(Date.parse(task.deadline), now)}`}</dd>
        </div>
        {(detail?.facts.length ? detail.facts : task.note ? [{ label: '进度', value: task.note }] : []).map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
      </dl>
      <div className="campus-sections">
        <section className="campus-section">
          <h2 className="campus-section-title">{task.source === 'pta' ? '说明' : '要求'}</h2>
          {detail?.body ? (
            detail.format === 'markdown'
              ? <div className="campus-markdown"><MarkdownText text={detail.body} labels={MARKDOWN_LABELS} /></div>
              : <p className="campus-task-body">{detail.body}</p>
          ) : blank && <p className="campus-unset">{blank}</p>}
          {detail?.note && <p className="campus-note">{detail.note}</p>}
        </section>
        {detail && detail.files.length > 0 && (
          <section className="campus-section">
            <div className="campus-titleline"><h2 className="campus-section-title">附件</h2><span className="campus-count">{detail.files.length}</span></div>
            <ul className="campus-rows">
              {detail.files.map((name, index) => (
                <li className="campus-row" key={`${index}:${name}`}>
                  <span className="campus-task-file">
                    {name}
                    {failed[name] && <span className="campus-form-error">{failed[name]}</span>}
                  </span>
                  {data?.saved?.[name]
                    ? <Button size="sm" variant="outline" icon={<IconFolderOpenOutlineRegular size={14} />} onClick={() => { void reveal(name) }}>打开文件夹</Button>
                    : data?.downloadable && (
                      <Button size="sm" variant="outline" icon={<IconDownloadOutlineRegular size={14} />} disabled={fetching.includes(name)} onClick={() => { void download(name) }}>
                        {fetching.includes(name) ? '下载中' : '下载'}
                      </Button>
                    )}
                </li>
              ))}
            </ul>
            {data?.downloadable && <p className="campus-note">下载到「下载」文件夹的 CampusAgent 里，按课程和作业分开放。</p>}
          </section>
        )}
        {detail?.table && (
          <section className="campus-section">
            <div className="campus-titleline"><h2 className="campus-section-title">小题</h2><span className="campus-count">{detail.table.rows.length}</span></div>
            <table className="campus-task-table">
              <thead><tr>{detail.table.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
              <tbody>{detail.table.rows.map((row, index) => <tr key={index}>{row.map((cell, at) => <td key={at}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </section>
        )}
        {data?.error && !busy && (
          <p className="campus-note campus-task-note">
            <span>
              {mixed(detail ? `完整的内容这次没读到，上面是${data.fetchedAt ? agoText(Date.parse(data.fetchedAt), now) : '列表里顺带'}读到的：` : `${source}这次没读到：`)}
              {data.error.replace(/[。.]$/, '')}。
            </span>
          </p>
        )}
      </div>
      {toast && <Toast key={toast.seq} tone="success" text={toast.text} holdMs={Math.min(4000, 1200 + toast.text.length * 80)} onDone={() => { setToast(null) }} />}
    </div>
  )
}

export function AffairsPage() {
  const { snapshot, busy, error } = useSyncExternalStore(subscribe, () => state)
  const now = useNow()
  const [range, setRange] = useState<Range>('soon')
  const [expanded, setExpanded] = useState(false)
  /** 点开的那一条的编号；空着是列表。 */
  const [openId, setOpenId] = useState('')
  const page = useRef<HTMLDivElement>(null)
  const feedBusy = useFeedBusy()
  const memos = useMemos()
  useEffect(() => {
    const refresh = () => { void visit(); void visitFeed() }
    refresh()
    // 在别处交了作业再回到窗口，这里跟着更新。
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh) }
  }, [])
  useEffect(() => { page.current?.scrollTo({ top: 0 }) }, [openId, memos.layer])

  const items = snapshot?.items
  const visible = useMemo(() => (items ?? []).filter((task) => {
    if (range === 'all') return true
    const at = task.deadline === null ? null : Date.parse(task.deadline)
    return at !== null && at > now && at - now <= SOON_MS
  }), [items, range, now])

  const sources = snapshot?.sources ?? []
  const ready = sources.filter(source => source.state === 'ready')
  const fetched = ready.flatMap(source => source.fetchedAt ? [Date.parse(source.fetchedAt)] : [])
  const refreshing = busy.length > 0 || feedBusy
  const name = (id: string) => sources.find(source => source.id === id)?.name ?? id
  const hand = (task: Task) => { handToAssistant(handoffText(task, name(task.source), now)).catch((reason: unknown) => { update({ error: errorText(reason) }) }) }

  // 点开的那一条后来不在列表里了（交了、账号换了）：回到列表，它在那里已经滑出去了。
  const current = openId ? items?.find(task => task.id === openId) : undefined
  useEffect(() => { if (openId && items && !current) setOpenId('') }, [openId, items, current])
  if (current) {
    return (
      <div className="campus-page campus-affairs" ref={page}>
        <TaskView key={current.id} task={current} source={name(current.source)} now={now} problem={error}
          onBack={() => { setOpenId(''); update({ error: '' }) }} onHand={() => { hand(current) }} />
      </div>
    )
  }

  // 点开了一条备忘或者在编辑：整页都是它。
  if (memos.opened) return <div className="campus-page campus-affairs" ref={page}>{memos.opened}{memos.toast}</div>

  // 列表空着的时候说清楚是哪一种空：真的没有、还在第一次读、还是根本没法读（下面另有说明）。
  let empty = ''
  if (snapshot && visible.length === 0 && ready.length > 0) {
    const later = (items?.length ?? 0) - visible.length
    if (fetched.length > 0) empty = range === 'all' ? '没有还没交的作业。' : later > 0 ? `两周内没有要交的作业，更晚的还有 ${later} 项。` : '两周内没有要交的作业。'
    else if (busy.length > 0) empty = '第一次读取，要等一会儿。'
  }
  const off = sources.filter(source => source.state === 'off')
  const hidden = visible.length - LIMIT

  return (
    <div className="campus-page campus-affairs" ref={page}>
      <header className="campus-page-head">
        <h1 className="campus-page-title">校园事务</h1>
        <div className="campus-actions">
          {fetched.length > 0 && <span className="campus-note">{agoText(Math.min(...fetched), now)}更新</span>}
          <button type="button" className="campus-refresh" aria-label="刷新" title="刷新" aria-busy={refreshing} onClick={() => { void visit(true); void visitFeed(true) }}>
            <IconRefreshOutlineRegular size={16} />
          </button>
        </div>
      </header>
      {error && <Alert>{error}</Alert>}
      <div className="campus-affairs-columns">
        <div className="campus-affairs-todo">
          <section className="campus-section" aria-label="作业">
            <div className="campus-section-head">
              <div className="campus-titleline">
                <h2 className="campus-section-title">作业</h2>
                {snapshot && fetched.length > 0 && <span className="campus-count">{visible.length}</span>}
              </div>
              <Choice label="看哪些作业" value={range} options={RANGES} onChange={(next) => { if (next) { setRange(next); setExpanded(false) } }} />
            </div>
            {snapshot && (
              // 换范围是换了一份列表，整个重画，不放进出的动画。
              <Flow key={range} items={visible} keyOf={taskKey} limit={expanded ? Infinity : LIMIT} label="作业">
                {task => <TaskCard task={task} source={name(task.source)} now={now} onOpen={() => { setOpenId(task.id) }} onHand={() => { hand(task) }} />}
              </Flow>
            )}
            {hidden > 0 && (
              <Button className="campus-more" variant="ghost" size="sm" aria-expanded={expanded}
                icon={expanded ? <IconChevronUpOutlineRegular size={14} /> : <IconChevronDownOutlineRegular size={14} />} onClick={() => { setExpanded(old => !old) }}>
                {expanded ? '收起' : `展开其余 ${hidden} 项`}
              </Button>
            )}
            {empty && <p className="campus-task-empty">{empty}</p>}
            {off.length > 0 && (
              <p className="campus-note campus-task-note">
                <span>{mixed(`「${pluginTitle(off[0]!.plugin)}」在插件页关着，这里不读${joined(off.map(source => source.name))}的作业。`)}</span>
                <button type="button" className="campus-textlink" onClick={() => { openPlugin(off[0]!.plugin) }}>去打开</button>
              </p>
            )}
            {sources.filter(source => source.state === 'account').map(source => (
              <p className="campus-note campus-task-note" key={source.id}>
                <span>{mixed(`${source.name}的账号还没填，读不到那边的作业。`)}</span>
                <button type="button" className="campus-textlink" onClick={() => { openPlugin(source.plugin) }}>去填写</button>
              </p>
            ))}
            {ready.filter(source => source.error && !busy.includes(source.id)).map(source => (
              <p className="campus-note campus-task-note" key={source.id}>
                {/* 冒号后面的原因是系统给的原话，不动它。 */}
                <span>
                  {mixed(source.fetchedAt ? `${source.name}这次没读到，它的作业还是${agoText(Date.parse(source.fetchedAt), now)}读到的：` : `${source.name}没读到：`)}
                  {source.id === 'pta' && /认证|验证码|二次验证|Cookie/.test(source.error ?? '') ? '请点击「登录 PTA」，在官网窗口中完成登录验证。' : `${source.error!.replace(/[。.]$/, '')}。`}
                </span>
                {source.id === 'pta' && /认证|验证码|二次验证|Cookie/.test(source.error ?? '') ? <PtaLogin onSaved={() => { void visit(true) }} />
                  : <button type="button" className="campus-textlink" onClick={() => { void visit(true) }}>再试一次</button>}
              </p>
            ))}
          </section>
          {memos.list}
        </div>
        <FeedColumn now={now} memos={memos.notices} />
      </div>
      {memos.toast}
    </div>
  )
}
