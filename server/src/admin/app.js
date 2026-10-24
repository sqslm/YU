const $ = id => document.getElementById(id)
const state = { access: '', refresh: '', user: null, kind: 'notes', usersPage: 1, recordsPage: 1, usersTotal: 0, recordsTotal: 0, users: [], items: [], userRequest: 0, recordRequest: 0, selectionRequest: 0 }
let refreshing
let audioUrl
let settingsRevision
const bytes = value => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : value < 1073741824 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1073741824).toFixed(1)} GB`
const stamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
const path = (user = state.user) => `/api/v1/admin/users/${encodeURIComponent(user.id)}`
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el }
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text }

function resetLogin() {
  settingsRevision = undefined; $('smtp-password').value = ''; $('settings-form').reset()
  state.access = ''; state.refresh = ''; state.user = null
  state.userRequest++; state.recordRequest++; state.selectionRequest++
  state.users = []; state.items = []
  $('users').replaceChildren(); $('records').replaceChildren(); $('actor').textContent = ''
  $('selected-email').textContent = ''; $('selected').hidden = true; $('no-selection').hidden = false
  $('workspace').hidden = true; $('login-view').hidden = false; $('logout').hidden = true
  $('detail-body').replaceChildren(); $('detail-dialog').close(); $('confirm-dialog').close()
  if (audioUrl) URL.revokeObjectURL(audioUrl)
  audioUrl = undefined
}

async function api(url, options = {}, retry = true) {
  const headers = { ...options.headers, authorization: `Bearer ${state.access}` }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(url, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
  if (res.status === 401 && retry && state.refresh) {
    refreshing ??= fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: state.refresh }) })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.message); state.access = data.accessToken; state.refresh = data.refreshToken }).finally(() => { refreshing = undefined })
    try { await refreshing } catch (error) { resetLogin(); throw error }
    return api(url, options, false)
  }
  if (!res.ok) { const data = await res.json(); if (res.status === 401) resetLogin(); throw new Error(data.message || '请求失败') }
  return res
}
async function json(url, options) { return (await api(url, options)).json() }
function run(action) { return async event => { event?.preventDefault(); notice(); try { await action(event) } catch (error) { notice(error.message || '网络连接失败，请重试') } } }
async function busy(button, action) { button.disabled = true; try { return await action() } finally { button.disabled = false } }

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').textContent = ''
  await busy(event.submitter, async () => {
    try {
      const response = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      state.access = data.accessToken; state.refresh = data.refreshToken
      if (!data.user.isAdmin) { await api('/api/v1/auth/logout', { method: 'POST' }); resetLogin(); throw new Error('该账号没有管理员权限，请联系服务端管理员。') }
      $('password').value = ''; state.usersPage = 1; state.recordsPage = 1; state.kind = 'notes'
      $('account-view').hidden = false; $('settings-view').hidden = true
      $('user-query').value = ''; $('record-query').value = ''; notice()
      await loadOverview(); await loadUsers()
      $('workspace').hidden = false; $('login-view').hidden = true; $('logout').hidden = false
    } catch (error) { resetLogin(); $('login-error').textContent = error.message || '无法连接服务端' }
  })
})
$('logout').addEventListener('click', run(async () => { await api('/api/v1/auth/logout', { method: 'POST', body: { refreshToken: state.refresh } }); resetLogin() }))

async function loadOverview() {
  const info = await json('/api/v1/admin/overview')
  $('actor').textContent = info.user.email; $('version').textContent = `服务端 ${info.version}`
  $('count-accounts').textContent = info.accounts; $('count-notes').textContent = info.notes
  $('count-history').textContent = info.history; $('count-audio').textContent = bytes(info.audioBytes)
}

async function loadUsers() {
  const request = ++state.userRequest
  $('users-prev').disabled = true; $('users-next').disabled = true
  const data = await json(`/api/v1/admin/users?page=${state.usersPage}&q=${encodeURIComponent($('user-query').value.trim())}`)
  if (request !== state.userRequest) return
  state.users = data.users; state.usersTotal = data.total
  $('users').replaceChildren()
  for (const user of data.users) {
    const button = node('button', undefined, `user-row${user.id === state.user?.id ? ' selected' : ''}`)
    button.setAttribute('aria-pressed', String(user.id === state.user?.id))
    button.append(node('strong', user.email), node('span', user.isAdmin ? '管理员' : '普通用户'))
    button.append(node('span', user.disabled ? '停用' : '启用', `state${user.disabled ? ' off' : ''}`))
    button.addEventListener('click', run(() => selectUser(user.id)))
    $('users').append(button)
  }
  if (!data.users.length) $('users').append(node('p', '没有匹配的账号。', 'empty'))
  $('users-page').textContent = `${data.page} / ${Math.max(1, Math.ceil(data.total / 30))}`
  $('users-prev').disabled = data.page <= 1; $('users-next').disabled = data.page * 30 >= data.total
  if (!state.user && data.users.length) await selectUser(data.users[0].id)
}

async function selectUser(id) {
  const request = ++state.selectionRequest
  state.recordRequest++
  const { user } = await json(`/api/v1/admin/users/${encodeURIComponent(id)}`)
  if (request !== state.selectionRequest) return
  state.user = user; state.recordsPage = 1; $('record-query').value = ''
  renderAccount()
  for (const button of $('users').children) { const selected = button.querySelector('strong')?.textContent === user.email; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)) }
  await loadRecords()
}

function renderAccount() {
  const user = state.user
  $('no-selection').hidden = true; $('selected').hidden = false
  $('selected-email').textContent = user.email
  $('selected-status').textContent = `${user.isAdmin ? '管理员' : '普通用户'}　|　账号状态：${user.disabled ? '停用' : '启用'}`
  $('toggle-user').textContent = user.disabled ? '启用账号' : '停用账号'; $('toggle-user').hidden = user.isAdmin
  $('usage').textContent = `音频用量 ${bytes(user.usedBytes)} / ${bytes(user.quotaBytes)}`
  $('usage-bar').value = Math.min(100, user.usedBytes / user.quotaBytes * 100)
  $('quota-mb').value = user.quotaOverrideBytes / 1048576
}

async function loadRecords() {
  if (!state.user) return
  const request = ++state.recordRequest
  $('records').replaceChildren(); $('record-empty').hidden = true
  $('records-prev').disabled = true; $('records-next').disabled = true
  const kind = state.kind
  const data = await json(`${path()}/${kind}?page=${state.recordsPage}&q=${encodeURIComponent($('record-query').value.trim())}`)
  if (request !== state.recordRequest) return
  state.items = data.items; state.recordsTotal = data.total
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === kind))
  $('record-label').textContent = kind === 'stats' ? '设备 / 统计' : '标题 / 内容'
  $('extra-label').textContent = kind === 'stats' ? '记录数' : '音频'
  $('stats-help').hidden = kind !== 'stats'
  $('record-query').placeholder = kind === 'stats' ? '搜索设备标识' : '搜索标题或内容'
  $('record-query').setAttribute('aria-label', $('record-query').placeholder)
  for (const item of data.items) {
    const row = node('tr'); const cell = node('td')
    const payload = item.payload ?? {}
    const title = kind === 'notes' ? item.title || '未命名随记' : kind === 'stats' ? item.id : payload.text || payload.transcript || payload.original || '听写记录'
    const preview = kind === 'notes' ? item.polished || item.transcript : kind === 'stats' ? `${Object.keys(item.stats.days).length} 天 · ${Object.keys(item.stats.apps).length} 个应用` : payload.polished || payload.result || payload.original || ''
    cell.append(node('strong', String(title)), node('span', String(preview), 'preview')); row.append(cell)
    const timeCell = node('td'); timeCell.append(node('time', stamp(item.updatedAt))); row.append(timeCell)
    row.append(node('td', kind === 'stats' ? String(item.stats.records) : item.audio ? bytes(item.audio.bytes) : '—'))
    const actions = node('td'); const view = node('button', '查看'); view.addEventListener('click', run(() => showDetail(item, kind, state.user))); actions.append(view)
    if (kind !== 'stats') {
      const remove = node('button', '删除', 'danger')
      remove.addEventListener('click', run(async () => {
        const user = state.user
        if (!await confirmAction('删除云端记录', `将删除 ${user.email} 的这条${kind === 'notes' ? '随记及其录音' : '听写历史'}。其他设备同步后也会删除，个人统计不受影响。此操作无法撤销。`)) return
        await busy(remove, async () => {
          await api(`${path(user)}/${kind}/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: kind === 'notes' ? { version: item.version } : { updatedAt: item.updatedAt } })
          if (state.recordsPage > 1 && data.items.length === 1) state.recordsPage--
          await refreshAccount(); await loadOverview(); await loadRecords(); notice('云端记录已删除。')
        })
      })); actions.append(remove)
    }
    row.append(actions); $('records').append(row)
  }
  $('record-empty').hidden = data.items.length !== 0
  $('record-total').textContent = `共 ${data.total} 条`; $('records-page').textContent = `第 ${data.page} 页`
  $('records-prev').disabled = data.page <= 1; $('records-next').disabled = data.page * 30 >= data.total
}

function confirmAction(title, message) {
  $('confirm-title').textContent = title; $('confirm-message').textContent = message
  const dialog = $('confirm-dialog'); dialog.returnValue = ''; dialog.showModal()
  dialog.querySelector('[value=cancel]').focus()
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }))
}
async function refreshAccount() { if (!state.user) return; const { user } = await json(path()); state.user = user; renderAccount() }
function download(blob, name) { const url = URL.createObjectURL(blob); const link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }

async function showDetail(item, kind, user) {
  const body = $('detail-body'); body.replaceChildren(); $('detail-title').textContent = kind === 'notes' ? item.title || '随记详情' : kind === 'stats' ? '个人统计详情' : '听写历史详情'
  if (kind === 'notes') {
    body.append(node('h3', '原始转写'), node('pre', item.transcript || '（空）'), node('h3', '润色文本'), node('pre', item.polished || '（空）'))
    if (item.audio) {
      const listen = node('button', '加载录音'); const save = node('button', '下载录音'); const controls = node('div', undefined, 'actions'); controls.append(listen, save); body.append(node('h3', '随记录音'), controls)
      const url = `${path(user)}/notes/${encodeURIComponent(item.id)}/audio`
      listen.addEventListener('click', run(() => busy(listen, async () => {
        const blob = await (await api(url)).blob()
        if (!$('detail-dialog').open || !controls.isConnected) return
        if (audioUrl) URL.revokeObjectURL(audioUrl)
        audioUrl = URL.createObjectURL(blob); const audio = node('audio'); audio.controls = true; audio.src = audioUrl; body.append(audio); listen.hidden = true
      })))
      save.addEventListener('click', run(() => busy(save, async () => download(await (await api(url)).blob(), `yu-recording.${item.audio.format === 'wav' ? 'wav' : 'ogg'}`))))
    }
  }
  body.append(node('h3', '完整数据'), node('pre', JSON.stringify(kind === 'history' ? item.payload : item, null, 2)))
  $('detail-dialog').showModal()
}
$('close-detail').addEventListener('click', () => $('detail-dialog').close())
$('detail-dialog').addEventListener('close', () => { $('detail-body').replaceChildren(); if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = undefined })
$('user-search').addEventListener('submit', run(async () => { state.usersPage = 1; await loadUsers() }))
$('record-search').addEventListener('submit', run(async () => { state.recordsPage = 1; await loadRecords() }))
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', run(async () => { state.kind = button.dataset.tab; state.recordsPage = 1; $('record-query').value = ''; await loadRecords() }))
for (const [id, key, delta, load] of [['users-prev', 'usersPage', -1, loadUsers], ['users-next', 'usersPage', 1, loadUsers], ['records-prev', 'recordsPage', -1, loadRecords], ['records-next', 'recordsPage', 1, loadRecords]]) {
  $(id).addEventListener('click', run(async () => { state[key] += delta; await load() }))
}
$('refresh').addEventListener('click', run(() => busy($('refresh'), async () => { await loadOverview(); await loadUsers(); await refreshAccount(); await loadRecords() })))
$('toggle-user').addEventListener('click', run(async () => {
  const user = state.user; const disabled = !user.disabled
  if (!await confirmAction(disabled ? '停用账号' : '启用账号', `${user.email}：${disabled ? '停用后立即撤销该账号全部登录会话，暂停云同步。数据将保留。' : '恢复后可重新登录及同步。'}`)) return
  await busy($('toggle-user'), async () => { await json(path(user), { method: 'PUT', body: { disabled } }); await refreshAccount(); await loadUsers() })
}))
$('quota-form').addEventListener('submit', run(event => busy(event.submitter, async () => { await json(path(), { method: 'PUT', body: { quotaMb: Number($('quota-mb').value) } }); await refreshAccount(); notice('音频配额已保存。') })))
$('export').addEventListener('click', run(() => busy($('export'), async () => { const user = state.user; download(await (await api(`${path(user)}/export`)).blob(), 'yu-cloud-export.json'); notice('已导出该账号的随记、听写历史和个人统计。录音文件请在随记详情中单独下载。') })))

function renderSettings(data) {
  settingsRevision = data.revision
  for (const input of document.querySelectorAll('[data-setting]')) {
    const value = data.values[input.dataset.setting]
    if (input.type === 'checkbox') input.checked = value
    else input.value = value
  }
  $('smtp-password').value = ''; $('clear-smtp-password').checked = false
  $('smtp-status').textContent = `SMTP：${data.smtpConfigured ? '已配置主机和发件人' : '未配置'}；密码：${data.smtpPasswordSet ? '已保存' : '未设置'}。保存不代表邮件连接已验证。`
  $('settings-warnings').textContent = data.warnings.join(' ')
  $('deployment-info').textContent = `当前监听 ${data.deployment.host}:${data.deployment.port} · 数据目录 ${data.deployment.dataDir} · ${data.deployment.production ? '生产模式' : '开发模式'}`
}
async function showSection(settings) {
  if (settings) renderSettings(await json('/api/v1/admin/settings'))
  $('account-view').hidden = settings; $('settings-view').hidden = !settings
  $('nav-accounts').classList.toggle('nav-active', !settings); $('nav-settings').classList.toggle('nav-active', settings)
  $('mobile-accounts').setAttribute('aria-pressed', String(!settings)); $('mobile-settings').setAttribute('aria-pressed', String(settings))
  notice()
}
for (const id of ['nav-settings', 'mobile-settings']) $(id).addEventListener('click', run(() => showSection(true)))
for (const id of ['nav-accounts', 'mobile-accounts']) $(id).addEventListener('click', run(() => showSection(false)))
$('reload-settings').addEventListener('click', run(() => busy($('reload-settings'), async () => renderSettings(await json('/api/v1/admin/settings')))))
$('settings-form').addEventListener('submit', run(event => busy(event.submitter, async () => {
  const values = {}
  for (const input of document.querySelectorAll('[data-setting]')) values[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value
  if ($('smtp-password').value && $('clear-smtp-password').checked) throw new Error('请在更换密码和清除密码中选择一项。')
  if ($('clear-smtp-password').checked) values.SMTP_PASSWORD = ''
  else if ($('smtp-password').value) values.SMTP_PASSWORD = $('smtp-password').value
  const result = await json('/api/v1/admin/settings', { method: 'PUT', body: { revision: settingsRevision, values } })
  renderSettings(result); notice('服务端设置已保存并立即生效，重启后继续保留。')
})))
