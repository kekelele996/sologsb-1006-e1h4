export type CueStatus = 'pending' | 'confirmed' | 'followup'
export type TabId = 'live' | 'backstage' | 'terms' | 'offline'

export interface Speaker {
  id: string
  name: string
  title: string
  language: string
  color: string
  /** 单调修订号，后台准备类实体按修订号做最后写入胜出合并 */
  rev?: number
}

export interface Session {
  id: string
  order: number
  time: string
  title: string
  speakerId: string
  room: string
  status: 'upcoming' | 'live' | 'done'
  rev?: number
}

export interface Term {
  id: string
  source: string
  target: string
  note: string
  speakerId: string
  priority: 'normal' | 'high'
  rev?: number
}

export interface Announcement {
  id: string
  level: 'info' | 'warning' | 'urgent'
  text: string
  visibleOnStage: boolean
  createdAt: string
  rev?: number
}

/** 一条字幕上的一次确认，按值守人追加，多人确认时多版并存 */
export interface Confirmation {
  operator: string
  tabId: string
  at: number
}

/** 一条字幕上的一次补译，同样按值守人追加保留 */
export interface Followup {
  id: string
  operator: string
  tabId: string
  text: string
  at: number
}

export interface Cue {
  id: string
  speakerId: string
  text: string
  receivedAt: number
  /** 派生状态：有确认为已确认，否则有补译为有补充 */
  status: CueStatus
  manual: boolean
  offline: boolean
  delaySeconds: number
  duplicateOf: string | null
  /** 规范化采用的补译文本（默认最早一版，冲突裁定后采用所选版本），兼容展示 */
  followupText: string
  tags: string[]
  /** 条目修订号（结构字段） */
  rev: number
  confirmations: Confirmation[]
  followups: Followup[]
  /** 最近一次正文类编辑的值守人，用于冲突对版 */
  editor: string
  editorTabId: string
  editedAt: number
}

export interface Reminder {
  id: string
  termId: string
  cueId: string
  target: string
  createdAt: number
  /** 派生：ackedBy 非空即为已看到 */
  acknowledged: boolean
  /** 最早发送该提醒的值守人 */
  operator: string
  /** 所有发送过同一提醒的值守人（同术语同条目去重合并） */
  senders: string[]
  /** 所有点过“已看到”的值守人，只增不减 */
  ackedBy: string[]
}

/** 已上舞台的字幕行，只追加、不回退 */
export interface StageLine {
  cueId: string
  text: string
  speakerId: string
  speakerName: string
  at: number
  firstOperator: string
  /** 接力确认过该条的值守人（含首位） */
  operators: string[]
}

/**
 * 集合型协作字段的删除墓碑：撤销自己的确认 / 补译 / 已看到时登记，
 * 用于避免对端基于旧快照合并时把已删除内容“复活”。
 */
export interface RelayTombstone {
  /** confirm:<cueId>:<tabId> / followup:<followupId> / ack:<reminderId>:<operator> / sender:<reminderId>:<operator> */
  key: string
  at: number
}

export interface ConflictVersion {
  /** 稳定对版键：确认用 tabId，补译用 followup id，编辑用 local/remote:tabId */
  key: string
  operator: string
  tabId: string
  at: number
  /** 列表中展示的短标签（确认 / 补译正文 / 编辑值） */
  label: string
  /** 编辑类冲突的字段值 */
  value?: string
}

export type ConflictKind = 'dual-confirm' | 'dual-followup' | 'edit'

export interface Conflict {
  id: string
  cueId: string
  kind: ConflictKind
  /** 编辑类冲突的字段名 */
  field?: string
  fieldLabel?: string
  versions: ConflictVersion[]
  chosenKey: string | null
  resolvedBy: string | null
  resolvedAt: number | null
  createdAt: number
}

export interface DeskState {
  version: number
  /** 每次写入生成的修订令牌，用于识别对端更新 */
  rev: string
  speakers: Speaker[]
  sessions: Session[]
  terms: Term[]
  announcements: Announcement[]
  cues: Cue[]
  reminders: Reminder[]
  stageLines: StageLine[]
  conflicts: Conflict[]
  tombstones: RelayTombstone[]
  activeCueId: string
  fontScale: number
  online: boolean
  liveSimulation: boolean
  updatedAt: string
}
