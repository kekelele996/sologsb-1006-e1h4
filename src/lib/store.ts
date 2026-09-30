import { writable, get } from 'svelte/store'
import type {
  Announcement, Cue, CueStatus, DeskState, Confirmation, Conflict, ConflictVersion,
  Followup, Reminder, Session, Speaker, StageLine, Term
} from './types'

// ---------------------------------------------------------------------------
// 接力值守多标签协作模型
//
// 每个浏览器标签页 = 一个值守人（operator），共享同一条后台队列。
// - 共享状态整体持久化在 localStorage，保存时与对端做“按条目三方合并”，
//   不再整体覆盖，后保存一方不会抹掉对方的确认 / 补译 / 术语提醒。
// - 确认、补译按条目按人追加；同一条两人先后处理则两版并存，标出谁先确认，
//   同时登记冲突，晚到一方看到冲突提示后挑选保留哪一版。
// - stageLines 只追加、不回退：已上舞台的字幕不会被合并或撤销擦除。
// - 撤销 / 重做日志按标签页隔离，逆操作只撤销本页自己发起的编辑。
// - 合并或写入失败进入 syncStatus='error'，可一键重试。
// ---------------------------------------------------------------------------

const STATE_VERSION = 2
const STORAGE_KEY = 'conference-cue-desk-v2'
const LEGACY_STORAGE_KEY = 'conference-cue-desk-v1'
const PREFS_KEY = 'conference-cue-desk-operator-v1'
const HISTORY_LIMIT = 60

const speakersSeed: Speaker[] = [
  { id: 'sp-1', name: 'Dr. Maya Chen', title: '首席气候科学家', language: '英语 → 中文', color: '#0f766e' },
  { id: 'sp-2', name: '刘启明', title: '城市韧性研究员', language: '中文 → 英语', color: '#b45309' },
  { id: 'sp-3', name: 'Prof. Daniel Ortiz', title: '公共卫生政策顾问', language: '西班牙语 → 中文', color: '#6d28d9' },
  { id: 'sp-4', name: '佐藤 美咲', title: '社区能源设计师', language: '日语 → 中文', color: '#be123c' }
]
const sessionsSeed: Session[] = [
  { id: 'se-1', order: 1, time: '09:00', title: '开幕式与议程说明', speakerId: 'sp-2', room: '主会场 A', status: 'done' },
  { id: 'se-2', order: 2, time: '09:20', title: '城市热岛与适应性基础设施', speakerId: 'sp-1', room: '主会场 A', status: 'live' },
  { id: 'se-3', order: 3, time: '10:05', title: '社区健康数据的地方行动', speakerId: 'sp-3', room: '主会场 A', status: 'upcoming' },
  { id: 'se-4', order: 4, time: '10:45', title: '分布式能源与社区共治', speakerId: 'sp-4', room: '主会场 A', status: 'upcoming' }
]
const termsSeed: Term[] = [
  { id: 'term-1', source: 'urban heat island', target: '城市热岛', note: '首次出现完整译出，后可简称热岛', speakerId: 'sp-1', priority: 'high' },
  { id: 'term-2', source: 'resilience', target: '韧性', note: '不使用“恢复力”', speakerId: 'sp-1', priority: 'high' },
  { id: 'term-3', source: 'co-benefit', target: '协同效益', note: '环境与健康共同收益', speakerId: 'sp-1', priority: 'normal' },
  { id: 'term-4', source: 'distributed energy resource', target: '分布式能源资源', note: '缩写 DER', speakerId: 'sp-4', priority: 'high' },
  { id: 'term-5', source: 'health equity', target: '健康公平', note: '不译为健康平等', speakerId: 'sp-3', priority: 'high' }
]

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
function revToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
function clone<T>(value: T): T { return structuredClone(value) }
function uniq<T>(list: T[]): T[] { return [...new Set(list)] }

/** 登记集合字段的删除墓碑（撤销时调用，随合并传播，防止对端旧快照把内容复活） */
function addTombstone(state: DeskState, key: string, at: number) {
  const existing = state.tombstones.find(t => t.key === key)
  if (existing) { existing.at = Math.max(existing.at, at); return }
  state.tombstones.push({ key, at })
}

// ---------------------------------------------------------------------------
// 值守人身份 + 仅属于本标签页的视图偏好（sessionStorage，不参与合并）
// ---------------------------------------------------------------------------

interface OperatorPrefs {
  name: string
  tabId: string
  fontScale?: number
  activeCueId?: string
  liveSimulation?: boolean
}

function seedOperatorName(): string {
  const n = typeof window !== 'undefined' ? window.length : 1
  return `值守员 ${n > 1 ? 'B' : 'A'}`
}
function loadPrefs(): OperatorPrefs {
  if (typeof sessionStorage === 'undefined') return { name: '值守员 A', tabId: uid('tab') }
  try {
    const raw = sessionStorage.getItem(PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<OperatorPrefs>
      if (parsed.name && parsed.tabId) return parsed as OperatorPrefs
    }
  } catch { /* fall through */ }
  const prefs: OperatorPrefs = { name: seedOperatorName(), tabId: uid('tab') }
  try { sessionStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* noop */ }
  return prefs
}

const prefs = loadPrefs()
export function operatorName(): string { return prefs.name }
export function operatorTabId(): string { return prefs.tabId }
export function renameOperator(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  prefs.name = trimmed
  savePrefs()
}
function savePrefs() {
  try { sessionStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// 演示数据 / 旧版（v1 整体覆盖模型）迁移
// ---------------------------------------------------------------------------

function initialCues(): Cue[] {
  const now = Date.now()
  const row = (
    id: string, text: string, receivedAt: number, status: CueStatus, delaySeconds: number,
    followupText: string, tags: string[], confirmations: Confirmation[] = [], followups: Followup[] = []
  ): Cue => ({
    id, speakerId: 'sp-1', text, receivedAt, status, manual: false, offline: false, delaySeconds,
    duplicateOf: null, followupText, tags, rev: 0, confirmations, followups, editor: '', editorTabId: '', editedAt: 0
  })
  const aConfirm = (at: number): Confirmation => ({ operator: '值守员 A', tabId: 'seed-a', at })
  return [
    row('cue-101', 'The urban heat island effect is not evenly distributed across a city.', now - 36000, 'confirmed', 4, '', ['城市热岛'], [aConfirm(now - 35000)]),
    row('cue-102', 'Neighborhoods with less tree canopy can be several degrees warmer at night.', now - 19000, 'confirmed', 6, '补译：“夜间温差可达数摄氏度。”', ['树冠覆盖率'],
      [aConfirm(now - 18000)],
      [{ id: 'f-seed-102', operator: '值守员 A', tabId: 'seed-a', text: '补译：“夜间温差可达数摄氏度。”', at: now - 18500 }]),
    row('cue-103', 'Our resilience strategy links cooling corridors with public health investments.', now - 9000, 'pending', 11, '', ['韧性', '协同效益']),
    row('cue-104', 'That data also reveals health equity gaps between districts.', now - 2500, 'pending', 4, '', ['健康公平'])
  ]
}

function demoState(): DeskState {
  const cues = initialCues()
  const state: DeskState = {
    version: STATE_VERSION,
    rev: revToken(),
    speakers: speakersSeed,
    sessions: sessionsSeed,
    terms: termsSeed,
    announcements: [
      { id: 'ann-1', level: 'info', text: '十点整有消防联动测试，请提醒会场人员保持镇定。', visibleOnStage: false, createdAt: new Date().toISOString() },
      { id: 'ann-2', level: 'urgent', text: '请下一位发言人提前到侧台候场。', visibleOnStage: false, createdAt: new Date().toISOString() }
    ],
    cues,
    reminders: [],
    stageLines: [],
    conflicts: [],
    tombstones: [],
    activeCueId: 'cue-103',
    fontScale: 100,
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    liveSimulation: true,
    updatedAt: new Date().toISOString()
  }
  state.stageLines = cues
    .filter(cue => cue.confirmations.length)
    .map(cue => {
      const first = cue.confirmations.slice().sort((a, b) => a.at - b.at)[0]
      return {
        cueId: cue.id, text: cue.text, speakerId: cue.speakerId, speakerName: 'Dr. Maya Chen',
        at: first.at, firstOperator: first.operator, operators: [first.operator]
      }
    })
  return state
}

/** 旧版 v1（整体覆盖）或演示数据升级到 v2 接力模型 */
function normalize(raw: unknown): DeskState {
  if (!raw || typeof raw !== 'object') return demoState()
  const old = raw as Record<string, unknown>
  if ((old.version as number) >= STATE_VERSION) return reconcile(clone(raw as DeskState))

  const state = demoState()
  state.speakers = scalarList<Speaker>(old.speakers, state.speakers)
  state.sessions = scalarList<Session>(old.sessions, state.sessions)
  state.terms = scalarList<Term>(old.terms, state.terms)
  state.announcements = scalarList<Announcement>(old.announcements, state.announcements)

  const legacyCues = Array.isArray(old.cues) ? old.cues as Record<string, unknown>[] : []
  state.cues = legacyCues.map(lc => {
    const confirmations: Confirmation[] = lc.status === 'confirmed'
      ? [{ operator: '值守员 A', tabId: 'legacy-a', at: Number(lc.receivedAt) || Date.now() }]
      : []
    const followText = String(lc.followupText || '')
    const followups: Followup[] = followText
      ? [{ id: uid('f'), operator: '值守员 A', tabId: 'legacy-a', text: followText, at: Number(lc.receivedAt) || Date.now() }]
      : []
    return deriveCue({
      id: String(lc.id || uid('cue')),
      speakerId: String(lc.speakerId || ''),
      text: String(lc.text || ''),
      receivedAt: Number(lc.receivedAt) || Date.now(),
      status: 'pending',
      manual: Boolean(lc.manual),
      offline: Boolean(lc.offline),
      delaySeconds: Number(lc.delaySeconds) || 0,
      duplicateOf: (lc.duplicateOf as string | null) ?? null,
      followupText: followText,
      tags: Array.isArray(lc.tags) ? lc.tags.map(String) : [],
      rev: 0,
      confirmations,
      followups,
      editor: '', editorTabId: '', editedAt: 0
    })
  })

  const legacyReminders = Array.isArray(old.reminders) ? old.reminders as Record<string, unknown>[] : []
  state.reminders = legacyReminders.map(lr => {
    const ackedBy = lr.acknowledged ? ['值守员 A'] : []
    return {
      id: String(lr.id || uid('rem')),
      termId: String(lr.termId || ''),
      cueId: String(lr.cueId || ''),
      target: String(lr.target || ''),
      createdAt: Number(lr.createdAt) || Date.now(),
      acknowledged: ackedBy.length > 0,
      operator: '值守员 A',
      senders: ['值守员 A'],
      ackedBy
    }
  })
  state.stageLines = state.cues
    .filter(cue => cue.confirmations.length)
    .map(cue => {
      const first = cue.confirmations.slice().sort((a, b) => a.at - b.at)[0]
      return {
        cueId: cue.id, text: cue.text, speakerId: cue.speakerId,
        speakerName: speakerName(state, cue.speakerId),
        at: first.at, firstOperator: first.operator, operators: [first.operator]
      }
    })
  state.conflicts = []
  state.tombstones = []
  state.activeCueId = String(old.activeCueId ?? state.activeCueId)
  state.fontScale = Number(old.fontScale) > 0 ? Number(old.fontScale) : 100
  state.online = typeof navigator !== 'undefined' ? navigator.onLine : true
  state.liveSimulation = old.liveSimulation !== false
  state.updatedAt = String(old.updatedAt || new Date().toISOString())
  state.rev = revToken()
  return reconcile(state)
}

function scalarList<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) && value.length ? clone(value as T[]) : fallback
}

/** 重算派生字段（状态、采用补译、提醒已看到、舞台行、冲突裁定结果）并补全结构 */
function reconcile(state: DeskState): DeskState {
  state.version = STATE_VERSION
  state.speakers ||= []
  state.sessions ||= []
  state.terms ||= []
  state.announcements ||= []
  state.cues ||= []
  state.reminders ||= []
  state.stageLines ||= []
  state.conflicts ||= []
  state.tombstones ||= []
  state.cues = state.cues.map(cue => deriveCue(cue))
  state.reminders = state.reminders.map(reminder => {
    const senders = uniq([...(reminder.senders?.length ? reminder.senders : [reminder.operator || '']).filter(Boolean)])
    const ackedBy = reminder.ackedBy || (reminder.acknowledged ? senders.slice(0, 1) : [])
    return {
      ...reminder,
      operator: reminder.operator || senders[0] || '未知值守员',
      senders,
      ackedBy,
      acknowledged: ackedBy.length > 0
    }
  })
  state.stageLines.sort((a, b) => a.at - b.at)
  state.conflicts = state.conflicts.map(conflict => ({
    ...conflict,
    versions: (conflict.versions || []).slice().sort((a, b) => a.at - b.at)
  }))
  applyTombstones(state)
  applyConflictChoices(state)
  state.activeCueId ||= state.cues.at(-1)?.id || ''
  state.fontScale ||= 100
  state.rev ||= revToken()
  return state
}

function deriveCue(cue: Cue): Cue {
  cue.confirmations = (cue.confirmations || []).slice().sort((a, b) => a.at - b.at)
  cue.followups = (cue.followups || []).map(f => ({ ...f, id: f.id || uid('f') })).sort((a, b) => a.at - b.at)
  if (cue.confirmations.length > 0) cue.status = 'confirmed'
  else if (cue.followups.length > 0) cue.status = 'followup'
  else cue.status = 'pending'
  if (!cue.followupText) cue.followupText = cue.followups[0]?.text || ''
  cue.tags ||= []
  cue.duplicateOf ??= null
  cue.manual = Boolean(cue.manual)
  cue.offline = Boolean(cue.offline)
  cue.editor ||= ''
  cue.editorTabId ||= ''
  cue.editedAt ||= 0
  cue.rev ||= 0
  return cue
}

/**
 * 依据删除墓碑清理集合字段。墓碑之后又有同一值守人的新动作（重新确认 / 重新发送），
 * 则视为复活，墓碑不再生效——按 at 时间判定，不提前丢弃墓碑。
 */
function applyTombstones(state: DeskState) {
  const stones = new Map(state.tombstones.map(t => [t.key, t.at]))
  for (const cue of state.cues) {
    cue.confirmations = cue.confirmations.filter(c => {
      const at = stones.get(`confirm:${cue.id}:${c.tabId}`)
      return at === undefined || c.at > at
    })
    cue.followups = cue.followups.filter(f => {
      const at = stones.get(`followup:${f.id}`)
      return at === undefined || f.at > at
    })
    deriveCue(cue)
  }
  state.reminders = state.reminders.filter(r => {
    const senderAt = (name: string) => stones.get(`sender:${r.id}:${name}`)
    const ackAt = (name: string) => stones.get(`ack:${r.id}:${name}`)
    r.senders = r.senders.filter(name => {
      const at = senderAt(name)
      return at === undefined || r.createdAt > at
    })
    r.ackedBy = r.ackedBy.filter(name => {
      const at = ackAt(name)
      return at === undefined || r.createdAt > at
    })
    r.acknowledged = r.ackedBy.length > 0
    if (!r.senders.length) return false
    if (!r.operator || !r.senders.includes(r.operator)) r.operator = r.senders[0]
    return true
  })
}

/** 冲突裁定结果落到条目上（已选补译 / 已选编辑值） */
function applyConflictChoices(state: DeskState) {
  for (const conflict of state.conflicts) {
    if (!conflict.resolvedAt || !conflict.chosenKey) continue
    const cue = state.cues.find(item => item.id === conflict.cueId)
    if (!cue) continue
    const chosen = conflict.versions.find(v => v.key === conflict.chosenKey)
    if (!chosen) continue
    if (conflict.kind === 'dual-followup') {
      const followId = chosen.key.replace('followup:', '')
      const followup = cue.followups.find(f => f.id === followId)
      if (followup) cue.followupText = followup.text
    } else if (conflict.kind === 'edit' && conflict.field) {
      const field = conflict.field as 'text' | 'speakerId'
      cue[field] = chosen.value ?? chosen.label
      cue.editor = chosen.operator
      cue.editorTabId = chosen.tabId
      cue.editedAt = chosen.at
    }
  }
}

// ---------------------------------------------------------------------------
// 载入
// ---------------------------------------------------------------------------

function loadShared(): DeskState | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY)
    return raw ? normalize(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

let lastShared: DeskState = loadShared() || demoState()
const initialDraft = clone(lastShared)
initialDraft.fontScale = prefs.fontScale ?? initialDraft.fontScale
initialDraft.activeCueId = prefs.activeCueId ?? initialDraft.activeCueId
initialDraft.liveSimulation = prefs.liveSimulation ?? initialDraft.liveSimulation

export const desk = writable<DeskState>(initialDraft)

// ---------------------------------------------------------------------------
// 同步状态与跨标签页冲突提示
// ---------------------------------------------------------------------------

export type SyncStatus = 'idle' | 'saving' | 'updated' | 'error'
export const syncStatus = writable<SyncStatus>('idle')
export const syncError = writable('')
/** 新出现且涉及本值守人的冲突提示（页面 notice 绑定） */
export const conflictNotice = writable('')

let updatedTimer: ReturnType<typeof setTimeout> | undefined
function setSync(status: SyncStatus, message = '') {
  syncStatus.set(status)
  syncError.set(message)
  if (status === 'updated') {
    clearTimeout(updatedTimer)
    updatedTimer = setTimeout(() => { if (get(syncStatus) === 'updated') syncStatus.set('idle') }, 2600)
  }
}

// ---------------------------------------------------------------------------
// 按条目三方合并
// ---------------------------------------------------------------------------

interface MergeResult { state: DeskState; newConflictIds: string[] }

const EDITABLE_CUE_FIELDS: { key: 'text' | 'speakerId'; label: string }[] = [
  { key: 'text', label: '正文' },
  { key: 'speakerId', label: '发言人' }
]

function mergeStates(base: DeskState, local: DeskState, remote: DeskState, actionBase: DeskState = base): MergeResult {
  if ((remote.version || 1) > STATE_VERSION) {
    throw new Error('对端使用了更新版本的数据结构，请刷新页面后重试。')
  }
  // 仅以基线（上次同步所见）冲突为“已存在”；recipe 新登记或对端新带来的都算新冲突，
  // 调用方再用“动作发起前页面已知集合”过滤动作场景的提示。
  const previousConflictIds = new Set(base.conflicts.map(c => c.id))
  const out = clone(local)
  out.version = STATE_VERSION

  const baseCues = new Map(base.cues.map(cue => [cue.id, cue]))
  const actionBaseCues = new Map(actionBase.cues.map(cue => [cue.id, cue]))
  const localCues = new Map(local.cues.map(cue => [cue.id, cue]))
  const remoteCues = new Map(remote.cues.map(cue => [cue.id, cue]))

  // 条目做并集：对端删除但本页仍保留的条目不丢（可能已上舞台）
  const mergedCues: Cue[] = []
  const newConflicts: Conflict[] = []
  for (const id of uniq([...localCues.keys(), ...remoteCues.keys()])) {
    const l = localCues.get(id)
    const r = remoteCues.get(id)
    if (l && r) mergedCues.push(mergeCue(baseCues.get(id), actionBaseCues.get(id), l, r, newConflicts))
    else mergedCues.push(deriveCue(clone((l || r) as Cue)))
  }
  // 队列顺序按接收时间稳定合并（两端一致），同时间按 id 兜底
  out.cues = mergedCues.sort((a, b) => (a.receivedAt - b.receivedAt) || a.id.localeCompare(b.id))

  out.speakers = mergeScalarEntities(base.speakers, local.speakers, remote.speakers)
  out.sessions = mergeScalarEntities(base.sessions, local.sessions, remote.sessions)
  out.terms = mergeScalarEntities(base.terms, local.terms, remote.terms)
  out.announcements = mergeScalarEntities(base.announcements, local.announcements, remote.announcements)
  out.reminders = mergeReminders(base.reminders, local.reminders, remote.reminders)
  out.stageLines = mergeStageLines(local.stageLines, remote.stageLines)
  out.conflicts = mergeConflicts(local.conflicts, remote.conflicts, newConflicts)
  // 墓碑取并集，较新时间胜出；applyTombstones 在 reconcile 阶段统一生效
  const stoneMap = new Map<string, number>()
  for (const t of [...(local.tombstones || []), ...(remote.tombstones || [])]) {
    const prev = stoneMap.get(t.key)
    if (prev === undefined || t.at > prev) stoneMap.set(t.key, t.at)
  }
  out.tombstones = [...stoneMap.entries()].map(([key, at]) => ({ key, at }))
  out.rev = revToken()
  out.updatedAt = new Date().toISOString()
  const merged = reconcile(out)
  const newConflictIds = merged.conflicts
    .filter(c => !previousConflictIds.has(c.id) && !c.resolvedAt)
    .map(c => c.id)
  return { state: merged, newConflictIds }
}

function mergeCue(base: Cue | undefined, actionBaseCue: Cue | undefined, local: Cue, remote: Cue, newConflicts: Conflict[]): Cue {
  const out = clone(local)
  out.rev = Math.max(base?.rev || 0, local.rev || 0, remote.rev || 0)

  // 协作集合：按值守人 / 按 id 并集，两版都保留；
  // 基线里有、本地有意撤销掉的确认要作为删除传播（撤销自己的确认）
  out.confirmations = mergeConfirmations(base?.confirmations || [], local.confirmations || [], remote.confirmations || [])
  out.followups = mergeFollowups(base?.followups || [], local.followups || [], remote.followups || [])
  out.tags = uniq([...(local.tags || []), ...(remote.tags || [])])

  // 系统字段：非冲突合并
  out.duplicateOf = mergeNullable(base?.duplicateOf ?? null, local.duplicateOf ?? null, remote.duplicateOf ?? null)
  out.manual = local.manual || remote.manual
  out.offline = local.offline && remote.offline
  out.delaySeconds = Math.max(local.delaySeconds || 0, remote.delaySeconds || 0)
  out.receivedAt = local.receivedAt || remote.receivedAt

  // 编辑元信息取较新
  if ((remote.editedAt || 0) > (local.editedAt || 0)) {
    out.editor = remote.editor
    out.editorTabId = remote.editorTabId
    out.editedAt = remote.editedAt
  }

  // 双方基于同一基线各自新增确认 / 补译（互未见到对方）-> 合并时补登接力冲突
  const baseConfTabs = new Set((base?.confirmations || []).map(c => c.tabId))
  const localConfTabs = new Set((local.confirmations || []).map(c => c.tabId))
  const remoteConfTabs = new Set((remote.confirmations || []).map(c => c.tabId))
  const newLocalConfirms = out.confirmations.some(c => !baseConfTabs.has(c.tabId) && localConfTabs.has(c.tabId))
  const newRemoteConfirms = out.confirmations.some(c => !baseConfTabs.has(c.tabId) && remoteConfTabs.has(c.tabId))
  if (newLocalConfirms && newRemoteConfirms) {
    newConflicts.push({
      id: `dual-confirm:${local.id}`,
      cueId: local.id,
      kind: 'dual-confirm',
      versions: out.confirmations.map(c => ({
        key: `confirm:${c.tabId}`, operator: c.operator, tabId: c.tabId, at: c.at, label: `${c.operator} 确认`
      })),
      chosenKey: null, resolvedBy: null, resolvedAt: null, createdAt: Date.now()
    })
  }
  const baseFollowIds = new Set((base?.followups || []).map(f => f.id))
  const newLocalFollows = out.followups.some(f => !baseFollowIds.has(f.id) && (local.followups || []).some(lf => lf.id === f.id))
  const newRemoteFollows = out.followups.some(f => !baseFollowIds.has(f.id) && (remote.followups || []).some(rf => rf.id === f.id))
  if (newLocalFollows && newRemoteFollows) {
    newConflicts.push({
      id: `dual-followup:${local.id}`,
      cueId: local.id,
      kind: 'dual-followup',
      versions: out.followups.map(f => ({
        key: `followup:${f.id}`, operator: f.operator, tabId: f.tabId, at: f.at, label: f.text
      })),
      chosenKey: null, resolvedBy: null, resolvedAt: null, createdAt: Date.now()
    })
  }

  // 正文类字段：标准三方合并 + 编辑器时间戳兜底。
  // actionBase 记录“本页动作发起时所见”，latestBase 记录最新同步快照。
  // 本地相对动作基线改过、对端相对最新基线也改过且结果不同，即两人盲改同字段 -> 编辑冲突。
  // 若三方值意外未覆盖（如队列事件回放），对端编辑时间晚于本页基线且值不同也判为冲突。
  for (const field of EDITABLE_CUE_FIELDS) {
    const latestBv = String(base?.[field.key] ?? '')
    const actionBv = String(actionBaseCue?.[field.key] ?? latestBv)
    const lv = String(local[field.key] ?? '')
    const rv = String(remote[field.key] ?? '')
    if (lv === rv) continue
    const localChangedFromAction = lv !== actionBv
    const remoteChangedFromLatest = rv !== latestBv
    if (!localChangedFromAction) { (out as unknown as Record<string, unknown>)[field.key] = rv; continue }
    if (!remoteChangedFromLatest) continue
    const remoteEditedAfterBase = (remote.editedAt || 0) > (base?.editedAt || 0)
    if (!remoteEditedAfterBase && latestBv === rv) continue
    newConflicts.push({
      id: `edit:${local.id}:${field.key}`,
      cueId: local.id,
      kind: 'edit',
      field: field.key,
      fieldLabel: field.label,
      versions: [
        {
          key: `edit:${local.editorTabId || prefs.tabId}`, operator: local.editor || '本页值守员',
          tabId: local.editorTabId || prefs.tabId, at: local.editedAt || Date.now(),
          label: field.key === 'text' ? lv : (speakerNameLite(local) || lv),
          value: lv
        },
        {
          key: `edit:${remote.editorTabId || 'remote'}`, operator: remote.editor || '对端值守员',
          tabId: remote.editorTabId || '', at: remote.editedAt || Date.now(),
          label: field.key === 'text' ? rv : (speakerNameLite(remote) || rv),
          value: rv
        }
      ].sort((a, b) => a.at - b.at),
      chosenKey: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: Date.now()
    })
  }
  return deriveCue(out)
}

function speakerNameLite(cue: Cue): string {
  try {
    const state = get(desk)
    return state.speakers.find(s => s.id === cue.speakerId)?.name || ''
  } catch {
    return ''
  }
}

function mergeConfirmations(base: Confirmation[], local: Confirmation[], remote: Confirmation[]): Confirmation[] {
  const map = new Map<string, Confirmation>()
  for (const c of local) map.set(c.tabId, c)
  for (const c of remote) {
    const prev = map.get(c.tabId)
    if (!prev || c.at < prev.at) map.set(c.tabId, c)
  }
  // 标准三方删除：基线有、本地有意撤销、对端未独立新增 -> 删除生效并传播
  const baseTabs = new Set(base.map(c => c.tabId))
  const remoteAdded = new Set(remote.filter(c => !baseTabs.has(c.tabId)).map(c => c.tabId))
  for (const b of base) {
    if (local.some(c => c.tabId === b.tabId)) continue
    if (remoteAdded.has(b.tabId)) continue
    map.delete(b.tabId)
  }
  return [...map.values()].sort((a, b) => a.at - b.at)
}

function mergeFollowups(base: Followup[], local: Followup[], remote: Followup[]): Followup[] {
  const map = new Map<string, Followup>()
  for (const f of local) map.set(f.id, f)
  for (const f of remote) if (!map.has(f.id)) map.set(f.id, f)
  const baseIds = new Set(base.map(f => f.id))
  const remoteAdded = new Set(remote.filter(f => !baseIds.has(f.id)).map(f => f.id))
  for (const b of base) {
    if (local.some(f => f.id === b.id)) continue
    if (remoteAdded.has(b.id)) continue
    map.delete(b.id)
  }
  return [...map.values()].sort((a, b) => a.at - b.at)
}

function mergeNullable<T>(base: T, local: T, remote: T): T {
  if (local === remote) return local
  if (local === base) return remote
  if (remote === base) return local
  // 双方都改：清理（null）优先，避免重复标记反复横跳
  return remote === null ? remote : local
}

function mergeScalarEntities<T extends { id: string; rev?: number }>(base: T[], local: T[], remote: T[]): T[] {
  const bm = new Map(base.map(item => [item.id, item]))
  const lm = new Map(local.map(item => [item.id, item]))
  const out: T[] = []
  for (const item of local) {
    const r = remote.find(peer => peer.id === item.id)
    if (!r) { out.push(clone(item)); continue }
    const b = bm.get(item.id)
    // 对端相对基线改了、本页没改 -> 取对端；否则保留本页（本页较新或同改）
    if ((r.rev || 0) > (b?.rev || 0) && (item.rev || 0) <= (b?.rev || 0)) out.push(clone(r))
    else out.push(clone(item))
  }
  for (const item of remote) if (!lm.has(item.id)) out.push(clone(item))
  return out
}

function mergeReminders(base: Reminder[], local: Reminder[], remote: Reminder[]): Reminder[] {
  // 同术语同条目即同一条提醒：发送人、已看到人做三方并集（后保存不覆盖），
  // 撤销自己的发送 / 已看到时按基线删除传播。
  const baseByKey = new Map(base.map(r => [`${r.termId}:${r.cueId}`, r]))
  const byKey = new Map<string, Reminder>()
  const absorb = (list: Reminder[]) => {
    for (const r of list) {
      const key = `${r.termId}:${r.cueId}`
      const prev = byKey.get(key)
      if (!prev) { byKey.set(key, clone(r)); continue }
      const b = baseByKey.get(key)
      byKey.set(key, {
        ...prev,
        senders: mergeNameSet(b?.senders || [], prev.senders, r.senders),
        ackedBy: mergeNameSet(b?.ackedBy || [], prev.ackedBy, r.ackedBy),
        createdAt: Math.min(prev.createdAt, r.createdAt),
        operator: prev.createdAt <= r.createdAt ? prev.operator : r.operator
      })
    }
  }
  absorb(local)
  absorb(remote)
  for (const reminder of byKey.values()) reminder.acknowledged = reminder.ackedBy.length > 0
  return [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/** 名单型字段的三方合并：并集 + 基线删除传播（一方有意移除、另一方未独立添加则移除） */
function mergeNameSet(base: string[], local: string[], remote: string[]): string[] {
  const set = new Set(local)
  remote.forEach(name => set.add(name))
  const baseSet = new Set(base)
  const remoteAdded = new Set(remote.filter(name => !baseSet.has(name)))
  for (const name of base) {
    if (local.includes(name)) continue
    if (remoteAdded.has(name)) continue
    set.delete(name)
  }
  return [...set]
}

function mergeStageLines(local: StageLine[], remote: StageLine[]): StageLine[] {
  // 舞台行只追加、不回退：任一端上过舞台的内容都保留
  const byCue = new Map<string, StageLine>()
  for (const line of local) byCue.set(line.cueId, clone(line))
  for (const line of remote) {
    const prev = byCue.get(line.cueId)
    if (!prev) { byCue.set(line.cueId, clone(line)); continue }
    byCue.set(line.cueId, {
      ...prev,
      operators: uniq([...prev.operators, ...line.operators]),
      at: Math.min(prev.at, line.at)
    })
  }
  return [...byCue.values()].sort((a, b) => a.at - b.at)
}

function mergeConflicts(local: Conflict[], remote: Conflict[], freshly: Conflict[]): Conflict[] {
  const byId = new Map<string, Conflict>()
  const absorb = (list: Conflict[]) => {
    for (const conflict of list) {
      const prev = byId.get(conflict.id)
      if (!prev) { byId.set(conflict.id, clone(conflict)); continue }
      const resolved = prev.resolvedAt ? prev : conflict.resolvedAt ? conflict : null
      byId.set(conflict.id, {
        ...prev,
        versions: mergeVersions(prev.versions, conflict.versions),
        chosenKey: resolved?.chosenKey ?? null,
        resolvedBy: resolved?.resolvedBy ?? null,
        resolvedAt: resolved?.resolvedAt ?? null
      })
    }
  }
  absorb(local)
  absorb(remote)
  absorb(freshly)
  return [...byId.values()]
}

function mergeVersions(a: ConflictVersion[], b: ConflictVersion[]): ConflictVersion[] {
  const map = new Map<string, ConflictVersion>()
  for (const v of a) map.set(v.key, v)
  for (const v of b) if (!map.has(v.key)) map.set(v.key, v)
  return [...map.values()].sort((x, y) => x.at - y.at)
}

/**
 * 动作执行期间登记接力冲突（确认 / 补译）。
 * 两版都已经追加在条目上，这里只负责生成 / 重开冲突单。
 */
function ensureDualConflict(state: DeskState, cueId: string, kind: Conflict['kind'], versions: ConflictVersion[]): boolean {
  const id = `${kind}:${cueId}`
  const sorted = versions.slice().sort((a, b) => a.at - b.at)
  const prev = state.conflicts.find(c => c.id === id)
  const newestAt = sorted.at(-1)?.at || 0
  if (prev) {
    const beforeKeys = new Set(prev.versions.map(v => v.key))
    const added = sorted.some(v => !beforeKeys.has(v.key))
    prev.versions = mergeVersions(prev.versions, sorted)
    // 已裁定后又有新版本（第三人或重新提交）才重新打开待挑选
    if (added && newestAt > (prev.resolvedAt || 0)) {
      prev.chosenKey = null
      prev.resolvedBy = null
      prev.resolvedAt = null
    }
    return added
  }
  state.conflicts.push({
    id, cueId, kind, versions: sorted,
    chosenKey: null, resolvedBy: null, resolvedAt: null, createdAt: Date.now()
  })
  return true
}

// ---------------------------------------------------------------------------
// 提交管线：动作 -> 本页草稿 -> 与对端合并 -> 持久化；失败保留草稿可重试
// ---------------------------------------------------------------------------

type Recipe = (state: DeskState) => void
type Inverse = (state: DeskState) => boolean
interface JournalEntry { inverse: Inverse; redo: Recipe; label: string }

const history: JournalEntry[] = []
const future: JournalEntry[] = []
export const historyLength = writable(0)

type PendingKind = 'action' | 'sync' | 'undo' | 'redo'
interface PendingJob {
  kind: PendingKind
  draft: DeskState
  entry?: JournalEntry
  /** 动作发起时的共享快照，用于编辑字段的三方合并（“我基于哪版改的”） */
  actionBase: DeskState
  /** 最近一次与对端同步后的合并基线，随 storage 事件推进，保证 flush 不回退对端新改动 */
  mergeBase: DeskState
  /** 动作发起前已存在的冲突 id，用于区分本次新出现的冲突 */
  knownConflictIds: Set<string>
}
let pending: PendingJob | null = null

function readRemote(): DeskState | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? normalize(JSON.parse(raw)) : null
  } catch (err) {
    throw new Error(`无法读取对端队列：${(err as Error).message || '本地存储不可用'}`)
  }
}
function writeShared(state: DeskState) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (err) {
    throw new Error(`写入队列失败：${(err as Error).message || '本地存储不可用'}`)
  }
}

/**
 * 动作排队重试时（曾合并失败），把排队期间对端并入的状态先合进草稿再重放动作。
 */
function preserveLocalView<T extends DeskState>(target: T, current: DeskState): T {
  // 视图偏好永远跟本页，不参与合并
  target.fontScale = current.fontScale
  target.activeCueId = current.activeCueId
  target.liveSimulation = current.liveSimulation
  target.online = current.online
  return target
}

function commit(recipe: Recipe, inverse: Inverse, label: string) {
  void label
  // 以动作发起时页面上已存在的冲突为准：保存瞬间与对端合并产生的冲突才算“新出现”
  const baseAtAction = clone(get(desk))
  const knownConflictIds = new Set(baseAtAction.conflicts.map(c => c.id))
  const draft = clone(baseAtAction)
  recipe(draft)
  pending = {
    kind: 'action', draft, entry: { inverse, redo: recipe, label },
    actionBase: clone(lastShared), mergeBase: clone(lastShared), knownConflictIds
  }
  try {
    flushPending()
  } catch (err) {
    desk.set(preserveLocalView(clone(pending.draft), get(desk)))
    setSync('error', (err as Error).message)
  }
}

function flushPending() {
  const job = pending
  if (!job) return
  setSync('saving')
  const remote = readRemote()
  let merged: DeskState
  let newConflictIds: string[] = []
  let peerWrote = false
  if (!remote) {
    merged = reconcile(clone(job.draft))
    merged.rev = revToken()
  } else {
    peerWrote = remote.rev !== job.mergeBase.rev
    // 动作可能在写入失败后排队重试：先把排队期间对端并入的协作集合 / 条目刷新到草稿，
    // 再重新应用一次动作，避免拿过期草稿合并把对端改动回退。
    if (job.entry && (job.kind === 'action' || job.kind === 'redo') && job.mergeBase.rev !== job.actionBase.rev) {
      const refreshed = reconcile(mergeStates(job.actionBase, job.draft, job.mergeBase).state)
      preserveLocalView(refreshed, job.draft)
      job.entry.redo(refreshed)
      job.draft = refreshed
    }
    // 编辑字段以动作发起时所见为“本页基线”，协作集合以最新合并快照为基线；
    // 动作排队期间对端通过 storage 事件带来的新改动不会被本页动作回退。
    const result = mergeStates(job.mergeBase, job.draft, remote, job.actionBase)
    merged = result.state
    newConflictIds = result.newConflictIds
  }
  preserveLocalView(merged, job.draft)
  writeShared(merged)
  // 关键：动作发起方把对端改动并入后，基线必须推进到合并结果，
  // 否则下一次三方合并会拿陈旧基线把对端的新编辑误判为“未改动”
  lastShared = clone(merged)
  desk.set(clone(merged))
  if (job.entry && (job.kind === 'action' || job.kind === 'redo')) {
    history.push(job.entry)
    if (history.length > HISTORY_LIMIT) history.shift()
    future.length = 0
    historyLength.set(history.length)
  }
  pending = null
  setSync(peerWrote ? 'updated' : 'idle')
  // 仅提示本次动作 / 合并新出现、且涉及本值守人的冲突
  const freshIds = newConflictIds.filter(id => !job.knownConflictIds.has(id))
  notifyMyConflicts(merged, freshIds)
}

function notifyMyConflicts(state: DeskState, ids: string[]) {
  const mine = state.conflicts.filter(c =>
    ids.includes(c.id) && !c.resolvedAt && c.versions.some(v => v.tabId === prefs.tabId))
  if (!mine.length) return
  const cueIndex = state.cues.findIndex(cue => cue.id === mine[0].cueId) + 1
  const kindText = mine[0].kind === 'dual-confirm' ? '确认' : mine[0].kind === 'dual-followup' ? '补译' : '编辑'
  conflictNotice.set(`接力冲突：第 ${cueIndex} 条的${kindText}存在两个值守版本，两版均已保留，请在右侧冲突面板挑选。`)
}

/** 合并 / 写入失败后重试未完成的动作 */
export function retrySync() {
  if (!pending) {
    // 仅 storage 事件解析失败时：强制以当前页面重新读一次并合并
    const remote = readSharedOrNull()
    if (remote) {
      try { ingestRemote(remote, true) } catch (err) { setSync('error', (err as Error).message) }
    } else {
      setSync('idle')
    }
    return
  }
  pending.mergeBase = clone(lastShared)
  // 挂起期间本页视图可能有变化，以当前草稿为基础重新应用待执行动作
  if (pending.entry && pending.kind === 'action') {
    const redraft = clone(get(desk))
    pending.entry.redo(redraft)
    pending.draft = preserveLocalView(redraft, get(desk))
  }
  try {
    flushPending()
  } catch (err) {
    setSync('error', (err as Error).message)
  }
}
function readSharedOrNull(): DeskState | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? normalize(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

// storage 事件：对端写入后按条目合并进本页（不回写，避免写回环）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    let remote: DeskState
    try {
      remote = normalize(JSON.parse(event.newValue))
    } catch {
      pending = pending || { kind: 'sync', draft: clone(get(desk)), actionBase: clone(lastShared), mergeBase: clone(lastShared), knownConflictIds: new Set(get(desk).conflicts.map(c => c.id)) }
      setSync('error', '对端写入的数据无法解析，点击重试重新合并。')
      return
    }
    try {
      // 共同祖先优先用变更前的存储快照（DOM StorageEvent.oldValue），
      // 拿不到才退回最近同步基线，避免把本页刚保存的动作结果误当成共同祖先。
      const predecessor = event.oldValue ? normalize(JSON.parse(event.oldValue)) : lastShared
      ingestRemote(remote, false, predecessor)
    } catch (err) {
      pending = pending || { kind: 'sync', draft: clone(get(desk)), actionBase: clone(lastShared), mergeBase: clone(lastShared), knownConflictIds: new Set(get(desk).conflicts.map(c => c.id)) }
      setSync('error', (err as Error).message)
    }
  })
}

function ingestRemote(remote: DeskState, force: boolean, predecessor: DeskState = lastShared) {
  const local = pending ? clone(pending.draft) : clone(get(desk))
  if (!force && remote.rev === lastShared.rev) return
  // 共同祖先 = 对端写入前的连续状态（StorageEvent.oldValue，含此前已并入的本页动作）；
  // 本页在 predecessor 之后、remote 之前的动作由 local 体现，不会被当祖先。
  const result = mergeStates(predecessor, local, remote)
  let next = preserveLocalView(result.state, get(desk))
  lastShared = clone(next)
  // 若本页有挂起动作：对端更新并入后要把挂起的动作在新状态上重放一遍，
  // 保证稍后 flush 不会用过时草稿把对端改动回退。
  if (pending?.entry) {
    const replayed = clone(next)
    pending.entry.redo(replayed)
    pending.draft = preserveLocalView(replayed, next)
    pending.mergeBase = clone(next)
    next = preserveLocalView(replayed, get(desk))
  }
  desk.set(clone(next))
  setSync('updated')
  notifyMyConflicts(next, result.newConflictIds)
}

// ---------------------------------------------------------------------------
// 本页撤销 / 重做：只动自己的动作；舞台行永不删除
// ---------------------------------------------------------------------------

export function undoDesk() {
  const entry = history.pop()
  if (!entry) { historyLength.set(history.length); return }
  const draft = clone(get(desk))
  if (!entry.inverse(draft)) {
    history.push(entry)
    historyLength.set(history.length)
    return
  }
  future.push(entry)
  historyLength.set(history.length)
  pending = { kind: 'undo', draft, actionBase: clone(lastShared), mergeBase: clone(lastShared), knownConflictIds: new Set(get(desk).conflicts.map(c => c.id)) }
  try {
    flushPending()
  } catch (err) {
    desk.set(preserveLocalView(clone(pending.draft), get(desk)))
    setSync('error', (err as Error).message)
  }
}

export function redoDesk() {
  const entry = future.pop()
  if (!entry) return
  const draft = clone(get(desk))
  entry.redo(draft)
  pending = { kind: 'redo', draft, entry, actionBase: clone(lastShared), mergeBase: clone(lastShared), knownConflictIds: new Set(get(desk).conflicts.map(c => c.id)) }
  try {
    flushPending()
  } catch (err) {
    desk.set(preserveLocalView(clone(pending.draft), get(desk)))
    setSync('error', (err as Error).message)
  }
}

export const canUndo = () => history.length > 0
export const canRedo = () => future.length > 0

// ---------------------------------------------------------------------------
// 本页视图偏好（不共享、不进撤销栈）
// ---------------------------------------------------------------------------

function patchLocalView(patch: Partial<DeskState>) {
  desk.update(state => ({ ...state, ...patch }))
}
export function setFontScale(scale: number) {
  const clamped = Math.min(150, Math.max(85, scale))
  prefs.fontScale = clamped
  savePrefs()
  patchLocalView({ fontScale: clamped })
}
export function setActiveCue(id: string) {
  prefs.activeCueId = id
  savePrefs()
  patchLocalView({ activeCueId: id })
}
export function moveCue(direction: 1 | -1) {
  const state = get(desk)
  const index = state.cues.findIndex(item => item.id === state.activeCueId)
  const next = state.cues[index + direction]
  if (next) setActiveCue(next.id)
}
export function setLiveSimulation(enabled: boolean) {
  prefs.liveSimulation = enabled
  savePrefs()
  patchLocalView({ liveSimulation: enabled })
}
export function setOnline(online: boolean) {
  if (!online) {
    patchLocalView({ online: false })
    return
  }
  // 没有需要恢复的离线条目时只更新本页连接状态，不产生合并写入和撤销记录
  if (!get(desk).cues.some(cue => cue.offline)) {
    patchLocalView({ online: true })
    return
  }
  // 恢复连接：本页离线条目去标记并重跑重复检查，随后与对端合并
  commit(state => {
    state.online = true
    state.cues.forEach(cue => {
      if (cue.offline) {
        cue.offline = false
        const duplicate = findDuplicate(cue.text, state.cues.filter(item => item.id !== cue.id && !item.offline))
        cue.duplicateOf = duplicate?.id || null
        cue.rev += 1
      }
    })
  }, state => {
    let changed = false
    state.cues.forEach(cue => {
      // 只回退本页手工录入、且没有任何接力动作的条目
      const mine = cue.confirmations.some(c => c.tabId === prefs.tabId) ||
        cue.followups.some(f => f.tabId === prefs.tabId)
      if (cue.manual && !mine) { cue.offline = true; changed = true }
    })
    return changed
  }, '恢复网络合并')
}

// ---------------------------------------------------------------------------
// 后台准备类动作（按条目 rev 做最后写入胜出，各自进本页撤销栈）
// ---------------------------------------------------------------------------

function removeFrom<T extends { id: string }>(list: T[], id: string): boolean {
  const idx = list.findIndex(row => row.id === id)
  if (idx >= 0) { list.splice(idx, 1); return true }
  return false
}

export function addSpeaker() {
  const id = uid('sp')
  commit(
    state => state.speakers.push({ id, name: '新发言人', title: '待填写机构与职务', language: '待设置语言方向', color: '#475569', rev: 1 }),
    state => removeFrom(state.speakers, id), '新增发言人')
}
export function updateSpeaker(id: string, patch: Partial<Speaker>) { updateScalars('speakers', id, patch, '编辑发言人') }

export function addSession() {
  const id = uid('se')
  commit(state => state.sessions.push({
    id, order: Math.max(0, ...state.sessions.map(item => item.order)) + 1, time: '11:30',
    title: '新演讲', speakerId: state.speakers[0]?.id || '', room: '主会场 A', status: 'upcoming', rev: 1
  }), state => removeFrom(state.sessions, id), '新增场次')
}
export function updateSession(id: string, patch: Partial<Session>) { updateScalars('sessions', id, patch, '编辑场次') }

export function addTerm() {
  const id = uid('term')
  commit(state => state.terms.push({
    id, source: 'new term', target: '新术语', note: '', speakerId: state.speakers[0]?.id || '', priority: 'normal', rev: 1
  }), state => removeFrom(state.terms, id), '新增术语')
}
export function updateTerm(id: string, patch: Partial<Term>) { updateScalars('terms', id, patch, '编辑术语') }

export function addAnnouncement(text: string, level: Announcement['level']) {
  if (!text.trim()) return
  const id = uid('ann')
  const createdAt = new Date().toISOString()
  commit(
    state => state.announcements.unshift({ id, level, text: text.trim(), visibleOnStage: false, createdAt, rev: 1 }),
    state => removeFrom(state.announcements, id), '新增紧急通知')
}
export function publishAnnouncement(id: string, visible: boolean) {
  updateScalars('announcements', id, { visibleOnStage: visible }, visible ? '发布通知到现场' : '撤下通知')
}

type ScalarKey = 'speakers' | 'sessions' | 'terms' | 'announcements'
function updateScalars(key: ScalarKey, id: string, patch: Record<string, unknown>, label: string) {
  const before = clone(get(desk)[key].find(row => row.id === id) || null)
  commit(state => {
    const item = state[key].find(row => row.id === id)
    if (item) { Object.assign(item, patch); item.rev = (item.rev || 0) + 1 }
  }, state => {
    if (!before) return false
    const item = state[key].find(row => row.id === id)
    if (!item) return false
    Object.assign(item, before)
    return true
  }, label)
}

// ---------------------------------------------------------------------------
// 队列与接力动作
// ---------------------------------------------------------------------------

export function ingestCue(text: string, options: { manual?: boolean; speakerId?: string; receivedAt?: number } = {}) {
  const trimmed = text.trim()
  if (!trimmed) return
  const id = uid('cue')
  const receivedAt = options.receivedAt || Date.now()
  commit(state => {
    const duplicate = findDuplicate(trimmed, state.cues.filter(item => item.text !== trimmed))
    const speakerId = options.speakerId || state.sessions.find(item => item.status === 'live')?.speakerId || state.speakers[0]?.id || ''
    state.cues.push({
      id, speakerId, text: trimmed, receivedAt,
      status: 'pending', manual: Boolean(options.manual), offline: !state.online,
      delaySeconds: Math.max(0, Math.round((Date.now() - receivedAt) / 1000)),
      duplicateOf: duplicate?.id || null, followupText: '', tags: detectTerms(trimmed, state.terms),
      rev: 1, confirmations: [], followups: [], editor: prefs.name, editorTabId: prefs.tabId, editedAt: receivedAt
    })
    setActiveCueId(state, id)
  }, state => {
    const removed = removeFrom(state.cues, id)
    if (removed && prefs.activeCueId === id) setActiveCueId(state, state.cues.at(-1)?.id || '')
    return removed
  }, '接入现场文字')
}
function setActiveCueId(state: DeskState, id: string) {
  state.activeCueId = id
  prefs.activeCueId = id
  savePrefs()
}

export function updateCue(id: string, patch: Partial<Cue>) {
  const editable: Partial<Cue> = {}
  if (typeof patch.text === 'string') editable.text = patch.text
  if (typeof patch.speakerId === 'string') editable.speakerId = patch.speakerId
  if (Object.keys(editable).length === 0) return
  const before = clone(get(desk).cues.find(cue => cue.id === id) || null)
  commit(state => {
    const cue = state.cues.find(item => item.id === id)
    if (!cue) return
    Object.assign(cue, editable)
    cue.editor = prefs.name
    cue.editorTabId = prefs.tabId
    cue.editedAt = Date.now()
    cue.rev += 1
  }, state => {
    const cue = state.cues.find(item => item.id === id)
    if (!cue || !before) return false
    // 只回退本页值守人的编辑；对端已经接力改过则跳过
    if (cue.editorTabId !== prefs.tabId && before.editorTabId !== prefs.tabId) return false
    cue.text = before.text
    cue.speakerId = before.speakerId
    cue.editor = before.editor
    cue.editorTabId = before.editorTabId
    cue.editedAt = before.editedAt
    return true
  }, '编辑条目')
}

export function deleteCue(id: string) {
  const before = clone(get(desk).cues.find(cue => cue.id === id) || null)
  commit(state => {
    state.cues = state.cues.filter(item => item.id !== id)
    if (state.activeCueId === id) setActiveCueId(state, state.cues.at(-1)?.id || '')
  }, state => {
    if (!before || state.cues.some(item => item.id === id)) return false
    state.cues.push(before)
    if (!state.activeCueId) setActiveCueId(state, id)
    return true
  }, '删除条目')
}

export function clearDuplicate(id: string) {
  const before = get(desk).cues.find(cue => cue.id === id)?.duplicateOf ?? null
  commit(state => {
    const cue = state.cues.find(item => item.id === id)
    if (cue) { cue.duplicateOf = null; cue.rev += 1 }
  }, state => {
    const cue = state.cues.find(item => item.id === id)
    if (!cue) return false
    cue.duplicateOf = before
    return true
  }, '清除重复标记')
}

/**
 * 接力确认：同一 cue 上每个值守人保留自己的一版。
 * 首次确认上舞台；后续确认只叠加接力署名，舞台内容不回退。
 * 两人都确认过同一条 -> 两版并存 + 冲突单（晚到方挑选）。
 */
export function confirmCue(id: string) {
  const at = Date.now()
  commit(state => {
    const cue = state.cues.find(item => item.id === id)
    if (!cue) return
    if (!cue.confirmations.some(c => c.tabId === prefs.tabId)) {
      cue.confirmations.push({ operator: prefs.name, tabId: prefs.tabId, at })
    }
    cue.status = 'confirmed'
    cue.rev += 1
    const line = state.stageLines.find(item => item.cueId === id)
    if (!line) {
      state.stageLines.push({
        cueId: id,
        text: cue.text,
        speakerId: cue.speakerId,
        speakerName: state.speakers.find(s => s.id === cue.speakerId)?.name || '未指定',
        at,
        firstOperator: prefs.name,
        operators: [prefs.name]
      })
      state.stageLines.sort((a, b) => a.at - b.at)
    } else {
      line.operators = uniq([...line.operators, prefs.name])
    }
    if (cue.confirmations.length >= 2) {
      ensureDualConflict(state, id, 'dual-confirm', cue.confirmations.map(c => ({
        key: `confirm:${c.tabId}`, operator: c.operator, tabId: c.tabId, at: c.at, label: `${c.operator} 确认`
      })))
    }
  }, state => {
    const cue = state.cues.find(item => item.id === id)
    if (!cue) return false
    if (!cue.confirmations.some(c => c.tabId === prefs.tabId)) return false
    const mine = cue.confirmations.find(c => c.tabId === prefs.tabId)!
    cue.confirmations = cue.confirmations.filter(c => c.tabId !== prefs.tabId)
    addTombstone(state, `confirm:${id}:${prefs.tabId}`, Math.max(mine.at, Date.now()))
    deriveCue(cue)
    // 舞台行保留：撤销确认只摘掉我的接力署名，绝不把已上舞台的字幕撤下
    const line = state.stageLines.find(l => l.cueId === id)
    if (line && line.operators.length > 1) line.operators = line.operators.filter(name => name !== prefs.name)
    return true
  }, '确认已传')
}

/** 接力补译：按人追加，多版并存；两人都补译则登记冲突 */
export function addFollowup(id: string, text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  const followId = uid('f')
  const at = Date.now()
  commit(state => {
    const cue = state.cues.find(item => item.id === id)
    if (!cue) return
    cue.followups.push({ id: followId, operator: prefs.name, tabId: prefs.tabId, text: trimmed, at })
    if (!cue.confirmations.length) cue.status = 'followup'
    cue.followupText = cue.followupText || trimmed
    cue.rev += 1
    if (cue.followups.length >= 2) {
      ensureDualConflict(state, id, 'dual-followup', cue.followups.map(f => ({
        key: `followup:${f.id}`, operator: f.operator, tabId: f.tabId, at: f.at, label: f.text
      })))
    }
  }, state => {
    const cue = state.cues.find(item => item.id === id)
    if (!cue || !cue.followups.some(f => f.id === followId)) return false
    const mine = cue.followups.find(f => f.id === followId)!
    cue.followups = cue.followups.filter(f => f.id !== followId)
    addTombstone(state, `followup:${followId}`, Math.max(mine.at, Date.now()))
    deriveCue(cue)
    return true
  }, '补充遗漏')
}

/** 术语提醒：同术语同条目多人发送合并为一条，发送人并列保留 */
export function sendReminder(termId: string, cueId: string) {
  const target = get(desk).terms.find(item => item.id === termId)?.target || ''
  commit(state => {
    const existing = state.reminders.find(item => item.termId === termId && item.cueId === cueId)
    if (existing) {
      existing.senders = uniq([...existing.senders, prefs.name])
      return
    }
    state.reminders.unshift({
      id: uid('rem'), termId, cueId, target, createdAt: Date.now(), acknowledged: false,
      operator: prefs.name, senders: [prefs.name], ackedBy: []
    })
  }, state => {
    const reminder = state.reminders.find(item => item.termId === termId && item.cueId === cueId)
    if (!reminder) return false
    if (reminder.senders.length > 1) {
      reminder.senders = reminder.senders.filter(name => name !== prefs.name)
      addTombstone(state, `sender:${reminder.id}:${prefs.name}`, Date.now())
      if (reminder.operator === prefs.name) reminder.operator = reminder.senders[0] || reminder.operator
      return true
    }
    addTombstone(state, `sender:${reminder.id}:${prefs.name}`, Date.now())
    state.reminders = state.reminders.filter(item => item !== reminder)
    return true
  }, '发送术语提醒')
}

/** “已看到”：值守人各自独立标记，名单只增不减；撤销只摘掉自己 */
export function acknowledgeReminder(id: string) {
  commit(state => {
    const reminder = state.reminders.find(item => item.id === id)
    if (!reminder) return
    reminder.ackedBy = uniq([...reminder.ackedBy, prefs.name])
    reminder.acknowledged = true
  }, state => {
    const reminder = state.reminders.find(item => item.id === id)
    if (!reminder || !reminder.ackedBy.includes(prefs.name)) return false
    reminder.ackedBy = reminder.ackedBy.filter(name => name !== prefs.name)
    addTombstone(state, `ack:${reminder.id}:${prefs.name}`, Date.now())
    reminder.acknowledged = reminder.ackedBy.length > 0
    return true
  }, '确认看到提醒')
}

// ---------------------------------------------------------------------------
// 冲突裁定：晚到一方挑选保留哪一版
// ---------------------------------------------------------------------------

export function resolveConflict(id: string, chosenKey: string) {
  const cueId = get(desk).conflicts.find(c => c.id === id)?.cueId
  commit(state => {
    const conflict = state.conflicts.find(item => item.id === id)
    if (!conflict) return
    const cue = state.cues.find(item => item.id === conflict.cueId)
    const chosen = conflict.versions.find(v => v.key === chosenKey)
    conflict.chosenKey = chosenKey
    conflict.resolvedBy = prefs.name
    conflict.resolvedAt = Date.now()
    if (!cue || !chosen) return
    if (conflict.kind === 'dual-followup') {
      const followup = cue.followups.find(f => f.id === chosen.key.replace('followup:', ''))
      if (followup) cue.followupText = followup.text
    } else if (conflict.kind === 'edit' && conflict.field) {
      const field = conflict.field as 'text' | 'speakerId'
      cue[field] = (chosen.value ?? chosen.label) as never
      cue.editor = chosen.operator
      cue.editorTabId = chosen.tabId
      cue.editedAt = chosen.at
      cue.rev += 1
    }
    // dual-confirm 两版确认都保留，裁定只记录采用归属，不删除任何一方
  }, state => {
    const conflict = state.conflicts.find(item => item.id === id)
    if (!conflict) return false
    conflict.chosenKey = null
    conflict.resolvedBy = null
    conflict.resolvedAt = null
    const cue = state.cues.find(item => item.id === cueId)
    if (cue) deriveCue(cue)
    return true
  }, '裁定冲突版本')
}

// ---------------------------------------------------------------------------
// 查询辅助
// ---------------------------------------------------------------------------

export function getDelay(cue: Cue, now = Date.now()): number {
  return Math.max(cue.delaySeconds, Math.round((now - cue.receivedAt) / 1000))
}
export function speakerName(state: DeskState, id: string): string {
  return state.speakers.find(item => item.id === id)?.name || '未指定'
}
export function termTarget(state: DeskState, id: string): string {
  return state.terms.find(item => item.id === id)?.target || ''
}
function detectTerms(text: string, terms: Term[]): string[] {
  const lower = text.toLowerCase()
  return terms.filter(term => lower.includes(term.source.toLowerCase()) || lower.includes(term.target)).map(term => term.target)
}
function findDuplicate(text: string, cues: Cue[]): Cue | undefined {
  return cues.find(cue => similarity(text, cue.text) >= 0.72)
}
function similarity(a: string, b: string): number {
  const grams = (value: string) => {
    const clean = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    return new Set(Array.from({ length: Math.max(0, clean.length - 1) }, (_, index) => clean.slice(index, index + 2)))
  }
  const left = grams(a), right = grams(b)
  if (!left.size || !right.size) return a.trim() === b.trim() ? 1 : 0
  let intersection = 0
  left.forEach(item => { if (right.has(item)) intersection++ })
  return intersection / (left.size + right.size - intersection)
}

// 首次进入：没有新版也没有旧版数据时播种演示队列；有旧版则把迁移结果落盘为 v2
if (typeof window !== 'undefined') {
  try {
    if (!localStorage.getItem(STORAGE_KEY)) {
      if (localStorage.getItem(LEGACY_STORAGE_KEY)) {
        const migrated = reconcile(clone(get(desk)))
        writeShared(migrated)
        lastShared = clone(migrated)
      } else {
        const seeded = reconcile(clone(get(desk)))
        writeShared(seeded)
        lastShared = clone(seeded)
      }
    }
  } catch { /* 存储不可用时退化为纯内存 */ }
}
