import './shares.css';
import './theme.css';
import { applyDocumentTheme, isTheme } from './theme.js';
let savedTheme: unknown;
try { savedTheme = localStorage.getItem(`tw.theme.${navigator.maxTouchPoints > 0 ? 'touch' : 'desktop'}`); } catch {}
applyDocumentTheme(isTheme(savedTheme) ? savedTheme : 'dark');
window.addEventListener('message', event => {
  if (event.origin === location.origin && event.source === window.parent && event.data?.type === 'terminal-theme' && isTheme(event.data.theme)) applyDocumentTheme(event.data.theme);
});
window.addEventListener('storage', event => { if (event.key?.startsWith('tw.theme.') && isTheme(event.newValue)) applyDocumentTheme(event.newValue); });

type Session = { fromMain?: boolean; identity?: string; host: string; hostName: string; name: string; displayName: string; root: string; available?: boolean; error?: string };
type Share = { id: string; name: string; sessions: Session[]; expiresAt: number | null; createdAt: number; lastAccessAt?: number; status: string; connections: number };
type Group = { host: string; hostName: string; sessions: Session[]; error?: string };
const app = document.querySelector<HTMLDivElement>('#app')!;
const embedded = window.parent !== window && new URLSearchParams(location.search).get('embedded') === '1';
if (embedded) {
  document.body.classList.add('embedded');
  const requestClose = () => {
    if (document.querySelector('dialog[open]') && !confirm('当前有未关闭的操作或 Token 展示。确认关闭分享管理？')) return;
    window.parent.postMessage({type:'share-manager-close'}, location.origin);
  };
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === window.parent && event.data?.type === 'share-manager-request-close') requestClose();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
      event.preventDefault();
      if (dialogs.length) dialogs[dialogs.length - 1].close(); else requestClose();
    }
  });
  window.parent.postMessage({type:'share-manager-ready'}, location.origin);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); e.textContent = text; e.className = cls; return e; };
let noticeTimer: ReturnType<typeof setTimeout>;
function notice(text: string) { const n = document.querySelector<HTMLElement>('#notice')!; n.textContent = text; n.style.display = 'block'; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => n.style.display = 'none', 5000); }
function button(text: string, fn: () => void | Promise<void>, cls = '', loading = '处理中…') {
  const b = el('button', text, cls); b.type = 'button';
  b.onclick = async () => {
    if (b.disabled) return;
    b.disabled = true; b.setAttribute('aria-busy', 'true'); b.textContent = loading;
    try { await fn(); } catch (e) { notice((e as Error).message); }
    finally { b.disabled = false; b.removeAttribute('aria-busy'); b.textContent = text; }
  };
  return b;
}
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api(url: string, data?: unknown) {
  try {
    const r = await fetch(url, { cache:'no-store', signal:AbortSignal.timeout(45000), ...(data === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)}) });
    if (!r.headers.get('content-type')?.includes('application/json')) throw new ApiError('登录已失效，请刷新页面重新登录', 401);
    const result = await r.json(); if (!r.ok) throw new ApiError(result.error ?? '操作失败', r.status); return result;
  } catch (error) {
    if (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)) throw new ApiError(data === undefined ? '加载超过 45 秒，请检查网络后重试。' : '等待超过 45 秒，操作可能已保存。创建分享可在此重试，不会重复创建；其他操作请先刷新列表确认结果。', 408);
    throw error;
  }
}
function modal(title: string) {
  const d = el('dialog'); const top = el('div', '', 'toolbar dialog-header');
  const back = button(embedded ? '← 返回' : '关闭', () => d.close(), 'quiet');
  top.append(el('h2', title), back); d.append(top); document.body.append(d);
  d.onclose = () => d.remove();
  if (embedded) d.show(); else d.showModal();
  return d;
}
function field(label: string, input: HTMLElement) { const l = el('label', '', 'field'); l.append(el('span', label), input); return l; }
const date = (n: number | null | undefined) => n ? new Date(n).toLocaleString() : '—';
const sessionKey = (s: Session) => `${s.host}/${s.name}`;
async function copy(text: string) { try { await navigator.clipboard.writeText(text); notice('已复制'); } catch { const d = modal('请手动复制'); d.append(el('pre', text, 'token')); } }
function credentials(s: Share, token: string) {
  const d = modal('复制分享信息');
  const address = `${location.origin}/share/${s.id}/`;
  const text = el('textarea', '', 'share-info-text');
  text.rows = 8; text.spellcheck = false;
  text.setAttribute('aria-label', '分享信息（网址和 Token）');
  text.value = `会话分享：${s.name}\n访问网址：${address}\n访问 Token：${token}\n有效期：${s.expiresAt ? date(s.expiresAt) : '永不过期'}`;
  d.append(el('p', '网址和 Token 已放在一起，可长按文本手动复制，或点击全选。', 'muted'), text);
  const actions = el('div', '', 'actions');
  actions.append(button('全选文本', () => { text.focus(); text.select(); text.setSelectionRange(0, text.value.length); }), button('复制分享信息', () => copy(text.value), 'primary'));
  d.append(actions);
}

async function mainPageCatalog(): Promise<Group[] | null> {
  if (!embedded) return null;
  return new Promise(resolve => {
    const requestId = Math.random().toString(36).slice(2);
    const finish = (groups: Group[] | null) => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(groups); };
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'share-manager-catalog' || event.data.requestId !== requestId) return;
      finish(Array.isArray(event.data.groups) ? event.data.groups : null);
    };
    const timer = setTimeout(() => finish(null), 1000);
    window.addEventListener('message', receive);
    window.parent.postMessage({type:'share-manager-catalog-request', requestId}, location.origin);
  });
}
async function editShare(old?: Share, duplicate = false) {
  const d = modal(duplicate ? '复制配置创建分享' : old ? '编辑分享' : '创建分享');
  d.classList.add('share-editor');
  const loading = el('p', '正在读取本机和远程会话…', 'muted'); d.append(loading);
  let groups: Group[];
  const initialGroups = await mainPageCatalog();
  try { groups = initialGroups ?? (await api('/api/shares/catalog')).groups; }
  catch (error) { loading.textContent = (error as Error).message; d.append(button('重新加载', () => { d.close(); return editShare(old, duplicate); })); return; }
  loading.remove();
  if (!d.isConnected) return;
  const name = el('input'); name.maxLength = 80; name.required = true; name.placeholder = '例如：项目联调'; name.value = old ? old.name + (duplicate ? '（副本）' : '') : '';
  const expiry = el('input'); expiry.type = 'datetime-local';
  if (old?.expiresAt && old.expiresAt > Date.now() && !duplicate) { const dt = new Date(old.expiresAt); expiry.value = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  const search = el('input'); search.placeholder = '搜索主机、会话或目录'; search.setAttribute('aria-label', '搜索会话');
  const choices = el('div', '', 'choices');
  const checks: { box: HTMLInputElement; session: Session; row: HTMLElement }[] = [];
  const count = el('p', '', 'muted');
  const updateCount = () => count.textContent = `已选择 ${checks.filter(c => c.box.checked).length} 个会话`;
  const filter = () => { for (const c of checks) c.row.hidden = !`${c.session.hostName} ${c.session.displayName} ${c.session.root}`.toLowerCase().includes(search.value.toLowerCase()); };
  search.oninput = filter;
  const render = (next: Group[], selected: Map<string, Session>, preserve: boolean) => {
    choices.replaceChildren(); checks.length = 0;
    const seen = new Set<string>();
    const add = (session: Session, retained = false) => {
      const id = sessionKey(session); if (seen.has(id)) return; seen.add(id);
      const picked = selected.get(id);
      // Refresh never changes the identity/path of something already selected.
      const value = picked && (preserve || (old && !duplicate)) ? picked : session;
      const prior = old && !duplicate ? old.sessions.find(s => sessionKey(s) === id) : undefined;
      const row = el('label', '', 'choice'); const box = el('input'); box.type = 'checkbox'; box.checked = !!picked;
      const text = el('span', (prior?.displayName ?? value.displayName) + (retained ? '（保留已选，保存时校验）' : ''));
      text.append(el('small', prior?.root ?? value.root)); row.append(box, text); choices.append(row);
      box.onchange = updateCount; checks.push({box, session:value, row});
    };
    for (const group of next) {
      choices.append(el('div', group.hostName, 'group-title'));
      if (group.error) choices.append(el('p', group.error, 'error'));
      for (const session of group.sessions) add(session);
    }
    for (const [id, session] of selected) if (!seen.has(id)) add(session, true);
    if (!checks.length) choices.append(el('p', '主页面暂无可选会话，可点击刷新会话列表获取最新会话。', 'empty'));
    updateCount(); filter();
  };
  render(groups, new Map((old?.sessions ?? []).map(s => [sessionKey(s), s])), false);
  const source = el('span', initialGroups ? '已使用主页面会话，保存时校验' : '已加载最新会话', 'muted');
  const refresh = button('刷新会话列表', async () => {
    const result = await api('/api/shares/catalog');
    if (!d.isConnected) return;
    // Read selection after the request so clicks made during loading are retained.
    const selected = new Map(checks.filter(c => c.box.checked).map(c => [sessionKey(c.session), c.session]));
    render(result.groups, selected, true);
    source.textContent = '列表已刷新，已选会话保持不变';
  }, 'quiet', '正在刷新…');
  const catalogBar = el('div', '', 'catalog-toolbar'); catalogBar.append(source, refresh);
  d.append(field('分享名称', name), field('到期时间（留空表示永不过期）', expiry), field('选择已有会话', search), catalogBar, choices, count,
    el('p', '所示目录将固定为文件管理根目录。访客直接操作原终端，多人输入会互相影响；终端及 Claude Code 仍保留原系统权限。文件管理仅允许浏览、预览和下载。', 'muted'));
  let createPayload = '', createRequestId = '';
  const save = button('确认保存', async () => {
    if (!name.reportValidity()) return;
    const sessions = checks.filter(c => c.box.checked).map(c => ({ host: c.session.host, name: c.session.name, root: c.session.root, identity: c.session.identity, fromMain:c.session.fromMain }));
    if (!sessions.length) { notice('请至少选择一个会话'); return; }
    save.disabled = true;
    try {
      const payload = { action:old && !duplicate ? 'update' : 'create', id:old && !duplicate ? old.id : undefined, name:name.value, sessions, expiresAt:expiry.value ? new Date(expiry.value).getTime() : null };
      const serialized = JSON.stringify(payload);
      if (createPayload !== serialized) {
        createPayload = serialized;
        // Works on LAN HTTP origins where crypto.randomUUID is unavailable.
        createRequestId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15; return (c === 'x' ? n : (n & 3) | 8).toString(16); });
      }
      const result = await api('/api/shares', {...payload, ...(payload.action === 'create' ? {requestId:createRequestId} : {})});
      d.close(); await admin(); if (result.token) credentials(result.share, result.token); else notice('已保存，访客连接将按最新权限重新建立');
    } finally { save.disabled = false; }
  }, 'primary', '正在保存…'); const actions = el('div', '', 'actions editor-footer'); actions.append(button('取消', () => d.close()), save); d.append(actions); name.focus();
}
async function admin() {
  const { shares }: { shares: Share[] } = await api('/api/shares');
  app.className = 'wrap'; app.replaceChildren();
  const top = el('div', '', 'toolbar'); const back = el('a', '返回终端', 'button'); back.href = '/';
  if (!embedded) top.append(el('h1', '分享管理'), back);
  top.append(button('刷新', admin), button('创建分享', () => editShare(), 'primary')); app.append(top);
  app.append(el('p', '从已有的本机和远程会话中授权。终止分享只撤销访问，不会结束原会话或已经运行的任务。', 'muted'));
  if (!shares.length) app.append(el('div', '还没有分享。创建后即可向协作者提供独立访问 Token。', 'card empty'));
  for (const s of shares.reverse()) {
    const card = el('section', '', 'card'); const title = el('div', '', 'toolbar'); title.append(el('h2', s.name), el('span', { active: '生效中', expired: '已过期', revoked: '已终止' }[s.status] ?? s.status, `badge ${s.status !== 'active' ? 'ended' : ''}`)); card.append(title);
    card.append(el('p', `${s.sessions.length} 个会话 · ${s.connections} 个活动连接 · ${s.expiresAt ? '到期 ' + date(s.expiresAt) : '永不过期'}`, 'muted'));
    card.append(el('p', `创建 ${date(s.createdAt)} · 最近登录 ${date(s.lastAccessAt)}`, 'muted'));
    const details = el('details'); details.append(el('summary', '查看授权会话与目录'));
    for (const session of s.sessions) {
      const entry = el('div', '', 'shared-session');
      const heading = el('div', '', 'shared-session-heading');
      heading.append(el('span', session.hostName, 'host-tag'), el('small', '分享时名称', 'snapshot-label'), el('strong', session.displayName || session.name));
      entry.append(heading, el('small', '会话标识 · ' + session.name, 'snapshot-note'), el('code', session.root, 'session-path'));
      details.append(entry);
    }
    card.append(details);
    const actions = el('div', '', 'actions');
    if (s.status !== 'revoked') actions.append(button('复制分享信息', async () => {
      const r = await api('/api/shares', {action:'token', id:s.id}); credentials(r.share, r.token);
    }, '', '正在读取…'), button('编辑', () => editShare(s)), button('重置 Token', async () => {
      if (!confirm('旧 Token 和已登录的访客将立即失效。确认重置？')) return;
      notice('正在重置 Token，旧访问凭据即将失效，请稍候…');
      const r = await api('/api/shares', { action: 'reset', id: s.id });
      credentials(r.share, r.token); notice('Token 已重置，可复制新的访问凭据'); await admin();
    }, '', '正在重置…'), button('终止分享', async () => {
      if (!confirm(`终止「${s.name}」后访客立即断开，原会话和任务继续运行。此操作不能恢复，确认终止？`)) return;
      await api('/api/shares', { action: 'revoke', id: s.id }); await admin(); notice('分享已终止');
    }, 'danger'));
    actions.append(button('复制配置', () => editShare(s, true)));
    if (s.status === 'revoked') actions.append(button('删除记录', async () => {
      if (!confirm(`删除「${s.name}」的分享记录？仅删除已终止的分享记录，不会删除原会话或文件。`)) return;
      await api('/api/shares', {action:'delete', id:s.id}); await admin(); notice('分享记录已删除');
    }, 'danger', '正在删除…'));
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
