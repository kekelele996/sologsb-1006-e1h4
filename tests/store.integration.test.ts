// @ts-nocheck — 集成测试用例，运行时模拟浏览器环境
import { get } from 'svelte/store'
import {
  acknowledgeReminder, desk, identity, initSync, ingestCue, resolveConflict, retrySync,
  sendReminder, setCueStatus, syncStatus, undoDesk
} from '../src/lib/store'
import { SYNC_KEY } from '../src/lib/sync'

let passed = 0
let failed = 0
function assert(cond: boolean, message: string) {
  if (cond) { passed++ }
  else { failed++; console.error('FAIL:', message) }
}

const kv = new Map<string, string>()
const storageHandlers: Record<string, Array<(event: unknown) => void>> = {}
globalThis.localStorage = {
  getItem: (key: string) => kv.get(key) ?? null,
  setItem: (key: string, value: string) => { kv.set(key, String(value)) },
  removeItem: (key: string) => { kv.delete(key) },
  clear: () => kv.clear()
}
const sessionKv = new Map<string, string>()
globalThis.sessionStorage = {
  getItem: (key: string) => sessionKv.get(key) ?? null,
  setItem: (key: string, value: string) => { sessionKv.set(key, String(value)) },
  removeItem: (key: string) => { sessionKv.delete(key) },
  clear: () => sessionKv.clear()
}
globalThis.window = {
  addEventListener: (type: string, handler: (event: unknown) => void) => {
    (storageHandlers[type] ??= []).push(handler)
  }
}

function fireStorage(key: string) {
  for (const handler of storageHandlers.storage ?? []) handler({ key, newValue: kv.get(key) })
}
function readEnvelope() { return JSON.parse(kv.get(SYNC_KEY) ?? 'null') }
function writeEnvelope(value: unknown) { kv.set(SYNC_KEY, JSON.stringify(value)) }

initSync()
assert(get(identity) !== null, '工位身份已领取')
const myName = get(identity)!.name

// 1. 本页确认 cue-103 → 写入共享队列
setCueStatus('cue-103', 'confirmed')
let env = readEnvelope()
assert(env.version === 2, '确认后信封版本为 2')
assert(env.state.cues.find((c: { id: string }) => c.id === 'cue-103').status === 'confirmed', '共享队列中 cue-103 已确认')
assert(env.state.cues.find((c: { id: string }) => c.id === 'cue-103').confirmedBy?.name === myName, 'confirmedBy 记录本页')

// 2. 模拟另一标签页写入：确认 cue-104
env = readEnvelope()
env.state.cues.find((c: { id: string }) => c.id === 'cue-104').status = 'confirmed'
env.state.cues.find((c: { id: string }) => c.id === 'cue-104').confirmedBy = { tabId: 'tab-other', name: '译员 B', at: Date.now() }
env.version = 3
writeEnvelope(env)
fireStorage(SYNC_KEY)
let state = get(desk)
assert(state.cues.find(c => c.id === 'cue-103')!.status === 'confirmed', '合并后 cue-103 仍确认（不被覆盖）')
assert(state.cues.find(c => c.id === 'cue-104')!.status === 'confirmed', '合并后 cue-104 已确认（对方确认并入）')

// 3. 模拟对方晚到：对 cue-103 标记补译（在我方确认之后）→ 冲突但舞台不回退
env = readEnvelope()
const cue103 = env.state.cues.find((c: { id: string }) => c.id === 'cue-103')
cue103.status = 'followup'
cue103.followupText = '对方补译内容'
cue103.followups = [{ tabId: 'tab-other', name: '译员 B', at: Date.now() + 1000, text: '对方补译内容' }]
cue103.updatedAt = Date.now() + 1000
env.version = 4
writeEnvelope(env)
fireStorage(SYNC_KEY)
state = get(desk)
const merged103 = state.cues.find(c => c.id === 'cue-103')!
assert(merged103.status === 'confirmed', '冲突后舞台仍显示已确认')
assert(merged103.conflict !== null, '出现冲突提示')
assert(merged103.conflict?.first.name === myName, '先确认方标记为本页')
assert(merged103.followups.some(f => f.text === '对方补译内容'), '对方补译保留')

// 4. 晚到方选择“保留我的版本”也不能回退舞台
resolveConflict('cue-103', 'second')
state = get(desk)
assert(state.cues.find(c => c.id === 'cue-103')!.status === 'confirmed', '选择后舞台不回退')
assert(state.cues.find(c => c.id === 'cue-103')!.conflict?.resolution === 'second', '冲突已标记解决')

// 5. 提醒合并：本页发送提醒，对方也发送同一提醒 → 合并为一条
sendReminder('term-1', 'cue-104')
env = readEnvelope()
const remindersBefore = env.state.reminders.length
env.state.reminders.push({ id: 'rem-other', termId: 'term-1', cueId: 'cue-104', target: '城市热岛', createdAt: Date.now(), acknowledged: false })
env.version++
writeEnvelope(env)
fireStorage(SYNC_KEY)
state = get(desk)
assert(state.reminders.length === remindersBefore, '重复术语提醒合并为一条')

// 6. 对方确认提醒 → 本页看到已确认
env = readEnvelope()
env.state.reminders[0].acknowledged = true
env.version++
writeEnvelope(env)
fireStorage(SYNC_KEY)
assert(get(desk).reminders[0].acknowledged === true, '提醒已确认状态同步')

// 7. 撤销只影响本页：撤销本页对 cue-104 的... 本页未改过 cue-104；撤销本页最近一次本地操作（解决冲突）
undoDesk()
state = get(desk)
assert(state.cues.find(c => c.id === 'cue-103')!.status === 'confirmed', '撤销不回退舞台确认')

// 8. 合并失败后可重试：setItem 抛错 → 错误状态 → 恢复后重试成功
const originalSet = globalThis.localStorage.setItem
globalThis.localStorage.setItem = () => { throw new Error('quota exceeded') }
ingestCue('断网期间手工录入的一条字幕内容用于测试')
assert(get(syncStatus) === 'error', '写入失败后进入错误状态，本机继续工作')
globalThis.localStorage.setItem = originalSet
retrySync()
assert(get(syncStatus) === 'ok', '重试后恢复正常')
env = readEnvelope()
assert(env.state.cues.some((c: { text: string }) => c.text.includes('断网期间手工录入')), '重试后本机修改并入共享队列')

// 9. 对方标签页的旧信封（版本号落后）不会让本页回退
const stale = readEnvelope()
stale.version = 1
stale.state.cues.find((c: { id: string }) => c.id === 'cue-103').status = 'pending'
kv.set(SYNC_KEY + '-stale', JSON.stringify(stale))
// 直接构造 storage 事件，key 为 SYNC_KEY 但内容是旧版
storageHandlers.storage![0]({ key: SYNC_KEY, newValue: JSON.stringify(stale) })
state = get(desk)
assert(state.cues.find(c => c.id === 'cue-103')!.status === 'confirmed', '旧版本信封不能回退舞台')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
