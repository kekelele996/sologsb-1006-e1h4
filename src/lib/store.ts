import { writable, get } from 'svelte/store'
import type { Announcement, Cue, CueStatus, DeskState, Reminder, Session, Speaker, TabIdentity, Term, WriterInfo } from './types'
import {
  SYNC_KEY, buildEnvelope, emptySynced, loadIdentity, mergeSynced,
  normalizeSynced, readEnvelope, readLegacyState, similarity, syncedFromLegacy, syncedOf,
  writeEnvelope, type SyncedState
} from './sync'

const speakers: Speaker[] = [
  { id: 'sp-1', name: 'Dr. Maya Chen', title: '首席气候科学家', language: '英语 → 中文', color: '#0f766e', updatedAt: 0 },
  { id: 'sp-2', name: '刘启明', title: '城市韧性研究员', language: '中文 → 英语', color: '#b45309', updatedAt: 0 },
  { id: 'sp-3', name: 'Prof. Daniel Ortiz', title: '公共卫生政策顾问', language: '西班牙语 → 中文', color: '#6d28d9', updatedAt: 0 },
  { id: 'sp-4', name: '佐藤 美咲', title: '社区能源设计师', language: '日语 → 中文', color: '#be123c', updatedAt: 0 }
]
const sessions: Session[] = [
  { id: 'se-1', order: 1, time: '09:00', title: '开幕式与议程说明', speakerId: 'sp-2', room: '主会场 A', status: 'done', updatedAt: 0 },
  { id: 'se-2', order: 2, time: '09:20', title: '城市热岛与适应性基础设施', speakerId: 'sp-1', room: '主会场 A', status: 'live', updatedAt: 0 },
  { id: 'se-3', order: 3, time: '10:05', title: '社区健康数据的地方行动', speakerId: 'sp-3', room: '主会场 A', status: 'upcoming', updatedAt: 0 },
  { id: 'se-4', order: 4, time: '10:45', title: '分布式能源与社区共治', speakerId: 'sp-4', room: '主会场 A', status: 'upcoming', updatedAt: 0 }
]
const terms: Term[] = [
  { id: 'term-1', source: 'urban heat island', target: '城市热岛', note: '首次出现完整译出，后可简称热岛', speakerId: 'sp-1', priority: 'high', updatedAt: 0 },
  { id: 'term-2', source: 'resilience', target: '韧性', note: '不使用“恢复力”', speakerId: 'sp-1', priority: 'high', updatedAt: 0 },
  { id: 'term-3', source: 'co-benefit', target: '协同效益', note: '环境与健康共同收益', speakerId: 'sp-1', priority: 'normal', updatedAt: 0 },
  { id: 'term-4', source: 'distributed energy resource', target: '分布式能源资源', note: '缩写 DER', speakerId: 'sp-4', priority: 'high', updatedAt: 0 },
  { id: 'term-5', source: 'health equity', target: '健康公平', note: '不译为健康平等', speakerId: 'sp-3', priority: 'high', updatedAt: 0 }
]
function initialCues(): Cue[] {
  const now = Date.now()
  const mk = (partial: Partial<Cue> & { id: string; text: string; receivedAt: number; status: CueStatus; delaySeconds: number; tags: string[] }): Cue => ({
    speakerId: 'sp-1', manual: false, offline: false, duplicateOf: null, followupText: '',
    updatedAt: 0, confirmedBy: null, followups: [], conflict: null, dupChecked: false,
    ...partial
  })
  return [
    mk({ id: 'cue-101', text: 'The urban heat island effect is not evenly distributed across a city.', receivedAt: now - 36000, status: 'confirmed', delaySeconds: 4, tags: ['城市热岛'] }),
    mk({ id: 'cue-102', text: 'Neighborhoods with less tree canopy can be several degrees warmer at night.', receivedAt: now - 19000, status: 'confirmed', delaySeconds: 6, followupText: '补译：“夜间温差可达数摄氏度。”', tags: ['树冠覆盖率'] }),
    mk({ id: 'cue-103', text: 'Our resilience strategy links cooling corridors with public health investments.', receivedAt: now - 9000, status: 'pending', delaySeconds: 11, tags: ['韧性', '协同效益'] }),
    mk({ id: 'cue-104', text: 'That data also reveals health equity gaps between districts.', receivedAt: now - 2500, status: 'pending', delaySeconds: 4, tags: ['健康公平'] })
  ]
}
function demoState(): DeskState {
  return {
    speakers, sessions, terms, cues: initialCues(), reminders: [], activeCueId: 'cue-103', fontScale: 100,
    announcements: [
      { id: 'ann-1', level: 'info', text: '十点整有消防联动测试，请提醒会场人员保持镇定。', visibleOnStage: false, createdAt: new Date().toISOString(), updatedAt: 0 },
      { id: 'ann-2', level: 'urgent', text: '请下一位发言人提前到侧台候场。', visibleOnStage: false, createdAt: new Date().toISOString(), updatedAt: 0 }
    ],
    online: true, liveSimulation: true, updatedAt: new Date().toISOString()
  }
}
function clone<T>(value: T): T { return structuredClone(value) }

/** 本页（标签页）身份与同步状态 */
export const identity = writable<TabIdentity | null>(null)
export const syncStatus = writable<'ok' | 'error'>('ok')
export const writers = writable<Record<string, WriterInfo>>({})
const FALLBACK_IDENTITY: TabIdentity = { id: 'local', name: '本页', color: '#475569' }

/** 上次成功同步的共享队列快照与版本号 */
const base = writable<{ state: SyncedState; version: number }>({ state: emptySynced(), version: 0 })

const history: DeskState[] = []
const future: DeskState[] = []
export const desk = writable<DeskState>(demoState())

let retryAttempts = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
const RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000]

function scheduleRetry() {
  if (retryTimer) return
  const delay = RETRY_DELAYS[Math.min(retryAttempts, RETRY_DELAYS.length - 1)]
  retryAttempts++
  retryTimer = setTimeout(() => { retryTimer = null; retrySync() }, delay)
}

function currentIdentity(): TabIdentity { return get(identity) ?? FALLBACK_IDENTITY }

/** 提交前标记变更：更新时间戳、记录先确认人与补译版本 */
function touch(next: DeskState, before: DeskState) {
  const now = Date.now()
  const me = currentIdentity()
  const bump = <T extends { id: string; updatedAt: number }>(list: T[], beforeList: T[]) => {
    const beforeMap = new Map(beforeList.map(item => [item.id, item]))
    for (const item of list) {
      const old = beforeMap.get(item.id)
      if (!old || JSON.stringify(old) !== JSON.stringify(item)) item.updatedAt = now
    }
  }
  bump(next.speakers, before.speakers)
  bump(next.sessions, before.sessions)
  bump(next.terms, before.terms)
  bump(next.announcements, before.announcements)
  const beforeCues = new Map(before.cues.map(cue => [cue.id, cue]))
  for (const cue of next.cues) {
    const old = beforeCues.get(cue.id)
    if (!old) {
      cue.updatedAt = now
      cue.confirmedBy = cue.confirmedBy ?? null
      cue.followups = cue.followups ?? []
      cue.conflict = cue.conflict ?? null
      cue.dupChecked = cue.dupChecked ?? false
      continue
    }
    if (cue.status === 'confirmed' && !cue.confirmedBy) {
      cue.confirmedBy = { tabId: me.id, name: me.name, at: now }
    }
    if (cue.followupText?.trim() && cue.followupText !== old.followupText) {
      const text = cue.followupText.trim()
      if (!cue.followups?.some(entry => entry.tabId === me.id && entry.text === text)) {
        cue.followups = [...(cue.followups ?? []), { tabId: me.id, name: me.name, at: now, text }]
      }
    }
    if (JSON.stringify(cue) !== JSON.stringify(old)) cue.updatedAt = now
  }
}

function publishMerged(merged: SyncedState, local: DeskState, version: number) {
  const d = get(desk)
  desk.set({
    ...merged,
    activeCueId: local.activeCueId,
    fontScale: local.fontScale,
    online: local.online,
    liveSimulation: local.liveSimulation,
    updatedAt: new Date().toISOString()
  })
}

/** 把合并结果写入共享队列；失败时保留基线供重试，不覆盖对方内容 */
function commit(recipe: (state: DeskState) => void) {
  const before = clone(get(desk))
  const next = clone(before)
  recipe(next)
  touch(next, before)
  const local = syncedOf(next)
  const baseSnapshot = get(base)
  const remote = readEnvelope()
  const merged = mergeSynced(baseSnapshot.state, local, remote?.state ?? null)
  const envelope = buildEnvelope(merged, baseSnapshot.version, remote, currentIdentity())
  let writeOk = true
  try {
    try { writeEnvelope(envelope) }
    catch (error) {
      writeOk = false
      syncStatus.set('error')
      scheduleRetry()
      if (typeof console !== 'undefined') console.warn('共享队列写入失败，已在本机继续：', error)
    }
    if (writeOk) {
      base.set({ state: merged, version: envelope.version })
      writers.set(envelope.writers)
      syncStatus.set('ok')
      retryAttempts = 0
    }
    history.push(before)
    if (history.length > 60) history.shift()
    future.length = 0
    publishMerged(merged, next, envelope.version)
  } catch (error) {
    // 合并本身异常时绝不能覆盖共享队列
    syncStatus.set('error')
    scheduleRetry()
    if (typeof console !== 'undefined') console.warn('合并共享队列失败：', error)
  }
}

/** 其他标签页写入了共享队列：三路合并后并入本页，舞台内容不回退 */
function remoteChanged() {
  const remote = readEnvelope()
  if (!remote) return
  const baseSnapshot = get(base)
  if (remote.version <= baseSnapshot.version) return
  const local = syncedOf(get(desk))
  const merged = mergeSynced(baseSnapshot.state, local, remote.state)
  base.set({ state: merged, version: remote.version })
  writers.set(remote.writers)
  syncStatus.set('ok')
  retryAttempts = 0
  publishMerged(merged, get(desk), remote.version)
}

/** 合并失败后重试：用最新共享队列重新三路合并并写入 */
export function retrySync() {
  const baseSnapshot = get(base)
  const remote = readEnvelope()
  const local = syncedOf(get(desk))
  const merged = mergeSynced(baseSnapshot.state, local, remote?.state ?? null)
  const envelope = buildEnvelope(merged, baseSnapshot.version, remote, currentIdentity())
  try {
    writeEnvelope(envelope)
    base.set({ state: merged, version: envelope.version })
    writers.set(envelope.writers)
    syncStatus.set('ok')
    retryAttempts = 0
    publishMerged(merged, get(desk), envelope.version)
  } catch (error) {
    syncStatus.set('error')
    scheduleRetry()
    if (typeof console !== 'undefined') console.warn('重试写入共享队列失败：', error)
  }
}

/** 页面加载时初始化同步：读取共享队列，或从旧版本/演示数据迁移 */
export function initSync() {
  if (typeof localStorage === 'undefined') return
  const envelope = readEnvelope()
  if (envelope) {
    const state = normalizeSynced(envelope.state)
    base.set({ state, version: envelope.version })
    writers.set(envelope.writers)
    identity.set(loadIdentity(envelope.writers))
    const d = get(desk)
    desk.set({ ...d, ...state, updatedAt: new Date().toISOString() })
  } else {
    const legacy = readLegacyState()
    const state = normalizeSynced(legacy ? syncedFromLegacy(legacy) : syncedOf(demoState()))
    const me = loadIdentity({})
    identity.set(me)
    const envelope = buildEnvelope(state, 0, null, me)
    try {
      writeEnvelope(envelope)
      base.set({ state, version: envelope.version })
    } catch (error) {
      syncStatus.set('error')
      scheduleRetry()
      if (typeof console !== 'undefined') console.warn('初始化共享队列失败：', error)
    }
    const d = get(desk)
    desk.set({ ...d, ...state, updatedAt: new Date().toISOString() })
  }
  window.addEventListener('storage', event => { if (event.key === SYNC_KEY) remoteChanged() })
  window.addEventListener('focus', () => { if (get(syncStatus) === 'error') retrySync() })
}

function applySnapshot(snapshot: DeskState) {
  const local = syncedOf(snapshot)
  const baseSnapshot = get(base)
  const remote = readEnvelope()
  const merged = mergeSynced(baseSnapshot.state, local, remote?.state ?? null)
  const envelope = buildEnvelope(merged, baseSnapshot.version, remote, currentIdentity())
  try {
    writeEnvelope(envelope)
    base.set({ state: merged, version: envelope.version })
    writers.set(envelope.writers)
    syncStatus.set('ok')
    retryAttempts = 0
  } catch (error) {
    syncStatus.set('error')
    scheduleRetry()
    if (typeof console !== 'undefined') console.warn('撤销/重做后同步失败：', error)
  }
  const d = get(desk)
  desk.set({
    ...merged,
    activeCueId: snapshot.activeCueId,
    fontScale: snapshot.fontScale,
    online: d.online,
    liveSimulation: d.liveSimulation,
    updatedAt: new Date().toISOString()
  })
}

/** 撤销只作用于本页编辑：恢复本页快照后重新合并，不回退对方确认与舞台内容 */
export function undoDesk() {
  const previous = history.pop()
  if (!previous) return
  future.push(clone(get(desk)))
  applySnapshot(previous)
}
export function redoDesk() {
  const next = future.pop()
  if (!next) return
  history.push(clone(get(desk)))
  applySnapshot(next)
}
export const canUndo = () => history.length > 0
export const canRedo = () => future.length > 0

export function addSpeaker() {
  commit(state => state.speakers.push({ id: `sp-${Date.now()}`, name: '新发言人', title: '待填写机构与职务', language: '待设置语言方向', color: '#475569', updatedAt: 0 }))
}
export function updateSpeaker(id: string, patch: Partial<Speaker>) { commit(state => { const item = state.speakers.find(row => row.id === id); if (item) Object.assign(item, patch) }) }
export function addSession() {
  commit(state => state.sessions.push({ id: `se-${Date.now()}`, order: Math.max(0, ...state.sessions.map(item => item.order)) + 1, time: '11:30', title: '新演讲', speakerId: state.speakers[0]?.id || '', room: '主会场 A', status: 'upcoming', updatedAt: 0 }))
}
export function updateSession(id: string, patch: Partial<Session>) { commit(state => { const item = state.sessions.find(row => row.id === id); if (item) Object.assign(item, patch) }) }
export function addTerm() { commit(state => state.terms.push({ id: `term-${Date.now()}`, source: 'new term', target: '新术语', note: '', speakerId: state.speakers[0]?.id || '', priority: 'normal', updatedAt: 0 })) }
export function updateTerm(id: string, patch: Partial<Term>) { commit(state => { const item = state.terms.find(row => row.id === id); if (item) Object.assign(item, patch) }) }
export function addAnnouncement(text: string, level: Announcement['level']) {
  if (!text.trim()) return
  commit(state => state.announcements.unshift({ id: `ann-${Date.now()}`, level, text: text.trim(), visibleOnStage: false, createdAt: new Date().toISOString(), updatedAt: 0 }))
}
export function publishAnnouncement(id: string, visible: boolean) { commit(state => { const item = state.announcements.find(row => row.id === id); if (item) item.visibleOnStage = visible }) }

export function setOnline(online: boolean) {
  commit(state => {
    state.online = online
    if (online) {
      state.cues.forEach(cue => {
        if (cue.offline) {
          cue.offline = false
          const duplicate = findDuplicate(cue.text, state.cues.filter(item => item.id !== cue.id && !item.offline))
          cue.duplicateOf = duplicate?.id || null
        }
      })
    }
  })
}
export function setLiveSimulation(enabled: boolean) { commit(state => { state.liveSimulation = enabled }) }
export function setActiveCue(id: string) { commit(state => { state.activeCueId = id }) }
export function moveCue(direction: 1 | -1) {
  const state = get(desk)
  const index = state.cues.findIndex(item => item.id === state.activeCueId)
  const next = state.cues[index + direction]
  if (next) setActiveCue(next.id)
}
export function setFontScale(scale: number) { commit(state => { state.fontScale = Math.min(150, Math.max(85, scale)) }) }

export function ingestCue(text: string, options: { manual?: boolean; speakerId?: string; receivedAt?: number } = {}) {
  const trimmed = text.trim()
  if (!trimmed) return
  commit(state => {
    const existing = state.cues.filter(item => item.text !== trimmed)
    const duplicate = findDuplicate(trimmed, existing)
    const speakerId = options.speakerId || state.sessions.find(item => item.status === 'live')?.speakerId || state.speakers[0]?.id || ''
    const receivedAt = options.receivedAt || Date.now()
    const cue: Cue = {
      id: `cue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, speakerId, text: trimmed, receivedAt,
      status: 'pending', manual: Boolean(options.manual), offline: !state.online, delaySeconds: Math.max(0, Math.round((Date.now() - receivedAt) / 1000)),
      duplicateOf: duplicate?.id || null, followupText: '', tags: detectTerms(trimmed, state.terms),
      updatedAt: 0, confirmedBy: null, followups: [], conflict: null, dupChecked: false
    }
    state.cues.push(cue); state.activeCueId = cue.id
  })
}
export function updateCue(id: string, patch: Partial<Cue>) { commit(state => { const cue = state.cues.find(item => item.id === id); if (cue) Object.assign(cue, patch) }) }
export function setCueStatus(id: string, status: CueStatus) { commit(state => { const cue = state.cues.find(item => item.id === id); if (cue) cue.status = status }) }
export function deleteCue(id: string) { commit(state => { state.cues = state.cues.filter(item => item.id !== id); if (state.activeCueId === id) state.activeCueId = state.cues.at(-1)?.id || '' }) }
export function clearDuplicate(id: string) { commit(state => { const cue = state.cues.find(item => item.id === id); if (cue) { cue.duplicateOf = null; cue.dupChecked = true } }) }
export function sendReminder(termId: string, cueId: string) {
  commit(state => {
    const exists = state.reminders.some(item => item.termId === termId && item.cueId === cueId)
    if (exists) return
    state.reminders.unshift({ id: `rem-${Date.now()}`, termId, cueId, target: state.terms.find(item => item.id === termId)?.target || '', createdAt: Date.now(), acknowledged: false })
  })
}
export function acknowledgeReminder(id: string) { commit(state => { const item = state.reminders.find(row => row.id === id); if (item) item.acknowledged = true }) }

/** 冲突解决：选择舞台显示哪一版；两版补译都已保留，已确认状态不回退 */
export function resolveConflict(cueId: string, choice: 'first' | 'second') {
  commit(state => {
    const cue = state.cues.find(item => item.id === cueId)
    if (!cue?.conflict || cue.conflict.resolution) return
    const chosen = choice === 'first' ? cue.conflict.first : cue.conflict.second
    cue.conflict = { ...cue.conflict, resolution: choice, resolvedAt: Date.now() }
    if (chosen.status === 'confirmed' || cue.status !== 'confirmed') cue.status = chosen.status
    if (chosen.followupText) cue.followupText = chosen.followupText
  })
}

export function getDelay(cue: Cue, now = Date.now()): number { return Math.max(cue.delaySeconds, Math.round((now - cue.receivedAt) / 1000)) }
export function speakerName(state: DeskState, id: string): string { return state.speakers.find(item => item.id === id)?.name || '未指定' }
export function termTarget(state: DeskState, id: string): string { return state.terms.find(item => item.id === id)?.target || '' }
function detectTerms(text: string, terms: Term[]): string[] {
  const lower = text.toLowerCase()
  return terms.filter(term => lower.includes(term.source.toLowerCase()) || lower.includes(term.target)).map(term => term.target)
}
function findDuplicate(text: string, cues: Cue[]): Cue | undefined {
  return cues.find(cue => similarity(text, cue.text) >= 0.72)
}
