<script lang="ts">
  import { onMount } from 'svelte'
  import Button from 'flowbite-svelte/Button.svelte'
  import {
    acknowledgeReminder, addAnnouncement, addSession, addSpeaker, addTerm, canRedo, canUndo, clearDuplicate,
    deleteCue, desk, getDelay, ingestCue, moveCue, publishAnnouncement, redoDesk, sendReminder, setActiveCue,
    setCueStatus, setFontScale, setLiveSimulation, setOnline, speakerName, termTarget, undoDesk, updateCue,
    updateSession, updateSpeaker, updateTerm
  } from '$lib/store'
  import type { Announcement, Cue, Session, TabId, Term } from '$lib/types'

  const liveLines = [
    'Cooling corridors can connect parks, schools, and shaded transit stops.',
    'The program gives every district a shared baseline for heat risk.',
    'Community health workers are collecting temperature and respiratory data together.',
    'This evidence helps us prioritize investments where vulnerability is highest.',
    'We will publish the indicator framework before the next budget cycle.'
  ]
  let tab: TabId = 'live'
  let now = Date.now()
  let manualText = ''
  let manualSpeakerId = ''
  let cueNote = ''
  let followup = ''
  let reminderTermId = ''
  let notice = ''
  let announcementText = ''
  let announcementLevel: Announcement['level'] = 'info'
  let manualInput: HTMLTextAreaElement
  let simulationIndex = 0
  let showHelp = false

  $: currentSession = $desk.sessions.find(item => item.status === 'live') || $desk.sessions[0]
  $: activeCue = $desk.cues.find(item => item.id === $desk.activeCueId) || $desk.cues.at(-1)
  $: pendingCount = $desk.cues.filter(item => item.status === 'pending').length
  $: offlineCount = $desk.cues.filter(item => item.offline).length
  $: lateCount = $desk.cues.filter(item => getDelay(item, now) > 8 && item.status !== 'confirmed').length
  $: duplicateCount = $desk.cues.filter(item => item.duplicateOf).length
  $: activeSpeaker = $desk.speakers.find(item => item.id === activeCue?.speakerId)
  $: activeTerms = $desk.terms.filter(item => item.speakerId === activeCue?.speakerId || activeCue?.tags.includes(item.target))
  $: unreadReminders = $desk.reminders.filter(item => !item.acknowledged)

  onMount(() => {
    if (typeof navigator !== 'undefined') setOnline(navigator.onLine)
    const onlineHandler = () => setOnline(true)
    const offlineHandler = () => setOnline(false)
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)
    window.addEventListener('keydown', handleKeyboard)
    const tick = window.setInterval(() => { now = Date.now() }, 1000)
    const simulate = window.setInterval(() => {
      if ($desk.liveSimulation && $desk.online) {
        ingestCue(liveLines[simulationIndex % liveLines.length])
        simulationIndex++
      }
    }, 16000)
    return () => {
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)
      window.removeEventListener('keydown', handleKeyboard)
      window.clearInterval(tick)
      window.clearInterval(simulate)
    }
  })

  function flash(message: string) {
    notice = message
    window.setTimeout(() => { if (notice === message) notice = '' }, 2800)
  }
  function selectCue(cue: Cue) {
    setActiveCue(cue.id)
    cueNote = cue.followupText
    followup = ''
  }
  function confirmActive() {
    if (!activeCue) return
    setCueStatus(activeCue.id, 'confirmed')
    flash('已确认传译，队列自动前进。')
    moveCue(1)
  }
  function saveFollowup() {
    if (!activeCue || !followup.trim()) return
    updateCue(activeCue.id, { followupText: followup.trim(), status: 'followup' })
    followup = ''
    flash('遗漏内容已补充并标记为待跟进。')
  }
  function submitManual() {
    if (!manualText.trim()) return
    ingestCue(manualText, { manual: true, speakerId: manualSpeakerId || activeCue?.speakerId })
    manualText = ''
    if (!$desk.online) flash('网络中断中，内容已暂存在本机。')
    else flash('手工录入已进入现场队列。')
  }
  function mergeOffline() {
    setOnline(true)
    flash('网络已恢复，离线内容已合并并完成重复检查。')
  }
  function sendTermReminder(termId: string) {
    if (!activeCue) return
    sendReminder(termId, activeCue.id)
    flash(`术语提醒已发送：${termTarget($desk, termId)}`)
  }
  function createAnnouncement() {
    addAnnouncement(announcementText, announcementLevel)
    announcementText = ''
    flash('紧急通知已保存到后台。')
  }
  function formatTime(timestamp: number) {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  }
  function delayClass(seconds: number) {
    if (seconds > 12) return 'bg-red-100 text-red-800 border-red-200'
    if (seconds > 8) return 'bg-amber-100 text-amber-900 border-amber-200'
    return 'bg-emerald-50 text-emerald-800 border-emerald-200'
  }
  function statusLabel(status: Cue['status']) {
    return ({ pending: '待传', confirmed: '已确认', followup: '有补充' })[status]
  }
  function handleKeyboard(event: KeyboardEvent) {
    const target = event.target as HTMLElement
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.shiftKey ? redoDesk() : undoDesk(); return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redoDesk(); return }
    if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); moveCue(1) }
    if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); moveCue(-1) }
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); confirmActive() }
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); manualInput?.focus(); flash('手工录入已获焦，输入后按 Ctrl + Enter 提交。') }
    if (event.key.toLowerCase() === 't' && activeTerms[0]) { event.preventDefault(); sendTermReminder(activeTerms[0].id) }
    if (event.key === '?') { event.preventDefault(); showHelp = true }
    if (event.key === '+' || event.key === '=') setFontScale($desk.fontScale + 5)
    if (event.key === '-') setFontScale($desk.fontScale - 5)
  }
</script>

<svelte:head><title>会议同传提示台 · Live Cue Desk</title></svelte:head>

<a class="fixed left-2 top-2 z-[100] -translate-y-20 rounded-lg bg-white px-4 py-2 font-bold shadow focus:translate-y-0" href="#main">跳到主要内容</a>

<div class="min-h-full bg-paper text-ink" style={`font-size:${$desk.fontScale}%`}>
  <header class="sticky top-0 z-40 border-b border-slate-800 bg-ink text-white shadow-xl">
    <div class="mx-auto flex max-w-[1800px] flex-wrap items-center gap-3 px-4 py-3">
      <div class="mr-3 flex items-center gap-3">
        <div class="grid h-10 w-10 place-items-center rounded-xl bg-orange-500 font-black">译</div>
        <div><strong class="block tracking-tight">会议同传提示台</strong><span class="block text-[10px] uppercase tracking-[.16em] text-slate-400">Live Interpreter Cue Desk</span></div>
      </div>
      <nav class="order-3 flex w-full gap-1 overflow-x-auto rounded-xl bg-slate-800/80 p-1 lg:order-none lg:w-auto" aria-label="工作区">
        {#each [['live','现场传译'],['backstage','后台准备'],['terms','术语与通知'],['offline','离线暂存']] as item}
          <button class="focus-ring whitespace-nowrap rounded-lg px-4 py-2 text-xs font-bold transition {tab === item[0] ? 'bg-white text-ink shadow' : 'text-slate-300 hover:bg-slate-700'}" aria-current={tab === item[0] ? 'page' : undefined} on:click={() => tab = item[0] as TabId}>
            {item[1]}
            {#if item[0] === 'live' && pendingCount}<span class="ml-2 rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] text-white">{pendingCount}</span>{/if}
            {#if item[0] === 'offline' && offlineCount}<span class="ml-2 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] text-white">{offlineCount}</span>{/if}
          </button>
        {/each}
      </nav>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <span class="rounded-full border px-3 py-1.5 text-[11px] font-bold {$desk.online ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-amber-500/40 bg-amber-500/15 text-amber-300'}">
          <span class="mr-2 inline-block h-2 w-2 rounded-full {$desk.online ? 'bg-emerald-400' : 'bg-amber-400'}"></span>{$desk.online ? '现场连接正常' : '离线 · 本地暂存'}
        </span>
        <div class="flex items-center rounded-lg bg-slate-800 p-1">
          <button class="focus-ring h-7 w-7 rounded text-lg" title="缩小字号" on:click={() => setFontScale($desk.fontScale - 5)}>−</button>
          <span class="w-12 text-center text-[11px]">{$desk.fontScale}%</span>
          <button class="focus-ring h-7 w-7 rounded text-lg" title="放大字号" on:click={() => setFontScale($desk.fontScale + 5)}>＋</button>
        </div>
        <Button size="sm" color="light" on:click={() => showHelp = true}>快捷键</Button>
      </div>
    </div>
  </header>

  {#if notice}<div role="status" class="fixed right-5 top-20 z-50 rounded-xl border border-teal-200 bg-white px-4 py-3 text-sm font-bold text-teal-800 shadow-2xl">{notice}</div>{/if}

  <main id="main" class="mx-auto max-w-[1800px] p-4 lg:p-6">
    {#if tab === 'live'}
      <div class="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">当前场次 · {$desk.online ? 'LIVE' : 'OFFLINE MODE'}</p>
          <h1 class="mt-1 text-2xl font-black tracking-tight lg:text-4xl">{currentSession?.title}</h1>
          <p class="mt-2 text-sm text-slate-500">{currentSession?.time} · {currentSession?.room} · {$desk.speakers.find(item => item.id === currentSession?.speakerId)?.name}</p>
        </div>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl">{pendingCount}</strong><span class="text-[10px] text-slate-500">待传</span></div>
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl text-amber-700">{lateCount}</strong><span class="text-[10px] text-slate-500">偏高延迟</span></div>
          <div class="rounded-xl border bg-white px-4 py-2"><strong class="block text-xl text-red-700">{duplicateCount}</strong><span class="text-[10px] text-slate-500">疑似重复</span></div>
        </div>
      </div>

      <div class="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,.75fr)]">
        <div class="space-y-4">
          <section class="overflow-hidden rounded-2xl border border-teal-800 bg-[#0d3b36] text-white shadow-lg">
            <div class="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-200">现场可见内容</span><h2 class="mt-1 font-bold">舞台字幕与紧急通知</h2></div>
              <span class="rounded-full bg-teal-600 px-2.5 py-1 text-[10px] font-black text-white">STAGE OUTPUT</span>
            </div>
            <div class="space-y-3 p-4">
              {#each $desk.announcements.filter(item => item.visibleOnStage) as item}
                <div class="rounded-xl border border-orange-300/30 bg-orange-500/15 p-3"><strong class="text-xs text-orange-200">紧急通知</strong><p class="mt-1 text-lg font-bold">{item.text}</p></div>
              {/each}
              {#each $desk.cues.filter(item => item.status === 'confirmed').slice(-2) as cue}
                <div class="rounded-xl bg-white/10 p-3">
                  <div class="mb-1 flex justify-between text-[10px] text-teal-200"><span>{speakerName($desk, cue.speakerId)}</span><span>{formatTime(cue.receivedAt)}</span></div>
                  <p class="text-base leading-relaxed lg:text-lg">{cue.text}</p>
                </div>
              {/each}
              {#if !$desk.cues.some(item => item.status === 'confirmed') && !$desk.announcements.some(item => item.visibleOnStage)}
                <p class="py-5 text-center text-sm text-teal-100/60">确认传译或发布通知后，现场可见内容将在这里出现。</p>
              {/if}
            </div>
          </section>

          <section class="rounded-2xl border bg-white shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-slate-400">后台传译队列</span><h2 class="mt-1 font-bold">待确认与遗漏补充</h2></div>
              <div class="flex items-center gap-3 text-xs text-slate-500"><span>自动接入</span><button type="button" role="switch" aria-label="自动接入现场文字" aria-checked={$desk.liveSimulation} class="focus-ring h-6 w-11 rounded-full p-1 transition {$desk.liveSimulation ? 'bg-teal-600' : 'bg-slate-300'}" on:click={() => setLiveSimulation(!$desk.liveSimulation)}><span class="block h-4 w-4 rounded-full bg-white transition {$desk.liveSimulation ? 'translate-x-5' : ''}"></span></button></div>
            </div>
            <div class="max-h-[600px] space-y-2 overflow-y-auto p-3 scrollbar-thin">
              {#each $desk.cues as cue, index}
                <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                <article role="button" tabindex="0" class="cue-enter cursor-pointer rounded-xl border p-3 transition {cue.id === $desk.activeCueId ? 'border-teal-600 bg-teal-50 shadow-md' : 'border-slate-200 bg-white hover:border-slate-300'}" on:click={() => selectCue(cue)} on:keydown={event => (event.key === 'Enter' || event.key === ' ') && selectCue(cue)}>
                  <div class="flex flex-wrap items-start gap-3">
                    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-900 text-xs font-black text-white">{index + 1}</span>
                    <div class="min-w-0 flex-1">
                      <div class="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-bold">
                        <span class="rounded-md bg-slate-100 px-2 py-1 text-slate-600">{speakerName($desk, cue.speakerId)}</span>
                        <span class="rounded-md border px-2 py-1 {delayClass(getDelay(cue, now))}">{formatTime(cue.receivedAt)} · 延迟 {getDelay(cue, now)}s</span>
                        <span class="rounded-md px-2 py-1 {cue.status === 'confirmed' ? 'bg-emerald-100 text-emerald-800' : cue.status === 'followup' ? 'bg-amber-100 text-amber-900' : 'bg-blue-100 text-blue-800'}">{statusLabel(cue.status)}</span>
                        {#if cue.offline}<span class="rounded-md bg-amber-100 px-2 py-1 text-amber-900">离线暂存</span>{/if}
                        {#if cue.manual}<span class="rounded-md bg-slate-100 px-2 py-1 text-slate-600">手工</span>{/if}
                      </div>
                      <p class="text-sm leading-6 lg:text-base">{cue.text}</p>
                      {#if cue.duplicateOf}
                        <div class="mt-2 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                          <span><strong>疑似重复：</strong>与第 {$desk.cues.findIndex(item => item.id === cue.duplicateOf) + 1} 条高度相似</span>
                          <button class="font-black underline" on:click|stopPropagation={() => clearDuplicate(cue.id)}>确认非重复</button>
                        </div>
                      {/if}
                      {#if cue.followupText}<p class="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900"><strong>补译：</strong>{cue.followupText}</p>{/if}
                      <div class="mt-2 flex flex-wrap gap-1">{#each cue.tags as tag}<span class="rounded-full bg-teal-100 px-2 py-1 text-[10px] font-bold text-teal-800">{tag}</span>{/each}</div>
                    </div>
                  </div>
                </article>
              {/each}
            </div>
          </section>
        </div>

        <div class="space-y-4">
          <section class="rounded-2xl border bg-white p-4 shadow-sm">
            <div class="mb-3 flex items-start justify-between gap-3">
              <div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-700">当前口译位</span><h2 class="mt-1 font-bold">{activeSpeaker?.name || '等待队列'}</h2><p class="text-xs text-slate-500">{activeSpeaker?.language}</p></div>
              <div class="flex gap-1"><button class="focus-ring rounded-lg border px-2 py-1 text-xs" aria-label="上一条" on:click={() => moveCue(-1)}>↑</button><button class="focus-ring rounded-lg border px-2 py-1 text-xs" aria-label="下一条" on:click={() => moveCue(1)}>↓</button></div>
            </div>
            {#if activeCue}
              <div class="rounded-xl bg-slate-50 p-3"><p class="text-sm leading-6">{activeCue.text}</p><p class="mt-2 text-[10px] text-slate-500">快捷键：J / K 移动，C 确认，T 发送首条高优先术语提醒</p></div>
              <div class="mt-3 grid grid-cols-2 gap-2"><Button color="green" on:click={confirmActive}>确认已传 <kbd class="ml-1 text-[10px]">C</kbd></Button><Button color="yellow" on:click={() => tab = 'offline'}>手工补充</Button></div>
              <label for="followup-input" class="mt-4 block text-[10px] font-black uppercase tracking-wider text-slate-500">遗漏补译</label>
              <textarea id="followup-input" class="focus-ring mt-2 w-full rounded-xl border p-3 text-sm" rows="3" bind:value={followup} placeholder="输入遗漏内容或修正术语…"></textarea>
              <Button class="mt-2 w-full" color="light" disabled={!followup.trim()} on:click={saveFollowup}>标记补充完成</Button>
            {/if}
          </section>

          <section class="rounded-2xl border bg-white p-4 shadow-sm">
            <div class="mb-3 flex items-center justify-between"><div><span class="text-[10px] font-black uppercase tracking-[.16em] text-slate-400">术语提醒</span><h2 class="mt-1 font-bold">当前发言人术语</h2></div><span class="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-black text-emerald-800">{activeTerms.length}</span></div>
            <div class="space-y-2">
              {#each activeTerms as term}
                <div class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3">
                  <div><strong class="block text-xs">{term.target}</strong><span class="text-[10px] text-slate-500">{term.source} · {term.note}</span></div>
                  <Button size="xs" color={term.priority === 'high' ? 'yellow' : 'light'} on:click={() => sendTermReminder(term.id)}>提醒</Button>
                </div>
              {/each}
            </div>
          </section>

          <section class="rounded-2xl border bg-white p-4 shadow-sm">
            <div class="mb-3 flex items-center justify-between"><h2 class="font-bold">已发送提醒</h2><span class="text-xs text-slate-500">{unreadReminders.length} 条未确认</span></div>
            <div class="max-h-52 space-y-2 overflow-y-auto">
              {#each $desk.reminders as reminder}
                <div class="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs {reminder.acknowledged ? 'bg-slate-50 text-slate-400' : 'bg-teal-50 text-teal-900'}">
                  <span><strong>{reminder.target}</strong> · {formatTime(reminder.createdAt)}</span>
                  {#if !reminder.acknowledged}<button class="font-bold underline" on:click={() => acknowledgeReminder(reminder.id)}>已看到</button>{/if}
                </div>
              {/each}
              {#if !$desk.reminders.length}<p class="py-4 text-center text-xs text-slate-400">尚未发送术语提醒。</p>{/if}
            </div>
          </section>
        </div>
      </div>
    {/if}

    {#if tab === 'backstage'}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">后台准备内容 · 不会直接显示给现场</p><h1 class="mt-1 text-3xl font-black">议程、发言人与紧急通知</h1></div>
      <div class="grid gap-4 xl:grid-cols-[1.3fr_.7fr]">
        <section class="rounded-2xl border bg-white p-4 shadow-sm">
          <div class="mb-4 flex items-center justify-between"><div><h2 class="font-black">演讲顺序</h2><p class="text-xs text-slate-500">拖动时间、状态或发言人即可更新后台准备内容。</p></div><Button size="sm" on:click={addSession}>新增场次</Button></div>
          <div class="space-y-3">
            {#each $desk.sessions.sort((a,b) => a.order - b.order) as session}
              <article class="grid gap-3 rounded-xl border p-3 md:grid-cols-[80px_1fr_190px_120px]">
                <input class="focus-ring rounded-lg border px-2 py-2 text-sm font-bold" type="time" value={session.time} on:change={event => updateSession(session.id, { time: (event.target as HTMLInputElement).value })} />
                <div><input class="focus-ring w-full rounded-lg border px-3 py-2 font-bold" value={session.title} on:change={event => updateSession(session.id, { title: (event.target as HTMLInputElement).value })} /><span class="mt-1 block text-[10px] text-slate-500">{session.room}</span></div>
                <select class="focus-ring rounded-lg border px-2" value={session.speakerId} on:change={event => updateSession(session.id, { speakerId: (event.target as HTMLSelectElement).value })}>{#each $desk.speakers as speaker}<option value={speaker.id}>{speaker.name}</option>{/each}</select>
                <select class="focus-ring rounded-lg border px-2" value={session.status} on:change={event => updateSession(session.id, { status: (event.target as HTMLSelectElement).value as Session['status'] })}><option value="upcoming">未开始</option><option value="live">进行中</option><option value="done">已结束</option></select>
              </article>
            {/each}
          </div>
        </section>
        <section class="rounded-2xl border bg-white p-4 shadow-sm">
          <div class="mb-4 flex items-center justify-between"><div><h2 class="font-black">发言人</h2><p class="text-xs text-slate-500">语气、语言方向与标识颜色。</p></div><Button size="sm" color="light" on:click={addSpeaker}>新增</Button></div>
          <div class="space-y-3">
            {#each $desk.speakers as speaker}
              <div class="rounded-xl border p-3">
                <div class="flex items-center gap-2"><input class="focus-ring h-8 w-8 rounded-lg border-0 p-1" type="color" value={speaker.color} aria-label="标识颜色" on:change={event => updateSpeaker(speaker.id, { color: (event.target as HTMLInputElement).value })} /><input class="focus-ring min-w-0 flex-1 rounded-lg border px-3 py-2 font-bold" value={speaker.name} on:change={event => updateSpeaker(speaker.id, { name: (event.target as HTMLInputElement).value })} /></div>
                <input class="focus-ring mt-2 w-full rounded-lg border px-3 py-2 text-xs" value={speaker.title} on:change={event => updateSpeaker(speaker.id, { title: (event.target as HTMLInputElement).value })} />
                <input class="focus-ring mt-2 w-full rounded-lg border px-3 py-2 text-xs" value={speaker.language} on:change={event => updateSpeaker(speaker.id, { language: (event.target as HTMLInputElement).value })} />
              </div>
            {/each}
          </div>
        </section>
      </div>
    {/if}

    {#if tab === 'terms'}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-teal-700">后台内容与现场动作</p><h1 class="mt-1 text-3xl font-black">术语表、紧急通知与发布闸门</h1></div>
      <div class="grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
        <section class="overflow-hidden rounded-2xl border bg-white shadow-sm">
          <div class="flex items-center justify-between border-b p-4"><div><h2 class="font-black">术语表</h2><p class="text-xs text-slate-500">“发送提醒”只影响当前口译位，不发布到现场。</p></div><Button size="sm" on:click={addTerm}>新增术语</Button></div>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[760px] text-left text-xs">
              <thead class="bg-slate-50 uppercase tracking-wider text-slate-500"><tr><th class="p-3">原文</th><th class="p-3">指定译法</th><th class="p-3">说明</th><th class="p-3">发言人</th><th class="p-3">优先级</th><th class="p-3"></th></tr></thead>
              <tbody>{#each $desk.terms as term}<tr class="border-t"><td class="p-2"><input class="focus-ring w-full rounded border px-2 py-2" value={term.source} on:change={event => updateTerm(term.id, { source: (event.target as HTMLInputElement).value })} /></td><td class="p-2"><input class="focus-ring w-full rounded border px-2 py-2 font-bold" value={term.target} on:change={event => updateTerm(term.id, { target: (event.target as HTMLInputElement).value })} /></td><td class="p-2"><input class="focus-ring w-full rounded border px-2 py-2" value={term.note} on:change={event => updateTerm(term.id, { note: (event.target as HTMLInputElement).value })} /></td><td class="p-2"><select class="focus-ring rounded border px-2 py-2" value={term.speakerId} on:change={event => updateTerm(term.id, { speakerId: (event.target as HTMLSelectElement).value })}>{#each $desk.speakers as speaker}<option value={speaker.id}>{speaker.name}</option>{/each}</select></td><td class="p-2"><select class="focus-ring rounded border px-2 py-2" value={term.priority} on:change={event => updateTerm(term.id, { priority: (event.target as HTMLSelectElement).value as Term['priority'] })}><option value="normal">常规</option><option value="high">高优先</option></select></td><td class="p-2"><Button size="xs" color="yellow" disabled={!activeCue} on:click={() => sendTermReminder(term.id)}>发送</Button></td></tr>{/each}</tbody>
            </table>
          </div>
        </section>
        <section class="rounded-2xl border bg-white p-4 shadow-sm">
          <div class="mb-4"><h2 class="font-black">紧急通知</h2><p class="text-xs text-slate-500">先保存到后台，再由管理员明确发布到现场。</p></div>
          <select class="focus-ring w-full rounded-xl border p-3 text-sm" bind:value={announcementLevel}><option value="info">信息提示</option><option value="warning">时间提醒</option><option value="urgent">紧急通知</option></select>
          <textarea class="focus-ring mt-3 w-full rounded-xl border p-3 text-sm" rows="3" bind:value={announcementText} placeholder="输入通知内容…"></textarea>
          <Button class="mt-3 w-full" disabled={!announcementText.trim()} on:click={createAnnouncement}>保存到后台</Button>
          <div class="mt-6 space-y-3">
            {#each $desk.announcements as announcement}
              <div class="rounded-xl border p-3 {announcement.visibleOnStage ? 'border-orange-300 bg-orange-50' : 'border-slate-200 bg-slate-50'}">
                <div class="flex items-center justify-between gap-3"><span class="rounded-full bg-white px-2 py-1 text-[10px] font-bold">{announcement.level === 'urgent' ? '紧急' : announcement.level === 'warning' ? '提醒' : '信息'}</span><span class="text-[10px] font-bold {announcement.visibleOnStage ? 'text-orange-700' : 'text-slate-500'}">{announcement.visibleOnStage ? '现场可见' : '仅后台'}</span></div>
                <p class="my-2 text-sm font-bold">{announcement.text}</p>
                <Button size="xs" color={announcement.visibleOnStage ? 'light' : 'yellow'} on:click={() => publishAnnouncement(announcement.id, !announcement.visibleOnStage)}>{announcement.visibleOnStage ? '撤下现场' : '发布到现场'}</Button>
              </div>
            {/each}
          </div>
        </section>
      </div>
    {/if}

    {#if tab === 'offline'}
      <div class="mb-5"><p class="text-[10px] font-black uppercase tracking-[.18em] text-amber-700">断网继续工作 · 恢复后合并</p><h1 class="mt-1 text-3xl font-black">手工录入与离线暂存</h1></div>
      <div class="grid gap-4 xl:grid-cols-[.9fr_1.1fr]">
        <section class="offline-hatch rounded-2xl border border-amber-200 bg-white p-5 shadow-sm">
          <div class="mb-4 flex items-center justify-between gap-3"><div><h2 class="font-black">手工录入现场文字</h2><p class="text-xs text-slate-500">按 Ctrl + Enter 也可以提交。</p></div><span class="rounded-full px-3 py-1 text-xs font-bold {$desk.online ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}">{$desk.online ? '在线写入队列' : '离线保存本机'}</span></div>
          <label class="text-xs font-bold">发言人或场次<select class="focus-ring mt-2 w-full rounded-xl border p-3" bind:value={manualSpeakerId}><option value="">跟随当前发言人</option>{#each $desk.speakers as speaker}<option value={speaker.id}>{speaker.name}</option>{/each}</select></label>
          <label class="mt-4 block text-xs font-bold">现场文字<textarea bind:this={manualInput} class="focus-ring mt-2 w-full rounded-xl border p-4 text-base leading-7" rows="8" bind:value={manualText} placeholder="网络中断时，在这里继续录入…" on:keydown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submitManual() }}></textarea></label>
          <Button class="mt-3 w-full" size="lg" disabled={!manualText.trim()} on:click={submitManual}>加入队列</Button>
          <div class="mt-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900"><strong>暂存规则：</strong>离线条目会带“本地”标记；恢复连接后自动与本机队列合并，并执行相似内容检测。</div>
        </section>
        <section class="rounded-2xl border bg-white p-5 shadow-sm">
          <div class="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 class="font-black">合并与冲突检查</h2><p class="text-xs text-slate-500">当前有 {offlineCount} 条离线条目，{duplicateCount} 条疑似重复。</p></div><Button disabled={$desk.online || !offlineCount} color="green" on:click={mergeOffline}>恢复连接并合并</Button></div>
          <div class="space-y-3">
            {#each $desk.cues.filter(item => item.offline) as cue}
              <article class="rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-4">
                <div class="flex items-center justify-between text-[10px] font-bold text-amber-800"><span>本机暂存 · {formatTime(cue.receivedAt)}</span><span>{speakerName($desk, cue.speakerId)}</span></div>
                <textarea class="focus-ring mt-3 w-full rounded-xl border border-amber-200 bg-white p-3 text-sm" rows="3" value={cue.text} on:change={event => updateCue(cue.id, { text: (event.target as HTMLTextAreaElement).value })}></textarea>
                <div class="mt-2 flex justify-between"><span class="text-[10px] text-amber-800">等待恢复网络后进入现场队列</span><button class="text-xs font-bold text-red-700 underline" on:click={() => deleteCue(cue.id)}>删除暂存</button></div>
              </article>
            {/each}
            {#if !offlineCount}<div class="grid min-h-60 place-items-center rounded-xl bg-slate-50 text-center"><div><div class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div><strong class="mt-3 block text-sm">没有离线暂存条目</strong><p class="mt-1 text-xs text-slate-500">可断开网络后测试手工录入与恢复合并。</p></div></div>{/if}
          </div>
        </section>
      </div>
    {/if}
  </main>

  <footer class="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3 px-4 pb-6 text-[11px] text-slate-500 lg:px-6"><span>本机自动保存 · 最近更新 {new Date($desk.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span><span>后台准备内容与现场可见内容严格分离</span><div class="flex gap-2"><button class="font-bold underline disabled:opacity-40" disabled={!canUndo()} on:click={undoDesk}>撤销</button><button class="font-bold underline disabled:opacity-40" disabled={!canRedo()} on:click={redoDesk}>重做</button></div></footer>
</div>

{#if showHelp}
  <div class="fixed inset-0 z-[80] grid place-items-center bg-slate-950/60 p-4" role="presentation" on:click={() => showHelp = false} on:keydown={event => event.key === 'Escape' && (showHelp = false)}>
    <div class="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="shortcut-title" on:click|stopPropagation on:keydown|stopPropagation>
      <div class="flex items-start justify-between"><div><span class="text-[10px] font-black uppercase tracking-[.16em] text-teal-700">Keyboard First</span><h2 id="shortcut-title" class="mt-1 text-xl font-black">键盘操作</h2></div><button class="rounded-lg px-2 py-1 text-xl" aria-label="关闭" on:click={() => showHelp = false}>×</button></div>
      <div class="mt-4 grid gap-2 sm:grid-cols-2">
        {#each [['J / ↓','下一条队列'],['K / ↑','上一条队列'],['C','确认已传并前进'],['N','聚焦手工录入'],['T','发送当前高优先术语'],['+ / −','调整界面字号'],['Ctrl + Z','撤销'],['Ctrl + Shift + Z','重做']] as shortcut}
          <div class="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"><kbd class="rounded-md border bg-white px-2 py-1 text-xs font-black">{shortcut[0]}</kbd><span class="text-xs text-slate-600">{shortcut[1]}</span></div>
        {/each}
      </div>
    </div>
  </div>
{/if}
