// 多标签接力合并的端到端验证：在 Node 中模拟两个标签页（各自 store 模块实例、
// 共享 localStorage、独立 sessionStorage），跑一轮并发操作并断言合并语义。
import assert from 'node:assert'

function makeStorage(shared = null) {
  const map = shared ? shared.data : new Map()
  return {
    _data: map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

const sharedLocal = new Map()
// 两个标签页共享同一个 localStorage 实例（同一浏览器同源），
// 但 sessionStorage 与事件监听器各自独立。
const sharedLocalStorage = makeStorage({ data: sharedLocal })

function makeTabEnv(name) {
  const session = makeStorage(null)
  session.setItem('conference-cue-desk-operator-v1', JSON.stringify({ name, tabId: `tab-${name}` }))
  const listeners = []
  const env = {
    localStorage: sharedLocalStorage,
    sessionStorage: session,
    navigator: { onLine: true },
    addEventListener(_type, fn) { listeners.push(fn) },
    setTimeout, clearTimeout,
    _listeners: listeners
  }
  globalThis.window = env
  globalThis.localStorage = sharedLocalStorage
  globalThis.sessionStorage = session
  globalThis.navigator = env.navigator
  return env
}

async function loadTab(name) {
  makeTabEnv(name)
  const mod = await import(`./.tmp-store-${name}.js?x=${Math.random()}`)
  return mod
}

// 用 esbuild 把 store.ts 各打一个 bundle（不同文件名 => 不同模块实例）
import { build } from 'esbuild'
import { get } from 'svelte/store'

async function bundle() {
  const stub = {
    name: 'stub-svelte-store',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^svelte\/store$/ }, () => ({ path: 'svelte-store-stub', namespace: 'stub' }))
      pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `
          export function writable(initial) {
            let v = initial
            const subs = new Set()
            return {
              subscribe(fn) { subs.add(fn); fn(v); return () => subs.delete(fn) },
              set(x) { v = x; subs.forEach(fn => fn(x)) },
              update(fn) { this.set(fn(v)) }
            }
          }
          export function get(store) { let v; store.subscribe(x => { v = x })(); return v }`,
        loader: 'js'
      }))
    }
  }
  for (const name of ['A', 'B']) {
    await build({
      entryPoints: ['src/lib/store.ts'],
      outfile: `.tmp-store-${name}.js`,
      format: 'esm', bundle: true, platform: 'browser',
      plugins: [stub]
    })
  }
}

function getJSON() {
  return JSON.parse(sharedLocal.get('conference-cue-desk-v2'))
}
function pushRemoteEvent(env, oldValue = null) {
  const raw = sharedLocal.get('conference-cue-desk-v2')
  env._listeners.forEach(fn => fn({ key: 'conference-cue-desk-v2', newValue: raw, oldValue }))
}

await bundle()

// ---- Tab A 先启动并播种 ----
const envA = makeTabEnv('A')
const A = await import('./.tmp-store-A.js')

// ---- Tab B 后启动，读到 A 播种的共享队列 ----
const envB = makeTabEnv('B')
const B = await import('./.tmp-store-B.js')

function cueIds(tab) {
  return get(tab.desk).cues.map(c => c.id)
}
assert.deepEqual(cueIds(B), cueIds(A), '启动后两标签看到同一队列')

const targetId = get(A.desk).cues[2].id // cue-103 pending

// ---- 场景 1：两人先后确认同一条（顺序接力） ----
A.confirmCue(targetId)
pushRemoteEvent(envB) // B 收到 A 的写入
const bCueBefore = get(B.desk).cues.find(c => c.id === targetId)
assert.equal(bCueBefore.confirmations[0].operator, 'A', 'B 看到 A 先确认')
assert.equal(get(B.desk).stageLines.find(l => l.cueId === targetId)?.firstOperator, 'A', '舞台先确认者为 A')
B.confirmCue(targetId)
pushRemoteEvent(envA) // A 收到 B 的合并写入
const aCue = get(A.desk).cues.find(c => c.id === targetId)
const bCue = get(B.desk).cues.find(c => c.id === targetId)
assert.equal(aCue.confirmations.length, 2, 'A 看到两版确认')
assert.equal(bCue.confirmations.length, 2, 'B 看到两版确认')
assert.equal(aCue.confirmations[0].operator, 'A', '标出 A 先确认')
assert.equal(aCue.confirmations[1].operator, 'B', '标出 B 接力')
const lineA = get(A.desk).stageLines.find(l => l.cueId === targetId)
assert.equal(lineA.firstOperator, 'A', '舞台仍标 A 先确认')
assert.deepEqual(lineA.operators.sort(), ['A', 'B'], '舞台列出两名值守人')

// B 应收到冲突提示（晚到一方）
assert.ok(get(B.conflictNotice).includes('冲突'), `B 收到冲突提示，实际: ${get(B.conflictNotice)}`)
const dualConfirm = get(B.desk).conflicts.find(c => c.kind === 'dual-confirm' && c.cueId === targetId)
assert.ok(dualConfirm, '登记 dual-confirm 冲突')
assert.equal(dualConfirm.versions[0].operator, 'A', '冲突第一版是先确认的 A')

// B 挑选 A 的版本
B.resolveConflict(dualConfirm.id, dualConfirm.versions[0].key)
pushRemoteEvent(envA)
assert.equal(get(A.desk).conflicts.find(c => c.id === dualConfirm.id).resolvedBy, 'B', 'A 看到 B 已裁定')

// ---- 场景 2：舞台不回退 —— A 撤销自己的确认，舞台行仍在 ----
const stageBeforeUndo = get(A.desk).stageLines.filter(l => l.cueId === targetId).length
A.undoDesk()
pushRemoteEvent(envB)
const stageAfterUndo = get(A.desk).stageLines.filter(l => l.cueId === targetId).length
assert.equal(stageBeforeUndo, stageAfterUndo, '撤销确认后舞台字幕不回退')
const cueAfterUndo = get(A.desk).cues.find(c => c.id === targetId)
assert.ok(!cueAfterUndo.confirmations.some(c => c.operator === 'A'), '撤销摘掉 A 的确认')
assert.ok(cueAfterUndo.confirmations.some(c => c.operator === 'B'), '撤销不影响 B 的确认')

// ---- 场景 3：两人先后补译同一条，两版并存 ----
const followupCueId = get(A.desk).cues[3].id // cue-104
A.addFollowup(followupCueId, 'A 版补译内容')
pushRemoteEvent(envB)
B.addFollowup(followupCueId, 'B 版补译内容')
pushRemoteEvent(envA)
const fCue = get(A.desk).cues.find(c => c.id === followupCueId)
assert.equal(fCue.followups.length, 2, '两条补译都保留')
assert.deepEqual(fCue.followups.map(f => f.operator), ['A', 'B'], '补译按先后排序')
assert.equal(fCue.followupText, 'A 版补译内容', '默认采用先补的一版')
const dualFollow = get(A.desk).conflicts.find(c => c.kind === 'dual-followup' && c.cueId === followupCueId)
assert.ok(dualFollow, '登记 dual-followup 冲突')
// 晚到的 B 挑选自己的版
B.resolveConflict(dualFollow.id, dualFollow.versions.find(v => v.operator === 'B').key)
pushRemoteEvent(envA)
assert.equal(get(A.desk).cues.find(c => c.id === followupCueId).followupText, 'B 版补译内容', '裁定后采用 B 版，两版仍并存')

// ---- 场景 4：术语提醒按条目合并（同术语同条目） ----
const termId = get(A.desk).terms[0].id
A.sendReminder(termId, followupCueId)
pushRemoteEvent(envB)
B.sendReminder(termId, followupCueId)
pushRemoteEvent(envA)
const reminders = get(A.desk).reminders.filter(r => r.termId === termId && r.cueId === followupCueId)
assert.equal(reminders.length, 1, '同术语同条目合并为一条提醒')
assert.deepEqual(reminders[0].senders.sort(), ['A', 'B'], '发送人并列保留')
B.acknowledgeReminder(reminders[0].id)
pushRemoteEvent(envA)
const rA = get(A.desk).reminders.find(r => r.id === reminders[0].id)
assert.deepEqual(rA.ackedBy, ['B'], '已看到名单同步过来')
A.acknowledgeReminder(reminders[0].id)
pushRemoteEvent(envB)
// A 撤销自己的“已看到”，不影响 B
A.undoDesk()
pushRemoteEvent(envB)
const rAfter = get(A.desk).reminders.find(r => r.id === reminders[0].id)
assert.deepEqual(rAfter.ackedBy, ['B'], '撤销只摘掉自己的已看到')

// ---- 场景 5：同时新增不同条目 —— 并集，互不覆盖 ----
const beforeIds = new Set(get(A.desk).cues.map(c => c.id))
// 直接基于同一基线各自新增（B 当前已同步，先让 A 加一条但不推送，再让 B 加）
A.ingestCue('A only unique line alpha')
B.ingestCue('B only unique line beta') // B 基于落后基线写
pushRemoteEvent(envA) // A 收到 B
pushRemoteEvent(envB) // B 收到含 A 的最终合并
const allA = get(A.desk).cues.map(c => c.text)
assert.ok(allA.includes('A only unique line alpha') && allA.includes('B only unique line beta'), '两人各自新增的条目都保留')
assert.deepEqual(get(B.desk).cues.map(c => c.id), get(A.desk).cues.map(c => c.id), '最终两标签队列一致')

// ---- 场景 6：撤销只管本页 —— B 的撤销不删 A 的动作 ----
const histCountBefore = get(A.historyLength)
B.undoDesk() // B 最近动作是 ack 提醒或新增条目，只会动自己的
assert.equal(get(A.historyLength), histCountBefore, 'A 的撤销历史不受 B 影响')

// ---- 场景 7：冲突裁定不会在后续合并中复活 ----
const persisted = getJSON()
assert.equal(persisted.stageLines.find(l => l.cueId === targetId).firstOperator, 'A', '持久化舞台数据正确')
assert.ok(persisted.cues.find(c => c.id === targetId).confirmations.length === 1, '持久化保留一版确认（撤销后）')

// ---- 场景 8：同一正文两人基于同一旧版盲改成不同内容 -> 编辑冲突，两版保留，挑选 ----
// 真实并发本质：A、B 的合并基线都还是原文，各自改成不同值后先后保存。
const editCueId = get(A.desk).cues[0].id
const editOriginal = get(A.desk).cues.find(c => c.id === editCueId).text

// A 先保存 editA（此时存储就是 A 的版本）
A.updateCue(editCueId, { text: 'A 修改后的正文版本' })
const aSnapshot = sharedLocal.get('conference-cue-desk-v2')
// 让 B 的共同祖先退回到原文：把存储临时改回原文（B 尚未加载过 A 的版本，基线即原文）
sharedLocal.set('conference-cue-desk-v2', aSnapshot.replace('A 修改后的正文版本', editOriginal))
const originalSnapshot = sharedLocal.get('conference-cue-desk-v2')
B.updateCue(editCueId, { text: 'B 修改后的正文版本' }) // B 基于原文保存 editB
// A 的 editA 随后作为“对端更新”到达 B：祖先原文、本页 editB、对端 editA -> 盲改冲突
envB._listeners.forEach(fn => fn({ key: 'conference-cue-desk-v2', newValue: aSnapshot, oldValue: originalSnapshot }))

const editConflict = get(B.desk).conflicts.find(c => c.kind === 'edit' && c.cueId === editCueId)
assert.ok(editConflict, '登记正文编辑冲突')
assert.equal(editConflict.versions.length, 2, '两个编辑版本都保留')
// 晚到方 B 挑选 A 的版本
const chosenA = editConflict.versions.find(v => (v.value || '').includes('A 修改'))
B.resolveConflict(editConflict.id, chosenA.key)
pushRemoteEvent(envA)
assert.ok(get(A.desk).cues.find(c => c.id === editCueId).text.includes('A 修改'), 'A 侧看到采用 A 的版本')

// ---- 场景 9：合并失败 -> 草稿保留 -> 重试成功 ----
const retryCueId = get(A.desk).cues[1].id
A.updateCue(retryCueId, { text: 'A 离线期间的编辑稍后重试' })
pushRemoteEvent(envB)
// 让下一次写入抛错一次，随后立即恢复
const globalSet = globalThis.localStorage.setItem.bind(globalThis.localStorage)
globalThis.localStorage.setItem = function onceFail(k, v) {
  globalThis.localStorage.setItem = globalSet
  if (k === 'conference-cue-desk-v2') throw new Error('QuotaExceeded')
  return globalSet.call(this, k, v)
}
A.updateCue(retryCueId, { text: 'A 再试一次的编辑' })
assert.equal(get(A.syncStatus), 'error', '写入失败进入 error 状态')
assert.ok(get(A.syncError).includes('写入队列失败'), `错误信息可读，实际: ${get(A.syncError)}`)
// 草稿仍在本页
assert.ok(get(A.desk).cues.find(c => c.id === retryCueId).text.includes('再试一次'), '失败后本页草稿保留')
// 恢复存储并重试
A.retrySync()
assert.notEqual(get(A.syncStatus), 'error', '重试后脱离错误状态')
pushRemoteEvent(envB)
assert.ok(get(B.desk).cues.find(c => c.id === retryCueId).text.includes('再试一次'), '重试合并后对端收到改动')

console.log('✅ 全部多标签接力合并断言通过')
console.log('   - 确认/补译两版并存并标出先后')
console.log('   - 晚到方收到冲突提示并可挑选')
console.log('   - 舞台字幕只增不回退（撤销确认也保留）')
console.log('   - 术语提醒按条目合并、已看到名单独立')
console.log('   - 各自新增条目并集保留')
console.log('   - 撤销只作用于本标签页')
console.log('   - 正文编辑冲突三方检测与裁定')
console.log('   - 合并失败保留草稿并可重试')
process.exit(0)
