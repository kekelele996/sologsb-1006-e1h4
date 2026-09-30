export type CueStatus = 'pending' | 'confirmed' | 'followup'
export type TabId = 'live' | 'backstage' | 'terms' | 'offline'

export interface Speaker {
  id: string
  name: string
  title: string
  language: string
  color: string
  updatedAt: number
}

export interface Session {
  id: string
  order: number
  time: string
  title: string
  speakerId: string
  room: string
  status: 'upcoming' | 'live' | 'done'
  updatedAt: number
}

export interface Term {
  id: string
  source: string
  target: string
  note: string
  speakerId: string
  priority: 'normal' | 'high'
  updatedAt: number
}

export interface Announcement {
  id: string
  level: 'info' | 'warning' | 'urgent'
  text: string
  visibleOnStage: boolean
  createdAt: string
  updatedAt: number
}

/** 谁先确认了这条字幕（用于在舞台和队列上标记先确认方） */
export interface ConfirmedBy {
  tabId: string
  name: string
  at: number
}

/** 一版补译内容，保留双方各自的版本 */
export interface FollowupEntry {
  tabId: string
  name: string
  at: number
  text: string
}

/** 冲突中某一方对该条字幕的处理版本 */
export interface ConflictVersion {
  tabId: string
  name: string
  at: number
  status: CueStatus
  followupText: string
}

/** 两人先后处理同一条字幕时保留的两版处理记录 */
export interface CueConflict {
  at: number
  first: ConflictVersion
  second: ConflictVersion
  resolution: 'first' | 'second' | null
  resolvedAt: number | null
}

export interface Cue {
  id: string
  speakerId: string
  text: string
  receivedAt: number
  status: CueStatus
  manual: boolean
  offline: boolean
  delaySeconds: number
  duplicateOf: string | null
  followupText: string
  tags: string[]
  updatedAt: number
  confirmedBy: ConfirmedBy | null
  followups: FollowupEntry[]
  conflict: CueConflict | null
  /** 用户已手动确认“非重复”，合并时不再自动标红 */
  dupChecked: boolean
}

export interface Reminder {
  id: string
  termId: string
  cueId: string
  target: string
  createdAt: number
  acknowledged: boolean
}

export interface DeskState {
  speakers: Speaker[]
  sessions: Session[]
  terms: Term[]
  announcements: Announcement[]
  cues: Cue[]
  reminders: Reminder[]
  activeCueId: string
  fontScale: number
  online: boolean
  liveSimulation: boolean
  updatedAt: string
}

/** 参与多标签接力的一个值守工位（标签页级身份，仅存 sessionStorage） */
export interface TabIdentity {
  id: string
  name: string
  color: string
}

export interface WriterInfo {
  name: string
  color: string
  lastAt: number
}

/** 多标签共享队列的同步信封，写入 localStorage */
export interface SyncEnvelope {
  version: number
  updatedAt: string
  writers: Record<string, WriterInfo>
  state: {
    speakers: Speaker[]
    sessions: Session[]
    terms: Term[]
    announcements: Announcement[]
    cues: Cue[]
    reminders: Reminder[]
  }
}
