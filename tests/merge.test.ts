// @ts-nocheck — 合并逻辑测试用例
import { buildEnvelope, mergeSynced, normalizeSynced, type SyncedState } from '../src/lib/sync'
import type { Cue, CueStatus, Reminder } from '../src/lib/types'

let passed = 0
let failed = 0
function assert(cond: boolean, message: string) {
  if (cond) { passed++ }
  else { failed++; console.error('FAIL:', message) }
}

function cue(id: string, overrides: Partial<Cue> = {}): Cue {
  return {
    id, speakerId: 'sp-1', text: 'text-' + id, receivedAt: 1000, status: 'pending' as CueStatus,
    manual: false, offline: false, delaySeconds: 0, duplicateOf: null, followupText: '',
    tags: [], updatedAt: 1, confirmedBy: null, followups: [], conflict: null, dupChecked: false,
    ...overrides
  }
}

const base: SyncedState = normalizeSynced({
  cues: [cue('a'), cue('b'), cue('c')],
  speakers: [{ id: 'sp-1', name: '原发言人', title: '', language: '', color: '#000', updatedAt: 1 }]
})

// 场景 1：两人同时各确认一条 → 两条都保留
{
  const local = structuredClone(base); local.cues[0].status = 'confirmed'; local.cues[0].updatedAt = 10
  const remote = structuredClone(base); remote.cues[1].status = 'confirmed'; remote.cues[1].updatedAt = 11
  const m = mergeSynced(base, local, remote)
  assert(m.cues.find(c => c.id === 'a')!.status === 'confirmed', '场景1: a 已确认')
  assert(m.cues.find(c => c.id === 'b')!.status === 'confirmed', '场景1: b 已确认')
  assert(m.cues.find(c => c.id === 'c')!.status === 'pending', '场景1: c 待传')
}

// 场景 2：同一条 A 先确认、B 后补译 → 两版保留、标出先确认、舞台不回退
{
  const local = structuredClone(base)
  local.cues[0].status = 'confirmed'; local.cues[0].updatedAt = 10
  local.cues[0].confirmedBy = { tabId: 'A', name: '译员 A', at: 10 }
  const remote = structuredClone(base)
  remote.cues[0].status = 'followup'; remote.cues[0].followupText = '补译 B'; remote.cues[0].updatedAt = 20
  remote.cues[0].followups = [{ tabId: 'B', name: '译员 B', at: 20, text: '补译 B' }]
  const m = mergeSynced(base, local, remote)
  const c = m.cues[0]
  assert(c.status === 'confirmed', '场景2: 舞台保持已确认')
  assert(c.conflict !== null, '场景2: 记录冲突')
  assert(c.conflict?.first.name === '译员 A', '场景2: 先确认方为 A')
  assert(c.conflict?.second.name === '译员 B', '场景2: 晚到方为 B')
  assert(c.followups.length === 1 && c.followups[0].text === '补译 B', '场景2: 补译保留')
  assert(c.confirmedBy?.name === '译员 A', '场景2: confirmedBy 为 A')
}

// 场景 3：A 先补译、B 后确认 → 舞台仍确认
{
  const local = structuredClone(base)
  local.cues[0].status = 'followup'; local.cues[0].followupText = '补译 A'; local.cues[0].updatedAt = 10
  local.cues[0].followups = [{ tabId: 'A', name: '译员 A', at: 10, text: '补译 A' }]
  const remote = structuredClone(base)
  remote.cues[0].status = 'confirmed'; remote.cues[0].updatedAt = 20
  remote.cues[0].confirmedBy = { tabId: 'B', name: '译员 B', at: 20 }
  const m = mergeSynced(base, local, remote)
  assert(m.cues[0].status === 'confirmed', '场景3: 后确认仍上舞台')
  assert(m.cues[0].followups.length === 1, '场景3: 先到补译保留')
  assert(m.cues[0].conflict?.first.name === '译员 A', '场景3: first 为补译的 A')
}

// 场景 4：重复提醒合并，已看到确认取并集
{
  const r1: Reminder = { id: 'r1', termId: 't1', cueId: 'a', target: '韧性', createdAt: 100, acknowledged: false }
  const r2: Reminder = { id: 'r2', termId: 't1', cueId: 'a', target: '韧性', createdAt: 100, acknowledged: true }
  const m = mergeSynced(base, { ...base, reminders: [r1] }, { ...base, reminders: [r2] })
  assert(m.reminders.length === 1, '场景4: 重复提醒合并为一条')
  assert(m.reminders[0].acknowledged === true, '场景4: 已看到状态合并')
}

// 场景 5：晚到方选择“保留我的版本”也不能让已确认舞台回退
{
  const local = structuredClone(base)
  local.cues[0].status = 'confirmed'; local.cues[0].updatedAt = 10
  local.cues[0].confirmedBy = { tabId: 'A', name: '译员 A', at: 10 }
  const remote = structuredClone(base)
  remote.cues[0].status = 'followup'; remote.cues[0].followupText = '补译 B'; remote.cues[0].updatedAt = 20
  remote.cues[0].followups = [{ tabId: 'B', name: '译员 B', at: 20, text: '补译 B' }]
  const m = mergeSynced(base, local, remote)
  m.cues[0].conflict!.resolution = 'second'
  const m2 = mergeSynced(base, m, remote)
  assert(m2.cues[0].status === 'confirmed', '场景5: 选择不回退舞台')
  assert(m2.cues[0].followups.length === 1, '场景5: 补译仍保留')
}

// 场景 6：一方删除、另一方改过 → 修改胜出
{
  const local = structuredClone(base); local.cues = local.cues.filter(c => c.id !== 'c')
  const remote = structuredClone(base); remote.cues[2].status = 'confirmed'; remote.cues[2].updatedAt = 30
  const m = mergeSynced(base, local, remote)
  assert(m.cues.some(c => c.id === 'c'), '场景6: 修改覆盖删除')
}

// 场景 7：双方都删除 → 删除
{
  const local = structuredClone(base); local.cues = local.cues.filter(c => c.id !== 'c')
  const remote = structuredClone(base); remote.cues = remote.cues.filter(c => c.id !== 'c')
  const m = mergeSynced(base, local, remote)
  assert(!m.cues.some(c => c.id === 'c'), '场景7: 双方删除生效')
}

// 场景 8：对方新增条目 → 本页合并进来
{
  const remote = structuredClone(base); remote.cues.push(cue('d', { updatedAt: 5 }))
  const m = mergeSynced(base, base, remote)
  assert(m.cues.length === 4, '场景8: 对方新条目并入')
}

// 场景 9：配置实体后写胜出
{
  const local = structuredClone(base); local.speakers[0].name = 'A'; local.speakers[0].updatedAt = 10
  const remote = structuredClone(base); remote.speakers[0].name = 'B'; remote.speakers[0].updatedAt = 20
  const m = mergeSynced(base, local, remote)
  assert(m.speakers[0].name === 'B', '场景9: 后写胜出')
}

// 场景 10：无远程变更 → 保留本页
{
  const local = structuredClone(base); local.cues[0].status = 'confirmed'
  const m = mergeSynced(base, local, null)
  assert(m.cues[0].status === 'confirmed', '场景10: 无远程时保留本页')
}

// 场景 11：信封版本号单调
{
  const env1 = buildEnvelope(base, 0, null, { id: 't1', name: '译员 A', color: '#0f766e' })
  const env2 = buildEnvelope(base, 1, env1, { id: 't2', name: '译员 B', color: '#b45309' })
  assert(env1.version === 1 && env2.version === 2, '场景11: 版本号单调递增')
  assert(Object.keys(env2.writers).length === 2, '场景11: 在岗双方都记录')
}

// 场景 12：对方同步来的新字幕与本页高度相似 → 自动标重复
{
  const local = structuredClone(base)
  local.cues.push(cue('d', { text: 'The urban heat island effect is not evenly distributed across districts.', updatedAt: 5 }))
  const remote = structuredClone(base)
  remote.cues.push(cue('e', { text: 'The urban heat island effect is not evenly distributed across districts!', updatedAt: 6 }))
  const m = mergeSynced(base, local, remote)
  const d = m.cues.find(c => c.id === 'd')!
  const e = m.cues.find(c => c.id === 'e')!
  assert(d.duplicateOf === 'e' || e.duplicateOf === 'd', '场景12: 跨页新条目标记重复')
}

// 场景 13：本页已确认非重复（dupChecked）→ 合并后不重新标红
{
  const local = structuredClone(base)
  local.cues.push(cue('d', { text: 'The urban heat island effect is not evenly distributed across districts.', updatedAt: 5, dupChecked: true }))
  const remote = structuredClone(base)
  remote.cues.push(cue('e', { text: 'The urban heat island effect is not evenly distributed across districts!', updatedAt: 6 }))
  const m = mergeSynced(base, local, remote)
  const d = m.cues.find(c => c.id === 'd')!
  assert(d.duplicateOf === null, '场景13: 已确认非重复不被重新标红')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
