import type {
  Announcement, ConfirmedBy, ConflictVersion, Cue, CueConflict, CueStatus, DeskState, FollowupEntry,
  Reminder, Session, Speaker, SyncEnvelope, TabIdentity, Term, WriterInfo
} from './types'

export const SYNC_KEY = 'conference-cue-desk-v2'
export const LEGACY_KEY = 'conference-cue-desk-v1'
const IDENTITY_KEY = 'cue-desk-identity'
const WRITER_TTL = 24 * 60 * 60 * 1000

export type SyncedState = SyncEnvelope['state']

const NAME_POOL: Array<[string, string]> = [
  ['译员 A', '#0f766e'],
  ['译员 B', '#b45309'],
  ['译员 C', '#6d28d9'],
  ['译员 D', '#be123c']
]

function clone<T>(value: T): T { return structuredClone(value) }

export function emptySynced(): SyncedState {
  return { speakers: [], sessions: [], terms: [], announcements: [], cues: [], reminders: [] }
}

/** 读取共享队列信封；损坏或不存在时返回 null（调用方进入重试/迁移流程） */
export function readEnvelope(): SyncEnvelope | null {
  try {
    const raw = localStorage.getItem(SYNC_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number' || !parsed.state) return null
    return parsed as SyncEnvelope
  } catch {
    return null
  }
}

export function writeEnvelope(envelope: SyncEnvelope): void {
  localStorage.setItem(SYNC_KEY, JSON.stringify(envelope))
}

/** 读取旧版本（v1）整页状态，用于首次升级迁移 */
export function readLegacyState(): Partial<DeskState> | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Partial<DeskState> : null
  } catch {
    return null
  }
}

export function syncedOf(state: DeskState): SyncedState {
  return {
    speakers: clone(state.speakers),
    sessions: clone(state.sessions),
    terms: clone(state.terms),
    announcements: clone(state.announcements),
    cues: clone(state.cues),
    reminders: clone(state.reminders)
  }
}

/** 补齐旧版本数据中缺失的字段，保证合并逻辑字段齐全 */
export function normalizeSynced(input: Partial<SyncedState> | null | undefined): SyncedState {
  const state: SyncedState = {
    speakers: input?.speakers ?? [],
    sessions: input?.sessions ?? [],
    terms: input?.terms ?? [],
    announcements: input?.announcements ?? [],
    cues: input?.cues ?? [],
    reminders: input?.reminders ?? []
  }
  const now = Date.now()
  state.speakers.forEach((item, index) => { if (typeof item.updatedAt !== 'number') item.updatedAt = index })
  state.sessions.forEach((item, index) => { if (typeof item.updatedAt !== 'number') item.updatedAt = index })
  state.terms.forEach((item, index) => { if (typeof item.updatedAt !== 'number') item.updatedAt = index })
  state.announcements.forEach((item, index) => { if (typeof item.updatedAt !== 'number') item.updatedAt = index })
  state.cues.forEach(cue => {
    if (typeof cue.updatedAt !== 'number') cue.updatedAt = cue.receivedAt || now
    if (!Array.isArray(cue.followups)) cue.followups = []
    const legacy = cue as Cue & { conflict?: CueConflict | null; confirmedBy?: ConfirmedBy | null; dupChecked?: boolean }
    if (legacy.conflict === undefined) cue.conflict = null
    if (legacy.confirmedBy === undefined) cue.confirmedBy = null
    if (typeof legacy.dupChecked !== 'boolean') cue.dupChecked = false
  })
  return state
}

/** 每个标签页首次打开时领取一个工位身份，写入 sessionStorage 后同页刷新保持不变 */
export function loadIdentity(writers: Record<string, WriterInfo>): TabIdentity {
  try {
    const saved = sessionStorage.getItem(IDENTITY_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<TabIdentity>
      if (parsed.id && parsed.name && parsed.color) return { id: parsed.id, name: parsed.name, color: parsed.color }
    }
  } catch { /* sessionStorage 不可用时随机领取 */ }
  const usedNames = new Set(Object.values(writers).map(writer => writer.name))
  const pick = NAME_POOL.find(([name]) => !usedNames.has(name)) ?? NAME_POOL[0]
  const identity: TabIdentity = {
    id: `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: pick[0],
    color: pick[1]
  }
  try { sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)) } catch { /* 忽略持久化失败 */ }
  return identity
}

export function mergeWriters(remote: Record<string, WriterInfo> | undefined, me: TabIdentity): Record<string, WriterInfo> {
  const writers: Record<string, WriterInfo> = { ...(remote ?? {}) }
  writers[me.id] = { name: me.name, color: me.color, lastAt: Date.now() }
  const cutoff = Date.now() - WRITER_TTL
  for (const [id, writer] of Object.entries(writers)) {
    if (writer.lastAt < cutoff) delete writers[id]
  }
  return writers
}

export function buildEnvelope(state: SyncedState, baseVersion: number, remote: SyncEnvelope | null, me: TabIdentity): SyncEnvelope {
  return {
    version: Math.max(remote?.version ?? 0, baseVersion) + 1,
    updatedAt: new Date().toISOString(),
    writers: mergeWriters(remote?.writers, me),
    state
  }
}

/* ----------------------------- 三路合并 ----------------------------- */

function entityChanged<T extends { id: string }>(before: T | undefined, after: T): boolean {
  if (!before) return true
  return JSON.stringify(before) !== JSON.stringify(after)
}

/** 配置类实体（发言人/场次/术语/通知）按 updatedAt 做实体级后写胜出 */
function mergeEntities<T extends { id: string; updatedAt: number }>(base: T[], local: T[], remote: T[]): T[] {
  const baseMap = new Map(base.map(item => [item.id, item]))
  const localMap = new Map(local.map(item => [item.id, item]))
  const remoteMap = new Map(remote.map(item => [item.id, item]))
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])
  const out: T[] = []
  for (const id of ids) {
    const before = baseMap.get(id)
    const l = localMap.get(id)
    const r = remoteMap.get(id)
    if (l && r) {
      const lChanged = entityChanged(before, l)
      const rChanged = entityChanged(before, r)
      if (lChanged && !rChanged) out.push(l)
      else if (rChanged && !lChanged) out.push(r)
      else out.push(l.updatedAt >= r.updatedAt ? l : r)
    } else if (l) {
      out.push(l)
    } else if (r) {
      // 本地删除、对方也未改动 → 视为删除；对方改过则保留
      if (!before || entityChanged(before, r)) out.push(r)
    }
  }
  return out
}

function stageStatusOf(a: CueStatus, b: CueStatus): CueStatus {
  if (a === 'confirmed' || b === 'confirmed') return 'confirmed'
  if (a === 'followup' || b === 'followup') return 'followup'
  return 'pending'
}

function rankStatus(status: CueStatus): number {
  return status === 'confirmed' ? 2 : status === 'followup' ? 1 : 0
}

function pickConfirmedBy(local: Cue, remote: Cue): ConfirmedBy | null {
  const candidates = [local.confirmedBy, remote.confirmedBy].filter((item): item is ConfirmedBy => Boolean(item))
  if (!candidates.length) return null
  return candidates.reduce((earliest, item) => (item.at < earliest.at ? item : earliest))
}

function mergeFollowups(before: Cue | undefined, local: Cue, remote: Cue): FollowupEntry[] {
  const entries: FollowupEntry[] = []
  const seen = new Set<string>()
  const add = (entry: FollowupEntry | null | undefined) => {
    if (!entry || !entry.text.trim()) return
    const key = `${entry.tabId}|${entry.at}|${entry.text}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }
  for (const entry of local.followups ?? []) add(entry)
  for (const entry of remote.followups ?? []) add(entry)
  // 兼容旧数据：followupText 相对基线变化时补一条记录
  const derive = (side: Cue, fallbackName: string): void => {
    const text = side.followupText?.trim()
    if (!text) return
    if (before && before.followupText?.trim() === text) return
    if (entries.some(entry => entry.text === text)) return
    add({ tabId: side.confirmedBy?.tabId ?? 'legacy', name: fallbackName, at: side.updatedAt, text })
  }
  derive(local, '本页')
  derive(remote, '对方')
  entries.sort((a, b) => a.at - b.at)
  return entries
}

function versionName(side: Cue): string {
  if (side.confirmedBy?.name) return side.confirmedBy.name
  const last = [...(side.followups ?? [])].sort((a, b) => b.at - a.at)[0]
  return last?.name ?? '对方'
}

function buildConflictVersion(side: Cue): { tabId: string; name: string; at: number; status: CueStatus; followupText: string } {
  return {
    tabId: side.confirmedBy?.tabId ?? side.followups?.at(-1)?.tabId ?? 'unknown',
    name: versionName(side),
    at: side.updatedAt,
    status: side.status,
    followupText: side.followupText ?? ''
  }
}

function sameConflict(a: CueConflict | null, b: CueConflict | null): boolean {
  return Boolean(a && b && a.at === b.at)
}

/** 冲突解决结果合并：双方都解决过则保留“不让舞台回退”的选择，否则取较晚解决的一方 */
function mergeResolution(
  local: Cue, remote: Cue, merged: Cue
): { resolution: 'first' | 'second'; chosen: { status: CueStatus; followupText: string } } | null {
  const lc = local.conflict
  const rc = remote.conflict
  if (!lc?.resolution && !rc?.resolution) return null
  let resolution: 'first' | 'second'
  let chosenConflict: CueConflict
  if (lc?.resolution && rc?.resolution) {
    const lr = lc.resolution
    const rr = rc.resolution
    if (lr === rr) {
      resolution = lr
      chosenConflict = lc
    } else {
      const lChoice = lr === 'first' ? lc.first : lc.second
      const rChoice = rr === 'first' ? rc.first : rc.second
      // 优先保留“已确认上舞台”的选择，其次取较晚的解决时间
      if (lChoice.status === 'confirmed' && rChoice.status !== 'confirmed') { resolution = lr; chosenConflict = lc }
      else if (rChoice.status === 'confirmed' && lChoice.status !== 'confirmed') { resolution = rr; chosenConflict = rc }
      else {
        const lAt = lc.resolvedAt ?? 0
        const rAt = rc.resolvedAt ?? 0
        if (rAt >= lAt) { resolution = rr; chosenConflict = rc }
        else { resolution = lr; chosenConflict = lc }
      }
    }
  } else if (lc?.resolution) {
    resolution = lc.resolution
    chosenConflict = lc
  } else if (rc?.resolution) {
    resolution = rc.resolution
    chosenConflict = rc
  } else {
    return null
  }
  const chosen = resolution === 'first' ? chosenConflict.first : chosenConflict.second
  // 舞台不回退：任何选择都不能把已确认状态改回未确认
  const status = chosen.status === 'confirmed' || merged.status === 'confirmed'
    ? 'confirmed'
    : rankStatus(chosen.status) >= rankStatus(merged.status) ? chosen.status : merged.status
  return { resolution, chosen: { status, followupText: chosen.followupText } }
}

function mergeConflict(before: Cue | undefined, local: Cue, remote: Cue, merged: Cue): CueConflict | null {
  const existing = sameConflict(local.conflict, remote.conflict) ? local.conflict : (local.conflict ?? remote.conflict ?? null)
  const treatmentOf = (side: Cue) => ({ status: side.status, followupText: side.followupText ?? '' })
  const sameTreatment = (a: { status: CueStatus; followupText: string }, b: { status: CueStatus; followupText: string }) =>
    a.status === b.status && a.followupText === b.followupText
  const lt = treatmentOf(local)
  const rt = treatmentOf(remote)
  const bt = before ? treatmentOf(before) : null
  const lChanged = before ? !sameTreatment(lt, bt!) : true
  const rChanged = before ? !sameTreatment(rt, bt!) : true
  const baseProcessed = before ? before.status !== 'pending' || Boolean(before.followupText?.trim()) : false

  let conflict: CueConflict | null = existing
  if (!sameTreatment(lt, rt)) {
    if (lChanged && rChanged) {
      // 双方并发修改且与基线处理不一致 → 两版都保留
      const lv = buildConflictVersion(local)
      const rv = buildConflictVersion(remote)
      const first = local.updatedAt <= remote.updatedAt ? lv : rv
      const second = local.updatedAt <= remote.updatedAt ? rv : lv
      conflict = { at: Math.max(local.updatedAt, remote.updatedAt), first, second, resolution: null, resolvedAt: null }
    } else if (baseProcessed && (lChanged || rChanged)) {
      // 基线已有处理（如已确认上舞台），一方又给出不同处理 → 先处理与晚到处理两版都保留
      const changedSide = lChanged ? local : remote
      const first: ConflictVersion = {
        tabId: before?.confirmedBy?.tabId ?? 'earlier',
        name: before?.confirmedBy?.name ?? '先前值守',
        at: before?.updatedAt ?? 0,
        status: before?.status ?? 'pending',
        followupText: before?.followupText ?? ''
      }
      const second = buildConflictVersion(changedSide)
      conflict = { at: Math.max(before?.updatedAt ?? 0, changedSide.updatedAt), first, second, resolution: null, resolvedAt: null }
    }
  }

  if (conflict) {
    const resolved = mergeResolution(local, remote, merged)
    if (resolved) {
      conflict = { ...conflict, resolution: resolved.resolution, resolvedAt: Date.now() }
      if (resolved.chosen.status === 'confirmed' || merged.status !== 'confirmed') merged.status = resolved.chosen.status
      if (resolved.chosen.followupText) merged.followupText = resolved.chosen.followupText
    }
  }
  return conflict
}

function mergeOneCue(before: Cue | undefined, local: Cue, remote: Cue): Cue {
  // 文本/发言人等标量字段按 updatedAt 后写胜出；状态与补译单独合并
  const newer = local.updatedAt >= remote.updatedAt ? local : remote
  const merged: Cue = { ...newer, followups: [] }

  const lChanged = before
    ? local.status !== before.status || (local.followupText ?? '') !== (before.followupText ?? '')
    : true
  const rChanged = before
    ? remote.status !== before.status || (remote.followupText ?? '') !== (before.followupText ?? '')
    : true
  // 舞台不回退：任一版本已确认，合并后保持已确认
  const anyConfirmed = before?.status === 'confirmed' || local.status === 'confirmed' || remote.status === 'confirmed'
  if (anyConfirmed) merged.status = 'confirmed'
  else if (!lChanged && !rChanged) merged.status = before?.status ?? local.status
  else if (!lChanged) merged.status = remote.status
  else if (!rChanged) merged.status = local.status
  else if (local.status === remote.status) merged.status = local.status
  else merged.status = stageStatusOf(local.status, remote.status)

  merged.confirmedBy = pickConfirmedBy(local, remote)
  merged.followups = mergeFollowups(before, local, remote)
  // 主补译文本取最新一版，两版都保留在 followups 中
  const latest = [...merged.followups].sort((a, b) => b.at - a.at)[0]
  merged.followupText = latest?.text ?? newer.followupText ?? ''
  merged.dupChecked = Boolean(local.dupChecked || remote.dupChecked)
  merged.duplicateOf = local.duplicateOf && remote.duplicateOf
    ? (local.updatedAt >= remote.updatedAt ? local.duplicateOf : remote.duplicateOf)
    : local.duplicateOf ?? remote.duplicateOf ?? null
  merged.conflict = mergeConflict(before, local, remote, merged)
  return merged
}

function orderCues(cues: Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id))
}

export function mergeCues(base: Cue[], local: Cue[], remote: Cue[]): Cue[] {
  const baseMap = new Map(base.map(cue => [cue.id, cue]))
  const localMap = new Map(local.map(cue => [cue.id, cue]))
  const remoteMap = new Map(remote.map(cue => [cue.id, cue]))
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])
  const out: Cue[] = []
  for (const id of ids) {
    const before = baseMap.get(id)
    const l = localMap.get(id)
    const r = remoteMap.get(id)
    if (!l && !r) continue
    if (!l) {
      // 本地删除：对方未改动则随删除，对方改过则保留
      if (r && (!before || entityChanged(before, r))) out.push(r)
      continue
    }
    if (!r) {
      if (!before || entityChanged(before, l)) out.push(l)
      continue
    }
    out.push(mergeOneCue(before, l, r))
  }
  // 清理指向已删除条目的重复标记
  const liveIds = new Set(out.map(cue => cue.id))
  for (const cue of out) {
    if (cue.duplicateOf && !liveIds.has(cue.duplicateOf)) cue.duplicateOf = null
  }
  return orderCues(out)
}

function mergeReminders(local: Reminder[], remote: Reminder[]): Reminder[] {
  const map = new Map<string, Reminder>()
  for (const item of [...local, ...remote]) {
    const key = `${item.termId}|${item.cueId}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, item)
      continue
    }
    const earlier = item.createdAt < existing.createdAt ? item : existing
    map.set(key, { ...earlier, acknowledged: existing.acknowledged || item.acknowledged })
  }
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/* ----------------------------- 相似度与跨标签去重 ----------------------------- */

export function similarity(a: string, b: string): number {
  const grams = (value: string) => {
    const clean = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    return new Set(Array.from({ length: Math.max(0, clean.length - 1) }, (_, index) => clean.slice(index, index + 2)))
  }
  const left = grams(a)
  const right = grams(b)
  if (!left.size || !right.size) return a.trim() === b.trim() ? 1 : 0
  let intersection = 0
  left.forEach(item => { if (right.has(item)) intersection++ })
  return intersection / (left.size + right.size - intersection)
}

/** 合并后对来自其他标签页的新字幕做跨页重复检测 */
export function applyCrossTabDuplicates(cues: Cue[]): Cue[] {
  for (const cue of cues) {
    if (cue.dupChecked || cue.duplicateOf) continue
    const match = cues.find(other => other.id !== cue.id && similarity(cue.text, other.text) >= 0.72)
    if (match) cue.duplicateOf = match.id
  }
  return cues
}

/** 三路合并入口：base 为上次同步快照，local 为本页状态，remote 为共享队列最新状态 */
export function mergeSynced(base: SyncedState, local: SyncedState, remote: SyncedState | null): SyncedState {
  if (!remote) return clone(local)
  const cues = applyCrossTabDuplicates(mergeCues(base.cues, local.cues, remote.cues))
  return {
    speakers: mergeEntities(base.speakers, local.speakers, remote.speakers),
    sessions: mergeEntities(base.sessions, local.sessions, remote.sessions),
    terms: mergeEntities(base.terms, local.terms, remote.terms),
    announcements: mergeEntities(base.announcements, local.announcements, remote.announcements),
    cues,
    reminders: mergeReminders(local.reminders, remote.reminders)
  }
}

/** 从旧版本 v1 状态迁移到同步信封状态 */
export function syncedFromLegacy(legacy: Partial<DeskState>): SyncedState {
  return normalizeSynced({
    speakers: legacy.speakers as Speaker[] | undefined,
    sessions: legacy.sessions as Session[] | undefined,
    terms: legacy.terms as Term[] | undefined,
    announcements: legacy.announcements as Announcement[] | undefined,
    cues: legacy.cues as Cue[] | undefined,
    reminders: legacy.reminders as Reminder[] | undefined
  })
}
