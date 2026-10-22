import './shares.css';

type Session = { identity?: string; host: string; hostName: string; name: string; displayName: string; root: string; available?: boolean; error?: string };
type Share = { id: string; name: string; sessions: Session[]; expiresAt: number | null; createdAt: number; lastAccessAt?: number; status: string; connections: number };
type Group = { host: string; hostName: string; sessions: Session[]; error?: string };
const app = document.querySelector<HTMLDivElement>('#app')!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); e.textContent = text; e.className = cls; return e; };
let noticeTimer: ReturnType<typeof setTimeout>;
function notice(text: string) { const n = document.querySelector<HTMLElement>('#notice')!; n.textContent = text; n.style.display = 'block'; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => n.style.display = 'none', 5000); }
function button(text: string, fn: () => void | Promise<void>, cls = '') { const b = el('button', text, cls); b.type = 'button'; b.onclick = () => { Promise.resolve().then(fn).catch(e => notice(e.message)); }; return b; }
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api(url: string, data?: unknown) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  if (!r.headers.get('content-type')?.includes('application/json')) throw new ApiError('登录已失效，请刷新页面重新登录', 401);
  const result = await r.json(); if (!r.ok) throw new ApiError(result.error ?? '操作失败', r.status); return result;
}
function modal(title: string) { const d = el('dialog'); const top = el('div', '', 'toolbar'); top.append(el('h2', title), button('关闭', () => d.close())); d.append(top); document.body.append(d); d.onclose = () => d.remove(); d.showModal(); return d; }
function field(label: string, input: HTMLElement) { const l = el('label', '', 'field'); l.append(el('span', label), input); return l; }
const date = (n: number | null | undefined) => n ? new Date(n).toLocaleString() : '—';
const sessionKey = (s: Session) => `${s.host}/${s.name}`;
async function copy(text: string) { try { await navigator.clipboard.writeText(text); notice('已复制'); } catch { const d = modal('请手动复制'); d.append(el('pre', text, 'token')); } }
function credentials(s: Share, token: string) {
  const d = modal('分享已保存'); const address = `${location.origin}/share/${s.id}/`;
  d.append(el('p', 'Token 仅在此展示，关闭后无法查看；遗失时可重置。'), el('p', address, 'token'), el('pre', token, 'token'));
  const actions = el('div', '', 'actions');
  actions.append(button('复制地址', () => copy(address)), button('复制 Token', () => copy(token)), button('复制分享说明', () => copy(`会话分享：${s.name}\n访问地址：${address}\n访问 Token：${token}\n有效期：${s.expiresAt ? date(s.expiresAt) : '永不过期'}\n多人操作同一终端；文件管理只读。`), 'primary'));
  d.append(actions);
}
async function editShare(old?: Share, duplicate = false) {
  const d = modal(duplicate ? '复制配置创建分享' : old ? '编辑分享' : '创建分享');
  const loading = el('p', '正在读取本机和远程会话…', 'muted'); d.append(loading);
  const { groups }: { groups: Group[] } = await api('/api/shares/catalog'); loading.remove();
  if (!d.isConnected) return;
  const name = el('input'); name.maxLength = 80; name.required = true; name.placeholder = '例如：项目联调'; name.value = old ? old.name + (duplicate ? '（副本）' : '') : '';
  const expiry = el('input'); expiry.type = 'datetime-local';
  if (old?.expiresAt && old.expiresAt > Date.now() && !duplicate) { const dt = new Date(old.expiresAt); expiry.value = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  const search = el('input'); search.placeholder = '搜索主机、会话或目录'; search.setAttribute('aria-label', '搜索会话');
  const choices = el('div', '', 'choices'); const checks: { box: HTMLInputElement; session: Session; row: HTMLElement }[] = [];
  for (const group of groups) {
    choices.append(el('div', group.hostName, 'group-title'));
    if (group.error) choices.append(el('p', group.error, 'error'));
    const items = [...group.sessions];
    if (old && !duplicate) for (const s of old.sessions) if (s.host === group.host && !items.some(i => sessionKey(i) === sessionKey(s))) items.push(s);
    for (const session of items) {
      const prior = old?.sessions.find(s => sessionKey(s) === sessionKey(session));
      const row = el('label', '', 'choice'); const box = el('input'); box.type = 'checkbox'; box.checked = !!prior;
      const text = el('span', session.displayName); text.append(el('small', prior && !duplicate ? prior.root : session.root)); row.append(box, text); choices.append(row); checks.push({ box, session, row });
    }
  }
  if (old && !duplicate) for (const s of old.sessions) if (!checks.some(c => sessionKey(c.session) === sessionKey(s))) {
    const row = el('label', '', 'choice'); const box = el('input'); box.type = 'checkbox'; box.checked = true; row.append(box, el('span', `${s.hostName} / ${s.displayName}（主机已移除，可取消授权）`)); choices.append(row); checks.push({ box, session: s, row });
  }
  if (!checks.length) choices.append(el('p', '没有可分享的会话，请先由管理员创建会话并确认目录可用。', 'empty'));
  const count = el('p', '', 'muted'); const updateCount = () => count.textContent = `已选择 ${checks.filter(c => c.box.checked).length} 个会话`;
  checks.forEach(c => c.box.onchange = updateCount); updateCount();
  search.oninput = () => { for (const c of checks) c.row.hidden = !`${c.session.hostName} ${c.session.displayName} ${c.session.root}`.toLowerCase().includes(search.value.toLowerCase()); };
  d.append(field('分享名称', name), field('到期时间（留空表示永不过期）', expiry), field('选择已有会话', search), choices, count,
    el('p', '所示目录将固定为文件管理根目录。访客直接操作原终端，多人输入会互相影响；终端及 Claude Code 仍保留原系统权限。文件管理仅允许浏览、预览和下载。', 'muted'));
  const save = button('确认保存', async () => {
    if (!name.reportValidity()) return;
    const sessions = checks.filter(c => c.box.checked).map(c => ({ host: c.session.host, name: c.session.name, root: c.session.root, identity: c.session.identity }));
    if (!sessions.length) { notice('请至少选择一个会话'); return; }
    save.disabled = true;
    try {
      const result = await api('/api/shares', { action: old && !duplicate ? 'update' : 'create', id: old && !duplicate ? old.id : undefined, name: name.value, sessions, expiresAt: expiry.value ? new Date(expiry.value).getTime() : null });
      d.close(); await admin(); if (result.token) credentials(result.share, result.token); else notice('已保存，访客连接将按最新权限重新建立');
    } finally { save.disabled = false; }
  }, 'primary'); const actions = el('div', '', 'actions'); actions.append(save); d.append(actions); name.focus();
}
async function admin() {
  const { shares }: { shares: Share[] } = await api('/api/shares');
  app.className = 'wrap'; app.replaceChildren();
  const top = el('div', '', 'toolbar'); const back = el('a', '返回终端', 'button'); back.href = '/';
  top.append(el('h1', '分享管理'), back, button('刷新', admin), button('创建分享', () => editShare(), 'primary')); app.append(top);
  app.append(el('p', '从已有的本机和远程会话中授权。终止分享只撤销访问，不会结束原会话或已经运行的任务。', 'muted'));
  if (!shares.length) app.append(el('div', '还没有分享。创建后即可向协作者提供独立访问 Token。', 'card empty'));
  for (const s of shares.reverse()) {
    const card = el('section', '', 'card'); const title = el('div', '', 'toolbar'); title.append(el('h2', s.name), el('span', { active: '生效中', expired: '已过期', revoked: '已终止' }[s.status] ?? s.status, `badge ${s.status !== 'active' ? 'ended' : ''}`)); card.append(title);
    card.append(el('p', `${s.sessions.length} 个会话 · ${s.connections} 个活动连接 · ${s.expiresAt ? '到期 ' + date(s.expiresAt) : '永不过期'}`, 'muted'));
    card.append(el('p', `创建 ${date(s.createdAt)} · 最近登录 ${date(s.lastAccessAt)}`, 'muted'));
    const details = el('details'); details.append(el('summary', '查看授权会话与目录'));
    for (const session of s.sessions) details.append(el('p', `${session.hostName} / ${session.displayName}\n${session.root}`, 'path muted')); card.append(details);
    const actions = el('div', '', 'actions'); actions.append(button('复制访问地址', () => copy(`${location.origin}/share/${s.id}/`)), button('复制配置', () => editShare(s, true)));
    if (s.status !== 'revoked') actions.append(button('编辑', () => editShare(s)), button('重置 Token', async () => {
      if (!confirm('旧 Token 和已登录的访客将立即失效。确认重置？')) return;
      const r = await api('/api/shares', { action: 'reset', id: s.id }); await admin(); credentials(r.share, r.token);
    }), button('终止分享', async () => {
      if (!confirm(`终止「${s.name}」后访客立即断开，原会话和任务继续运行。此操作不能恢复，确认终止？`)) return;
      await api('/api/shares', { action: 'revoke', id: s.id }); await admin(); notice('分享已终止');
    }, 'danger'));
    card.append(actions); app.append(card);
  }
}

const base = location.pathname.replace(/\/?$/, '/');
function loginPage(message = '') {
  app.className = 'login card'; app.replaceChildren(el('h1', '访问会话分享'), el('p', '请输入创建者提供的分享 Token。', 'muted'));
  const form = el('form'); const token = el('input'); token.type = 'password'; token.required = true; token.autocomplete = 'current-password'; token.placeholder = '分享 Token';
  const submit = el('button', '进入分享', 'primary'); submit.type = 'submit'; const err = el('p', message, 'error');
  form.append(field('访问 Token', token), submit, err); form.onsubmit = async e => {
    e.preventDefault(); submit.disabled = true; err.textContent = '';
    try { await api(base + 'login', { token: token.value }); location.replace(base); }
    catch (e) { err.textContent = (e as Error).message; } finally { submit.disabled = false; }
  }; app.append(form); token.focus();
}
async function loadGuest() {
  try { await api(base + 'state'); location.replace(base); }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) { loginPage(); return; }
    app.className = 'login card'; app.replaceChildren(el('h1', '分享不可用'), el('p', (e as Error).message), el('p', '请联系分享创建者确认访问权限。', 'muted'));
  }
}
if (document.body.dataset.mode === 'admin') void admin().catch(e => { app.className = 'wrap'; app.append(el('p', e.message, 'error')); });
else void loadGuest();
