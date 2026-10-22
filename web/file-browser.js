import { isShare, shareBase, shareFetch as fetch, shareStorage as localStorage } from './share-context.js';
import './file-browser.css';
import './theme.css';
import './hosts.css';
import { applyDocumentTheme, isTheme } from './theme.js';
import { brandMark } from './brand-mark.js';
import { labelBadge } from './hosts.js';
import { baseName, childPath, crumbs, isAbsolutePath, isRoot, isWithin as within, normalizePath, parentPath, rootOf, samePath, segments } from './file-path.js';

// Runs in a same-origin embedded page; cookies and all APIs belong to the terminal server.
const $ = selector => document.querySelector(selector);
const query = new URLSearchParams(location.search);
// A remote session's files are that remote's: every request goes through this
// server's /remote/<id>/ forwarder (src/remotes.ts), so the page stays same-origin.
const host = /^[a-z0-9]{1,16}$/.test(query.get('host') || '') ? query.get('host') : '';
const hostBase = (isShare ? `${shareBase}app` : '') + (host ? `/remote/${host}` : '');
let shareRoot = '', previewPrefix = '';
const readActions = new Set(['进入', '预览', '源码', '浏览器打开', '下载', '详情', '复制路径', '更多']);
const apiBase = `${hostBase}/api/files/`;
let theme = query.get('theme');
if (!isTheme(theme)) {
  try { theme = localStorage.getItem(`tw.theme.${navigator.maxTouchPoints > 0 ? 'touch' : 'desktop'}`); } catch { /* default dark */ }
}
applyDocumentTheme(isTheme(theme) ? theme : 'dark');
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type === 'terminal-theme' && isTheme(event.data.theme)) applyDocumentTheme(event.data.theme);
});
const session = query.get('session') || '';
// Which system the files' server runs, as it says itself (GET /api/host-info):
// a Windows server has no Unix permission bits, so the 权限 action is left out
// there and details show no owner / group. Unknown until it has answered.
let windowsHost = false;
let sessionPath = '/';
let current = '/';
let active = null;
let selecting = false;
let showHidden = false;
let sortKey = 'name';
let descending = false;
let busy = false;
let navigationGeneration = 0;
const cache = new Map();
const expanded = new Set();
const selected = new Set();
const history = [];
let previewItem = null, previewText = '', previewVersion = '', originalText = '', markdownView = false;
let toastTimer;
function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
// Path helpers live in file-path.js: the server may be Unix ("/a/b") or Windows ("C:\a\b").
const parent = p => isShare && shareRoot && samePath(p, shareRoot) ? shareRoot : parentPath(p);
const isWithin = within;
function compactPaths(inputs) { return [...new Set(inputs)].filter(p => !inputs.some(other => other !== p && isWithin(p, other))); }
function bytes(size) { if (size < 1024) return `${size} B`; if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`; if (size < 1073741824) return `${(size / 1048576).toFixed(1)} MB`; return `${(size / 1073741824).toFixed(2)} GB`; }
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '不可用'; }
function toast(text) {
  const node = $('#toast');
  // A modal dialog is in the browser top layer, so put its status message there too.
  const modal = document.querySelector('dialog[open]'); (modal || document.body).append(node);
  node.textContent = text; node.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => node.style.display = 'none', 3500);
}
async function request(route, data, params = {}) {
  if (isShare) { if (data !== undefined) throw new Error('分享文件管理为只读'); params = { ...params, session }; }
  const url = apiBase + route + (Object.keys(params).length ? '?' + new URLSearchParams(params) : '');
  const response = await fetch(url, data === undefined ? { credentials: 'same-origin', cache: 'no-store' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (response.status === 401) { window.parent.postMessage({ type: 'files-auth-expired' }, location.origin); throw new Error('登录已失效，请重新登录'); }
  let result; try { result = await response.json(); } catch { throw new Error(`请求失败（${response.status}）`); }
  if (!response.ok) throw new Error(result.error || `操作失败（${response.status}）`);
  return result;
}
function click(button, callback) { button.type = 'button'; button.onclick = async event => { event.preventDefault(); if (button.disabled) return; button.disabled = true; try { await callback(); } catch (error) { toast(error.message); } finally { if (button.id !== 'directory-back' && button.id !== 'up') button.disabled = false; else navigation(); } }; return button; }
function button(text, callback, cls = '') { return click(el('button', cls, text), callback); }
function openDialog(dialog) {
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else { dialog.setAttribute('open', ''); dialog.classList.add('dialog-fallback'); }
}
function closeDialog(dialog) { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); }
let taskInProgress = false;
function sheet(title, subtitle = '') {
  $('#sheet .close').disabled = taskInProgress;
  $('#sheet-title').textContent = title; $('#sheet-sub').textContent = subtitle;
  document.body.append($('#toast')); $('#sheet-body').replaceChildren(); openDialog($('#sheet')); return $('#sheet-body');
}
function errorBox() { const node = el('p', 'transfer-error'); node.setAttribute('role', 'alert'); return node; }
function ordered(entries) {
  return [...entries].filter(item => showHidden || !item.name.startsWith('.')).sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    const value = sortKey === 'size' ? a.size - b.size : sortKey === 'modified' ? a.modified.localeCompare(b.modified) : a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    return descending ? -value : value;
  });
}
async function load(p, force = false) { if (!force && cache.has(p)) return cache.get(p); const data = await request('list', undefined, { path: p }); cache.set(p, data); return data; }
async function initialExpand(p, force = false) {
  await load(p, force);
  // Show the destination's contents, with all child directories collapsed.
  expanded.clear();
  expanded.add(p);
}
// 返回目录时恢复展开、选择和两个方向的滚动位置，保留进入前的操作上下文。
function snapshot() { return { current, active, expanded: [...expanded], selected: [...selected], selecting, top: $('#tree').scrollTop, left: $('#tree').scrollLeft }; }
async function navigate(p, record = true) {
  if (isShare && (!shareRoot || !within(p, shareRoot))) return toast('不能访问分享目录之外的路径');
  if (busy || p === current && cache.has(p)) return;
  const before = snapshot(), generation = ++navigationGeneration; busy = true; $('#location-label').textContent = '正在读取目录…';
  try {
    await initialExpand(p);
    if (generation !== navigationGeneration) return;
    if (record && cache.has(before.current)) history.push(before);
    current = p; active = cache.get(p).directory; selected.clear(); selecting = false;
    render(); $('#tree').scrollTop = 0; $('#tree').scrollLeft = 0;
  } finally { busy = false; navigation(); }
}
async function back() {
  if (busy || !history.length) return;
  const previous = history[history.length - 1]; busy = true;
  try {
    await load(previous.current, true);
    const needed = previous.expanded.filter(p => isWithin(p, previous.current));
    for (const p of needed) { try { await load(p); } catch { /* Inaccessible/deleted rows can still be collapsed. */ } }
    history.pop(); current = previous.current; active = previous.active; selecting = previous.selecting;
    expanded.clear(); previous.expanded.forEach(p => expanded.add(p)); selected.clear(); previous.selected.forEach(p => selected.add(p));
    render(); $('#tree').scrollTop = previous.top; $('#tree').scrollLeft = previous.left;
  } finally { busy = false; }
}
async function refresh() {
  const top = $('#tree').scrollTop, left = $('#tree').scrollLeft;
  const paths = [...expanded].filter(p => isWithin(p, current));
  try { await load(current, true); } catch (error) {
    if (!isRoot(current) && !(isShare && samePath(current, shareRoot))) { cache.delete(current); const previous = parent(current); current = previous; active = null; await initialExpand(previous, true); active = cache.get(previous).directory; render(); toast('原目录已不可访问，已返回父目录'); return; }
    throw error;
  }
  for (let i = 0; i < paths.length; i += 4) await Promise.all(paths.slice(i, i + 4).map(p => load(p, true).catch(() => cache.delete(p))));
  const visible = new Map(); cache.forEach(data => { visible.set(data.directory.path, data.directory); data.entries.forEach(item => visible.set(item.path, item)); });
  active = visible.get(active?.path) || cache.get(current).directory;
  for (const p of selected) if (!visible.has(p)) selected.delete(p);
  render(); $('#tree').scrollTop = top; $('#tree').scrollLeft = left;
}
function navigation() {
  const crumbsBox = $('#breadcrumbs'); crumbsBox.replaceChildren();
  // One button per segment — "C:\" › "Users" › … on Windows, "/" › "home" › … on Unix.
  crumbs(current).filter(c => !isShare || within(c.path, shareRoot)).forEach(({ label, path: target }, index) => {
    if (index > 1) crumbsBox.append(el('span', 'path-separator', target.includes('\\') ? '\\' : '/'));
    const here = samePath(target, current);
    const node = button(label, () => navigate(target), `crumb quiet${here ? ' current' : ''}`);
    node.setAttribute('aria-label', `进入 ${target}`); if (here) node.setAttribute('aria-current', 'location'); crumbsBox.append(node);
  });
  $('#directory-back').disabled = !history.length; $('#up').disabled = isRoot(current) || (isShare && samePath(current, shareRoot));
  $('#location-label').textContent = samePath(current, sessionPath) ? '当前会话目录' : '当前浏览目录';
  $('#collapse').textContent = (cache.get(current)?.entries || []).some(item => item.directory && expanded.has(item.path)) ? '收起' : '展开';
}
let suppressClickUntil = 0;
function render() {
  const tree = $('#tree'), top = tree.scrollTop, left = tree.scrollLeft;
  const content = el('div', 'tree-content'); tree.replaceChildren(content); let count = 0;
  const visited = new Set();
  function row(item, depth) {
    if (visited.has(item.path)) return; visited.add(item.path); count++;
    const line = el('div', `row${active?.path === item.path ? ' active' : ''}${selected.has(item.path) ? ' selected' : ''}`);
    line.style.setProperty('--depth', depth); line.setAttribute('role', 'treeitem'); line.setAttribute('aria-level', depth + 1); line.setAttribute('aria-selected', String(selecting ? selected.has(item.path) : active?.path === item.path));
    if (item.directory) line.setAttribute('aria-expanded', String(expanded.has(item.path)));
    if (selecting) { const check = el('input', 'check'); check.type = 'checkbox'; check.checked = selected.has(item.path); check.setAttribute('aria-label', `选择 ${item.name}`); check.onchange = () => { check.checked ? selected.add(item.path) : selected.delete(item.path); render(); }; line.append(check); }
    const arrow = button(item.directory ? expanded.has(item.path) ? '⌄' : '›' : '·', async () => {
      if (expanded.has(item.path)) expanded.delete(item.path);
      else { await load(item.path); expanded.add(item.path); }
      render();
    }, 'arrow quiet'); arrow.disabled = !item.directory; arrow.setAttribute('aria-label', `展开或收起 ${item.name}`);
    const name = button(item.name, () => {
      if (Date.now() < suppressClickUntil) return;
      active = item; if (selecting) selected.has(item.path) ? selected.delete(item.path) : selected.add(item.path); render();
    }, 'name');
    name.append(el('small', '', `${item.directory ? '目录' : bytes(item.size)} · ${date(item.modified).split(' ')[0]}${item.symlink ? ' · 链接' : ''}`));
    line.append(arrow, el('span', `file-icon${item.directory ? ' folder' : ''}`, item.directory ? '▰' : '≡'), name);
    const meta = el('div', 'meta', item.directory ? '目录' : bytes(item.size)); meta.append(el('small', '', date(item.modified))); line.append(meta);
    const more = button('⋯', () => menu(item), 'more quiet'); more.setAttribute('aria-label', `${item.name} 的操作`); line.append(more);
    line.oncontextmenu = event => { event.preventDefault(); menu(item); };
    let timer, x, y;
    const begin = event => {
      if (event.pointerType === 'mouse' || event.target.closest('input,.arrow,.more')) return;
      const point = event.touches?.[0] || event; x = point.clientX; y = point.clientY;
      clearTimeout(timer); timer = setTimeout(() => { suppressClickUntil = Date.now() + 900; menu(item); }, 550);
    };
    const move = event => { const point = event.touches?.[0] || event; if (Math.abs(point.clientX - x) + Math.abs(point.clientY - y) > 10) clearTimeout(timer); };
    const cancel = () => clearTimeout(timer);
    if ('PointerEvent' in window) { line.onpointerdown = begin; line.onpointermove = move; line.onpointerup = line.onpointercancel = cancel; }
    else { line.addEventListener('touchstart', begin, { passive: true }); line.addEventListener('touchmove', move, { passive: true }); line.addEventListener('touchend', cancel); line.addEventListener('touchcancel', cancel); }
    content.append(line);
    if (item.directory && expanded.has(item.path)) {
      const data = cache.get(item.path);
      if (data?.error) content.append(el('div', 'tree-error', data.error));
      if (data?.failures?.length) content.append(el('div', 'tree-error', `${data.failures.length} 项无法读取`));
      ordered(data?.entries || []).forEach(child => row(child, depth + 1));
    }
  }
  if (cache.has(current)) row(cache.get(current).directory, 0);
  $('#count').textContent = `${count} 项`; $('#select').textContent = selecting ? '取消多选' : '多选'; $('#select').classList.toggle('primary', selecting);
  navigation(); if (active) details(active, $('#details')); footer(); tree.scrollTop = top; tree.scrollLeft = left;
}
function details(item, container) {
  container.replaceChildren(el('div', 'detail-icon', item.directory ? '▰' : '≡'), el('strong', 'detail-name', item.name), el('div', 'detail-path', item.path));
  const list = el('dl');
  const symbolic = item.mode.slice(-3).split('').map(n => ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'][Number(n)]).join('');
  const fields = [['类型', item.symlink ? '符号链接' : item.directory ? '目录' : '文件'], ['大小', item.directory ? '使用“统计”计算' : bytes(item.size)], ['修改时间', date(item.modified)], ['创建时间', date(item.created)], ['访问时间', date(item.accessed)],
    ...(windowsHost ? [] : [['权限', `${item.mode} · ${symbolic}`], ['所有者 / 组', `${item.owner} / ${item.group}`]])];
  if (item.linkTarget) fields.push(['链接目标', item.linkTarget]);
  fields.forEach(([key, value]) => { const row = el('div'); row.append(el('dt', '', key), el('dd', '', value)); list.append(row); }); container.append(list);
}
function currentSelection(item) { return item ? [item.path] : compactPaths([...selected]); }
function footer() {
  const box = $('#footer-actions'); box.replaceChildren();
  $('#footer-label').textContent = selecting ? `已选 ${selected.size} 项` : active?.path !== current ? `已选：${active?.name || ''}` : '● 当前目录';
  let actions;
  if (selecting) actions = [['全选', () => { document.querySelectorAll('.row input').forEach(input => { input.checked = true; input.onchange(); }); }], ['压缩', () => menuAction('压缩', null)], ['更多', () => menu(null)]];
  else if (active?.path !== current) actions = active?.directory ? [['进入', () => navigate(active.path)], ['更多', () => menu(active)]] : [...(htmlExtensions.test(active.name) ? [['浏览器打开', () => openSite(active)], ['源码', () => viewSource(active)]] : [['预览', () => preview(active)]]), ['编辑', () => preview(active, true)], ['更多', () => menu(active)]];
  else actions = [['＋ 新建', () => createMenu(current)], ['↑ 上传', () => uploadInto(current)], ['更多', () => menu(active)]];
  actions.filter(([text]) => !isShare || readActions.has(text)).forEach(([text, action]) => box.append(button(text, action, ['进入', '压缩', '↑ 上传'].includes(text) ? 'primary' : '')));
}
function menu(item) {
  if (!item && !selected.size) return toast('请先选择条目');
  if (item) { active = item; render(); }
  const body = sheet(item ? item.name : `已选 ${selected.size} 项`, item ? item.path : '批量操作'); const grid = el('div', 'menu-grid');
  const ops = item ? item.directory ? [['↳', '进入'], ['⌘', '立即打开对应终端目录'], ['↑', '上传'], ['＋', '新建']] : [['◉', '预览'], ['✎', '编辑'], ['↓', '下载']] : [];
  if (item && !item.directory && htmlExtensions.test(item.name)) ops.unshift(['↗', '浏览器打开']);
  if (item) ops.push(['⧉', '复制路径'], ['✎', '重命名'], ['ⓘ', '详情']);
  ops.push(['▣', '复制'], ['↗', '移动'], ['▤', '压缩'], ...(windowsHost ? [] : [['⚿', '权限']]), ['∑', '统计'], ['×', '删除']);
  ops.filter(([,label]) => !isShare || readActions.has(label)).forEach(([icon, label]) => { const node = button(label, () => menuAction(label, item), label === '删除' ? 'danger' : ''); node.prepend(el('span', '', icon)); grid.append(node); }); body.append(grid);
}
function confirmation(title, fields, execute) {
  const body = sheet(title, '确认以下信息后执行');
  fields.forEach(([label, lines]) => { body.append(el('h4', 'archive-heading', label)); const list = el('div', 'archive-summary'); (Array.isArray(lines) ? lines : [lines]).forEach(text => list.append(el('div', '', text))); body.append(list); });
  const error = errorBox(); const actions = el('div', 'archive-buttons');
  actions.append(button('取消', () => closeDialog($('#sheet'))), button('确认执行', async () => { try { await execute(); } catch (err) { error.textContent = err.message; } }, 'primary'));
  body.append(error, actions);
}
function inputForm(title, subtitle, fields, submitText, callback) {
  const body = sheet(title, subtitle), form = el('form', 'form'), inputs = {};
  fields.forEach(([key, label, value, type = 'text']) => { const holder = el('label', '', label); const input = el(['exclude', 'text'].includes(key) ? 'textarea' : 'input'); if (!['exclude', 'text'].includes(key)) input.type = type; input.spellcheck = false; input.setAttribute('autocapitalize', 'off'); if (type === 'checkbox') input.checked = !!value; else input.value = value; input.required = type !== 'checkbox'; holder.append(input); inputs[key] = input; form.append(holder); });
  const error = errorBox(), submit = el('button', 'primary', submitText); submit.type = 'submit'; form.append(error, submit);
  form.onsubmit = async event => { event.preventDefault(); submit.disabled = true; try { await callback(inputs); } catch (err) { error.textContent = err.message; } finally { submit.disabled = false; } }; body.append(form);
  return form;
}
function createMenu(directory) {
  if (isShare) return;
  const body = sheet('新建', directory);
  ['directory', 'file'].forEach(kind => body.append(button(`＋ 新建${kind === 'directory' ? '文件夹' : '文件'}`, () => inputForm('新建', directory, [['name', '名称', kind === 'directory' ? '新文件夹' : 'untitled.txt']], '创建', async inputs => {
    await request('create', { directory, name: inputs.name.value, kind }); closeDialog($('#sheet')); await refresh(); toast('已创建');
  }))));
}
async function startJob(route, data, onDone) {
  if (taskInProgress) throw new Error('请等待当前任务完成');
  taskInProgress = true;
  try {
  const started = await request(route, data);
  const body = sheet('正在处理', '操作可能需要一些时间，取消不会撤销已经完成的条目');
  const progress = el('div', 'progress-track'), status = el('p'), detail = el('p', 'task-path'), errors = el('p', 'task-errors');
  const cancel = button('取消任务', async () => { await request('cancel', { id: started.jobId }); cancel.disabled = true; cancel.textContent = '正在取消…'; });
  body.append(progress, status, detail, errors, cancel);
  let result;
  while (true) {
    const job = await request('job', undefined, { id: started.jobId }); result = job;
    status.textContent = `已处理 ${job.count} 个条目`; detail.textContent = job.current;
    if (job.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  progress.remove(); cancel.remove();
  if (result.status === 'failed' || result.status === 'cancelled') { errors.textContent = result.error || '任务已取消'; body.append(button('关闭', () => closeDialog($('#sheet')))); await refresh().catch(() => {}); return null; }
  if (result.failures.length) {
    status.textContent = `完成，${result.failures.length} 项失败`; errors.textContent = result.failures.map(f => `${f.path}：${f.error}`).join('\n'); body.append(button('关闭', () => closeDialog($('#sheet')))); await refresh().catch(() => {}); return null;
  }
  taskInProgress = false; $('#sheet .close').disabled = false;
  if (onDone) await onDone(result.result); else { closeDialog($('#sheet')); await refresh(); toast('操作完成'); }
  return result.result;
  } finally { taskInProgress = false; $('#sheet .close').disabled = false; }
}
async function menuAction(label, item) {
  if (isShare && !readActions.has(label)) return;
  const paths = currentSelection(item); if (!paths.length) return toast('请先选择条目');
  if (label === '进入') { closeDialog($('#sheet')); return navigate(item.path); }
  if (label === '立即打开对应终端目录') {
    // The server only confirms the directory; the terminal page names and opens
    // the session, the same way as its own "新建会话".
    const result = await request('open-terminal', { path: item.path }); closeDialog($('#sheet'));
    window.parent.postMessage({ type: 'files-open-terminal', path: result.path, name: result.name }, location.origin); return;
  }
  if (label === '预览' || label === '编辑') { closeDialog($('#sheet')); return preview(item, label === '编辑'); }
  if (label === '浏览器打开') { closeDialog($('#sheet')); return openSite(item); }
  if (label === '复制路径') return copyText(item.path);
  if (label === '上传') { closeDialog($('#sheet')); return uploadInto(item.path); }
  if (label === '新建') return createMenu(item.path);
  if (label === '详情') { const detailsBody = sheet(item.name, item.path); details(await request('stat', undefined, { path: item.path }), detailsBody); return; }
  if (label === '下载') { const anchor = el('a'); anchor.href = `${apiBase}content?${new URLSearchParams({ path: item.path, download: '1', ...(isShare ? {session} : {}) })}`; anchor.download = item.name; anchor.click(); return; }
  if (label === '重命名') return inputForm('重命名', item.path, [['name', '新名称', item.name]], '重命名', async inputs => { await request('rename', { path: item.path, name: inputs.name.value }); closeDialog($('#sheet')); await refresh(); toast('已重命名'); });
  if (label === '复制' || label === '移动') return transfer(label, paths);
  if (label === '删除') return confirmation('确认永久删除', [['删除以下条目及全部子项', paths], ['删除方式', '永久删除，不能恢复']], async () => { await startJob('remove', { paths }); selected.clear(); selecting = false; await refresh(); });
  if (label === '权限') return permissions(paths, item);
  if (label === '统计') return inputForm('大小统计', '可填写排除路径，每行一个；符号链接不跟随', [['exclude', '排除的绝对路径（没有则填“无”）', '无']], '开始统计', inputs => startJob('scan', { paths, exclude: parseExclude(inputs.exclude.value) }, result => {
    const body = sheet('大小统计', '文件逻辑大小与实际磁盘占用可能不同'); body.append(el('h2', '', bytes(result.bytes)), el('p', '', `${result.files} 个文件 · ${result.directories} 个目录`), el('p', '', `磁盘占用：${bytes(result.diskBytes)}`));
    if (result.excluded.length) body.append(el('p', 'archive-path', `排除：${result.excluded.join('、')}`));
  }));
  if (label === '压缩') return compression(paths);
}
function parseExclude(text) { return text.trim() === '无' || !text.trim() ? [] : text.split('\n').map(p => p.trim()).filter(Boolean); }
function transfer(label, paths) {
  inputForm(`${label}到目录`, '手动填写服务器上的绝对目录路径', [['destination', '目标目录', current]], '下一步：确认操作', async inputs => {
    const destination = inputs.destination.value.trim();
    if (!isAbsolutePath(destination)) throw new Error('请输入绝对目录路径');
    const info = await request('stat', undefined, { path: normalizePath(destination) }); if (!info.directory) throw new Error('目标路径不是目录');
    if (paths.some(p => isWithin(info.path, p))) throw new Error('不能复制或移动到自身及子目录');
    const listing = await request('list', undefined, { path: info.path });
    const nameSet = new Set();
    for (const p of paths) { const name = baseName(p); if (nameSet.has(name) || listing.entries.some(item => item.name === name)) throw new Error(`目标存在同名条目：${name}`); nameSet.add(name); }
    confirmation(`确认${label}`, [['来源', paths], ['目标目录', info.path], ['执行后的路径', paths.map(p => childPath(info.path, baseName(p)))]], async () => startJob(label === '复制' ? 'copy' : 'move', { paths, destination: info.path }));
  });
}
function permissions(paths, item) {
  const form = inputForm('Linux 权限', '递归授权不会跟随符号链接；777 会允许所有用户读写执行', [['mode', '权限数字', item?.mode || '755'], ['recursive', '递归应用到所有子项', false, 'checkbox']], '下一步：确认权限', async inputs => {
    if (!/^[0-7]{3,4}$/.test(inputs.mode.value)) throw new Error('请输入 3 或 4 位八进制权限');
    confirmation('确认修改权限', [['条目', paths], ['权限', inputs.mode.value], ['递归', inputs.recursive.checked ? '全部子孙条目' : '仅所选条目']], () => startJob('chmod', { paths, mode: inputs.mode.value, recursive: inputs.recursive.checked }));
  });
  const grid = el('div', 'permissions-grid'); ['权限', '读', '写', '执行'].forEach(text => grid.append(el('span', '', text)));
  const modeInput = form.querySelector('input');
  const checks = [];
  ['所有者', '所属组', '其他用户'].forEach((label, index) => { grid.append(el('span', '', label)); [4, 2, 1].forEach(bit => { const check = el('input'); check.type = 'checkbox'; check.setAttribute('aria-label', `${label}${bit === 4 ? '读' : bit === 2 ? '写' : '执行'}`); check.checked = !!(Number(modeInput.value.slice(-3)[index]) & bit); check.onchange = () => { modeInput.value = [0, 1, 2].map(i => checks.filter(c => c.index === i && c.element.checked).reduce((sum, c) => sum + c.bit, 0)).join(''); }; checks.push({ index, bit, element: check }); grid.append(check); }); });
  modeInput.oninput = () => checks.forEach(c => c.element.checked = !!(Number(modeInput.value.slice(-3)[c.index]) & c.bit)); form.insertBefore(grid, form.children[1]);
}
async function compression(paths) {
  await startJob('compression-plan', { paths, exclude: [] }, initialPlan => {
    const included = new Set(initialPlan.included);
    let name = `archive${Date.now()}.zip`;
    function configure() {
      const body = sheet('压缩配置', '所选目录包含全部子项，取消勾选可排除文件或目录');
      const label = el('label', 'archive-label', '压缩包名称'); const input = el('input', 'archive-name'); input.value = name; label.append(input);
      body.append(label, el('p', 'archive-path', `产出目录：${initialPlan.parent}`));
      const list = el('div', 'archive-list'), checks = new Map();
      initialPlan.included.forEach(p => {
        const row = el('label', 'archive-entry'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = included.has(p);
        checkbox.onchange = () => {
          const checked = checkbox.checked;
          initialPlan.included.filter(child => isWithin(child, p)).forEach(child => checked ? included.add(child) : included.delete(child));
          if (checked) initialPlan.included.filter(ancestor => isWithin(p, ancestor)).forEach(ancestor => included.add(ancestor));
          checks.forEach((check, entry) => check.checked = included.has(entry));
        };
        checks.set(p, checkbox); row.append(checkbox, el('span', '', p)); list.append(row);
      });
      const error = errorBox();
      const next = button('下一步：确认压缩清单', async () => {
        name = input.value.trim();
        if (!name.toLowerCase().endsWith('.zip') || /[\\/]/.test(name) || !name) { error.textContent = '请输入有效的 .zip 文件名'; return; }
        if (!included.size) { error.textContent = '请至少保留一个条目'; return; }
        const excluded = compactPaths(initialPlan.included.filter(p => !included.has(p)));
        const showReview = plan => {
          const output = childPath(plan.parent, name);
          const body = sheet('确认压缩', '确认包含项、排除项及最终产出路径后执行');
          [['包含的文件和目录', plan.included], ['排除的文件和目录', initialPlan.included.filter(p => !included.has(p))], ['最终产出路径', [output]]].forEach(([title, entries]) => {
            body.append(el('h4', 'archive-heading', `${title}${title === '最终产出路径' ? '' : `（${entries.length} 项）`}`));
            const section = el('div', 'archive-summary'); (entries.length ? entries : ['无']).forEach(p => section.append(el('div', '', p))); body.append(section);
          });
          const error = errorBox(), buttons = el('div', 'archive-buttons');
          buttons.append(button('返回修改', configure), button('取消', () => closeDialog($('#sheet'))), button('确认并压缩', async () => {
            try { await startJob('compress', { planId: plan.planId, name }, async result => { closeDialog($('#sheet')); await refresh(); toast(`压缩完成：${result.path}`); }); }
            catch (err) { error.textContent = err.message; }
          }, 'primary')); body.append(error, buttons);
        };
        if (!excluded.length) showReview(initialPlan);
        else await startJob('compression-plan', { paths, exclude: excluded }, showReview);
      }, 'primary');
      body.append(list, error, next);
    }
    configure();
  });
}

let uploadDirectory = '';
function uploadInto(p) { if (isShare) return; uploadDirectory = p; $('#upload').click(); }
$('#upload').onchange = async event => {
  const files = [...event.target.files]; event.target.value = ''; if (!files.length) return;
  const body = sheet('上传文件', uploadDirectory), status = el('p'), progress = el('progress'), errors = el('p', 'task-errors'); progress.max = 100; progress.style.width = '100%'; body.append(status, progress, errors);
  let xhr, cancelled = false;
  const cancel = button('取消上传', () => { cancelled = true; xhr?.abort(); }); body.append(cancel);
  for (let index = 0; index < files.length && !cancelled; index++) {
    const file = files[index]; status.textContent = `${index + 1}/${files.length} · ${file.name}`;
    try {
      await new Promise((resolve, reject) => {
        xhr = new XMLHttpRequest(); xhr.open('POST', `${apiBase}upload?${new URLSearchParams({ path: uploadDirectory, name: file.name })}`); xhr.withCredentials = true;
        xhr.upload.onprogress = event => { if (event.lengthComputable) progress.value = event.loaded / event.total * 100; };
        xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else { let text; try { text = JSON.parse(xhr.responseText).error; } catch { text = xhr.status === 401 ? '登录已失效' : `上传失败（${xhr.status}）`; } reject(new Error(text)); } };
        xhr.onerror = () => reject(new Error('网络错误')); xhr.onabort = () => reject(new Error('上传已取消')); xhr.send(file);
      });
    } catch (error) { errors.textContent += `${file.name}：${error.message}\n`; }
  }
  cancel.remove(); status.textContent = cancelled ? '上传已取消' : '上传结束'; body.append(button('关闭', () => closeDialog($('#sheet')))); await refresh();
};
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); toast('已复制'); return; } } catch { /* HTTP fallback below. */ }
  const focus = document.activeElement, editor = $('#preview-content textarea');
  const selection = editor ? [editor.selectionStart, editor.selectionEnd, editor.scrollTop, editor.scrollLeft] : null;
  const area = el('textarea', 'copy-buffer'); area.value = text; (document.querySelector('dialog[open]') || document.body).append(area); area.focus(); area.select(); area.setSelectionRange(0, text.length);
  let copied = false; try { copied = document.execCommand('copy'); } catch { /* Manual fallback. */ } area.remove(); focus?.focus({ preventScroll: true });
  if (selection) { editor.setSelectionRange(selection[0], selection[1]); editor.scrollTop = selection[2]; editor.scrollLeft = selection[3]; }
  if (copied) return toast('已复制');
  inputForm('手动复制', '浏览器未允许自动复制，请长按文本复制', [['text', '内容', text]], '关闭', () => closeDialog($('#sheet')));
}
const imageExtensions = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const videoExtensions = /\.(mp4|webm|mov)$/i;
const audioExtensions = /\.(mp3|ogg|wav)$/i;
const htmlExtensions = /\.html?$/i;
const markdownExtensions = /\.(md|markdown)$/i;
// 后端 /site/<绝对路径> 把文件当静态网站提供，页面里的相对路径资源按所在目录解析。
// Windows 路径以 "/C:/Users/…" 的形式放进 URL：相对路径在浏览器里按 "/" 解析，服务端再还原。
function siteUrl(p) {
  if (isShare) return previewPrefix + segments(normalizePath(p)).slice(segments(shareRoot).length).map(encodeURIComponent).join('/');
  const path = normalizePath(p), parts = segments(path);
  const head = path.startsWith('/') ? '' : `/${rootOf(path).slice(0, 2)}`;
  return `${hostBase}/site${head}/${parts.map(encodeURIComponent).join('/')}`;
}
// 指定窗口尺寸让桌面浏览器开独立窗口而非新标签；移动端浏览器会忽略尺寸并以新标签打开。
// 只读查看源码：与预览相同的行号视图，但隐藏编辑入口。
async function viewSource(item) { await preview(item); if (previewItem === item) $('#edit').hidden = true; }
async function openSite(item) {
  const popup = window.open(isShare ? 'about:blank' : siteUrl(item.path), '_blank', `popup,width=${Math.min(1280, screen.availWidth)},height=${Math.min(900, screen.availHeight)}`);
  if (isShare && popup) { popup.opener = null; try { await requestSessionPath(); popup.location.replace(siteUrl(item.path)); } catch (error) { popup.close(); toast(error.message); } }
}
function editingBaseline() { return originalText.replace(/\r\n?/g, '\n'); }
function unsaved() { return !!$('#preview-content textarea') && $('#preview-content textarea').value !== editingBaseline(); }
async function preview(item, edit = false) {
  if (isShare) edit = false;
  if (unsaved() && !window.confirm('当前文本尚未保存，是否放弃修改？')) return;
  const media = !edit && (imageExtensions.test(item.name) || videoExtensions.test(item.name) || audioExtensions.test(item.name) || /\.pdf$/i.test(item.name));
  const box = $('#preview-content'); box.classList.remove('editing'); box.replaceChildren(); $('#preview-title').textContent = item.name; $('#preview-mode').textContent = '预览'; $('#edit').textContent = '编辑'; $('#edit').hidden = $('#copy-content').hidden = !!media;
  if (isShare) $('#edit').hidden = true;
  $('#open-site').hidden = !htmlExtensions.test(item.name); $('#render-toggle').hidden = true;
  previewItem = item; markdownView = !edit && markdownExtensions.test(item.name);
  if (media) {
    const tag = imageExtensions.test(item.name) ? 'img' : videoExtensions.test(item.name) ? 'video' : audioExtensions.test(item.name) ? 'audio' : 'iframe';
    const node = el(tag, 'media-preview'); node.src = `${apiBase}content?${new URLSearchParams({ path: item.path, ...(isShare ? {session} : {}) })}`;
    if (tag === 'video' || tag === 'audio') { node.controls = true; node.preload = 'metadata'; node.setAttribute('playsinline', ''); node.onerror = () => toast('浏览器不支持此媒体编码，可下载或使用终端处理'); }
    if (tag === 'img') node.alt = item.name;
    if (tag === 'iframe') { node.title = item.name; node.style.width = '100%'; node.style.height = '100%'; }
    box.append(node); $('#editor-status').textContent = '媒体预览'; openDialog($('#preview')); return;
  }
  let result;
  try { result = await request('text', undefined, { path: item.path }); } catch (error) {
    $('#edit').hidden = $('#copy-content').hidden = true; box.append(el('p', 'tree-error', error.message), button('下载文件', () => menuAction('下载', item))); $('#editor-status').textContent = '无法文本预览'; openDialog($('#preview')); return;
  }
  previewText = originalText = result.text; previewVersion = result.version;
  if (edit) startEditing(); else await showPreview(); openDialog($('#preview'));
}
async function showPreview() {
  const toggle = $('#render-toggle'); toggle.hidden = !markdownExtensions.test(previewItem.name); toggle.textContent = markdownView ? '源码' : '渲染';
  if (!markdownView) return showText();
  const { marked } = await import('marked');
  const article = el('article', 'markdown-body'); article.innerHTML = marked.parse(isShare ? previewText.replace(/</g, '&lt;') : previewText);
  if (isShare) article.querySelectorAll('[href],[src]').forEach(node => { for (const attr of ['href','src']) { const value = node.getAttribute(attr); if (value && !/^(https?:|data:image\/|[^:]*$)/i.test(value.trim())) node.removeAttribute(attr); } });
  // 相对路径的图片和链接以 Markdown 文件所在目录为基准，经 /site 加载。
  const base = new URL(siteUrl(previewItem.path), location.origin);
  article.querySelectorAll('img[src]').forEach(img => { img.src = new URL(img.getAttribute('src'), base).href; });
  article.querySelectorAll('a[href]').forEach(link => { if (link.getAttribute('href').startsWith('#')) return; link.href = new URL(link.getAttribute('href'), base).href; link.target = '_blank'; });
  const box = $('#preview-content'); box.classList.remove('editing'); box.replaceChildren(article);
  $('#editor-status').textContent = 'Markdown 渲染 · 只读'; $('#preview-mode').textContent = '预览'; $('#edit').textContent = '编辑';
}
function showText() {
  const box = $('#preview-content'); box.classList.remove('editing'); box.replaceChildren();
  const lines = previewText.split('\n');
  const view = el('div', 'code-view');
  const numbers = el('pre', 'preview-numbers', lines.map((_, index) => index + 1).join('\n')); numbers.setAttribute('aria-hidden', 'true');
  view.append(numbers, el('pre', 'preview-text', previewText || ' ')); box.append(view);
  $('#editor-status').textContent = `${lines.length} 行 · 只读`; $('#preview-mode').textContent = '预览'; $('#edit').textContent = '编辑';
}
function startEditing() {
  if (isShare) return;
  const box = $('#preview-content'); box.classList.add('editing'); $('#render-toggle').hidden = true;
  const wrapper = el('div', 'text-editor'), gutter = el('div', 'editor-gutter'), numbers = el('div', 'editor-numbers'), area = el('textarea', 'editor-input'); gutter.setAttribute('aria-hidden', 'true'); gutter.append(numbers);
  area.value = previewText; area.wrap = 'off'; area.spellcheck = false; area.setAttribute('autocapitalize', 'off'); area.setAttribute('autocomplete', 'off'); area.setAttribute('aria-label', '文本编辑');
  let previousCount = 0;
  const sync = () => numbers.style.transform = `translateY(${-area.scrollTop}px)`;
  const update = () => {
    const count = area.value.split('\n').length;
    if (count !== previousCount) { numbers.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n'); wrapper.style.setProperty('--gutter-width', `${Math.max(3, String(count).length + 1)}ch`); previousCount = count; }
    const before = area.value.slice(0, area.selectionStart); $('#editor-status').textContent = `${count} 行 · Ln ${before.split('\n').length}, Col ${before.length - before.lastIndexOf('\n')}${area.value !== editingBaseline() ? ' · 未保存' : ''}`; sync();
  };
  area.oninput = area.onkeyup = area.onclick = area.onselect = update; area.onscroll = sync; area.oncompositionend = update;
  wrapper.append(gutter, area); box.replaceChildren(wrapper); $('#edit').textContent = '保存'; $('#preview-mode').textContent = '编辑'; update();
  setTimeout(() => area.focus({ preventScroll: true }), 0);
}
click($('#edit'), async () => {
  const area = $('#preview-content textarea'); if (!area) return startEditing();
  const preserveCRLF = originalText.includes('\r\n') && !originalText.replace(/\r\n/g, '').includes('\n');
  const data = preserveCRLF ? area.value.replace(/\n/g, '\r\n') : area.value; $('#edit').disabled = true;
  try { await request('write', { path: previewItem.path, text: data, version: previewVersion }); const result = await request('text', undefined, { path: previewItem.path }); previewText = originalText = result.text; previewVersion = result.version; await showPreview(); toast('已保存'); await refresh(); } finally { $('#edit').disabled = false; }
});
click($('#render-toggle'), () => { markdownView = !markdownView; return showPreview(); });
click($('#open-site'), () => openSite(previewItem));
click($('#copy-content'), () => copyText($('#preview-content textarea')?.value ?? previewText));
function closePreview() {
  if (unsaved() && !window.confirm('当前文本尚未保存，是否放弃修改？')) return;
  $('#preview-content').replaceChildren(); closeDialog($('#preview')); document.body.append($('#toast'));
}
document.querySelectorAll('.close').forEach(node => click(node, () => node.closest('dialog').id === 'preview' ? closePreview() : closeDialog(node.closest('dialog'))));
$('#sheet').addEventListener('cancel', event => { if (taskInProgress) event.preventDefault(); });
$('#preview').addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
window.addEventListener('beforeunload', event => { if (unsaved()) { event.preventDefault(); event.returnValue = ''; } });
click($('#back'), () => { if (unsaved() && !window.confirm('当前文本未保存，是否放弃修改并返回终端？')) return; $('#preview-content').replaceChildren(); closeDialog($('#preview')); window.parent.postMessage({ type: 'files-close' }, location.origin); });
click($('#directory-back'), back); click($('#up'), () => navigate(parent(current))); click($('#go-root'), () => navigate(isShare ? shareRoot : rootOf(current)));
click($('#locate'), async () => { const result = await requestSessionPath(); await navigate(result); });
click($('#copy-path'), () => copyText(current)); click($('#refresh'), refresh);
$('#hidden').checked = false; $('#hidden').onchange = async () => { showHidden = $('#hidden').checked; for (const p of selected) if (!showHidden && segments(p).some(part => part.startsWith('.'))) selected.delete(p); if (!showHidden && active?.name.startsWith('.')) active = cache.get(current).directory; render(); };
if (isShare) { $('#go-root').textContent = '分享根目录'; $('#select').hidden = true; $('.demo-note').textContent = '分享文件管理 · 只读 · 仅可浏览授权目录'; }
click($('#select'), () => { selecting = !selecting; if (!selecting) selected.clear(); render(); });
click($('#collapse'), async () => {
  const children = (cache.get(current)?.entries || []).filter(item => item.directory);
  if (children.some(item => expanded.has(item.path))) { for (const p of [...expanded]) if (p !== current && isWithin(p, current)) expanded.delete(p); }
  else for (const item of ordered(children)) { try { await load(item.path); expanded.add(item.path); } catch (error) { toast(error.message); } }
  render();
});
click($('#sort'), () => { const body = sheet('排序', '每一级目录独立排序，文件夹优先'); const grid = el('div', 'menu-grid'); [['name', '名称'], ['modified', '修改时间'], ['size', '大小']].forEach(([key, text]) => grid.append(button(text, () => { sortKey = key; render(); closeDialog($('#sheet')); }, key === sortKey ? 'primary' : ''))); body.append(grid, button(descending ? '降序 ↓ · 点击切换' : '升序 ↑ · 点击切换', () => { descending = !descending; render(); closeDialog($('#sheet')); })); });
async function requestSessionPath() {
  const response = await fetch(`${hostBase}/api/sessions/cwd?${new URLSearchParams({ session })}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401 ? '登录已失效' : '无法取得当前终端目录，请刷新或返回终端重试');
  const result = await response.json(); sessionPath = result.path; if (isShare) { shareRoot = result.path; previewPrefix = result.previewPrefix; } return sessionPath;
}
$('#tree').append(el('p', 'tree-error', '正在读取当前会话目录…'));
$('#session-label').textContent = query.get('label') || session || '当前会话';
// Which server these files are on, and at which address: a badge and the IP
// beside the session name, and a full line in the details panel.
{
  const where = query.get('hostLabel'), ip = query.get('hostIp');
  if (where || ip) {
    const tag = el('span', 'host-tag');
    // The server's own tag (name and colour), as on the terminal page.
    tag.append(labelBadge(query.get('tagName') || (host ? '远程' : '本地'), query.get('tagColor') || (host ? 'amber' : 'green'), query.get('tagNote') || ''));
    if (ip) tag.append(el('span', `host-ip ${host ? 'remote' : 'local'}`, ip));
    tag.title = [where, ip, query.get('tagNote')].filter(Boolean).join(' · ');
    $('#session-label').after(tag);
    document.body.classList.toggle('remote-files', !!host);
    document.title = `文件管理 · ${tag.title}`;
    $('.demo-note').prepend(`文件位于：${tag.title}`, el('br'));
  }
}
$('#brand-slot').append(brandMark('fb-brand'));
// The badge yields to the session name: shown only while the name fits whole.
function fitBrand() {
  const slot = $('#brand-slot'), label = $('#session-label'), heading = $('.heading');
  slot.hidden = false;
  if (label.scrollWidth > label.clientWidth + 1 || heading.scrollWidth > heading.clientWidth + 1) slot.hidden = true;
}
new ResizeObserver(fitBrand).observe($('header'));
fitBrand();
// The server's system, for what this page offers (see windowsHost). A server
// too old to say is taken as Unix, the only kind there was.
fetch(`${hostBase}/api/host-info`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(info => {
  if (info?.platform !== 'win32') return;
  windowsHost = true;
  if (active) render();
}).catch(() => { /* keep the Unix menu */ });
(async () => { try { const p = await requestSessionPath(); await navigate(p, false); } catch (error) { toast(error.message); $('#tree').append(el('p', 'tree-error', error.message)); } })();
