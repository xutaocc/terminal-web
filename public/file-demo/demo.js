/* Standalone mock UI: no requests, credentials or server filesystem access. */
const $ = selector => document.querySelector(selector);
let nextId = 1;
const node = (name, size, children, content) => ({ id: nextId++, name, size, children, content, date: '2026-10-11 14:32', mode: children ? '755' : '644' });
const root = node('telwebssh', '18.6 MB', [
  node('.config', '1 KB', [node('settings.json', '1 KB', null, '{\n  "theme": "dark"\n}')]),
  node('.env', '238 B', null, 'HOST=127.0.0.1\nPORT=8090\n# 演示配置，不包含真实令牌'),
  node('.gitignore', '126 B', null, 'node_modules/\npublic/dist/\n.env\n'),
  node('terminal-web', '12.4 MB', [
    node('src', '48 KB', [node('server.ts', '21 KB', null, 'import http from "node:http";\n\n// 文件管理 UI 演示\nconst server = http.createServer((request, response) => {\n  response.end("Hello terminal-web");\n});\n\nserver.listen(8090, "127.0.0.1");\n\n// 长行可以左右滚动：/home/tangsen/telwebssh/terminal-web/src/server.ts — 文件预览采用不换行布局，保留原始文本结构。'), node('auth.ts', '8 KB', null, '// 认证模块示例\nexport const authenticated = true;')]),
    node('public', '2.8 MB', [node('images', '2.1 MB', [node('mountains.svg', '2 KB', null, 'image')]), node('index.html', '1.8 KB', null, '<!doctype html>\n<html lang="zh-CN">\n  <body>terminal-web</body>\n</html>'), node('styles.css', '16 KB', null, 'body {\n  background: #17191d;\n  color: #e4e8ef;\n}')]),
    node('tests', '24 KB', [node('auth.integration.mjs', '6 KB', null, '// 认证集成测试示例')]),
    node('README.md', '8 KB', null, '# terminal-web\n\n支持多设备连接的 Web 终端。\n\n## 开发\n\nnpm install\nnpm run dev\n\n这是纯前端文件管理演示。')]),
  node('uploads', '6.2 MB', [node('notes.txt', '1.2 KB', null, '待办事项\n\n1. 查看手机端文件管理布局\n2. 确认目录树和多选交互\n3. 接入真实服务端接口'), node('release.zip', '6.2 MB')]),
  node('AGENTS.md', '3 KB', null, '# Repository Guidelines\n\n## 项目结构\n源码位于 terminal-web/src/。\n\n## 开发命令\nnpm run dev\n\n## 测试\nnpx tsx --test tests/*.test.ts')]);
const deepExample = node('深层目录与长文件名演示', '12 KB', [
  node('第一层_产品设计与需求文档', '12 KB', [
    node('第二层_手机端文件浏览器交互设计', '12 KB', [
      node('第三层_目录树展开与横向滚动方案', '12 KB', [
        node('第四层_2026年十月版本归档', '12 KB', [
          node('第五层_评审材料与修改记录', '12 KB', [
            node('第六层_最终确认版本', '12 KB', [
              node('第七层_交付文件', '12 KB', [
                node('第八层_完整文件名展示', '12 KB', [
                  node('这是一个非常长的文件名称_手机端左右滑动查看完整名称_最终评审确认版本_2026-10-11.md', '12 KB', null, '# 深层目录演示\n\n这是第八层目录中的文件。\n目录树可横向滑动，完整查看目录和文件名称。')
                ])
              ])
            ])
          ])
        ])
      ])
    ])
  ])
]);
root.children.push(deepExample);
const userHome = node('tangsen', '18.6 MB', [root, node('Documents', '0 B', []), node('Downloads', '0 B', [])]);
const home = node('home', '18.6 MB', [userHome]);
const filesystemRoot = node('/', '18.6 MB', [home, node('tmp', '0 B', []), node('var', '0 B', [node('log', '0 B', [])])]);
const protectedDirectories = new Set([filesystemRoot.id, home.id, userHome.id, root.id]);
let currentDirectory = root;
const navigationHistory = [];
const expanded = new Set([root.id, ...root.children.filter(n => n.children).map(n => n.id)]);
// Open the deep sample initially so horizontal scrolling is easy to inspect.
(function expandExample(directory) {
  if (!directory.children) return;
  expanded.add(directory.id);
  directory.children.forEach(expandExample);
})(deepExample);
const selected = new Set();
let suppressClickUntil = 0;
let active = root, selecting = false, sortKey = 'name', descending = false, target = root, toastTimer, longTimer;
function find(id, current = filesystemRoot) { if (current.id === id) return current; for (const child of current.children || []) { const found = find(id, child); if (found) return found; } }
function parentOf(id, current = filesystemRoot) { if (current.children?.some(n => n.id === id)) return current; for (const child of current.children || []) { const found = parentOf(id, child); if (found) return found; } }
function pathOf(item) { if (item === filesystemRoot) return '/'; const parentPath = pathOf(parentOf(item.id)); return `${parentPath === '/' ? '' : parentPath}/${item.name}`; }
function navigate(directory) {
  if (!directory?.children) return;
  if (directory === currentDirectory) return;
  navigationHistory.push({
    directoryId: currentDirectory.id,
    activeId: active.id,
    expandedIds: [...expanded],
    scrollTop: $('#tree').scrollTop,
    scrollLeft: $('#tree').scrollLeft,
    selecting,
    selectedIds: [...selected]
  });
  currentDirectory = directory; active = directory; selected.clear();
  expanded.add(directory.id);
  directory.children.filter(child => child.children).forEach(child => expanded.add(child.id));
  render(); $('#tree').scrollTop = 0; $('#tree').scrollLeft = 0;
}
function returnToPreviousDirectory() {
  let state;
  while (navigationHistory.length) {
    const previous = navigationHistory.pop();
    if (find(previous.directoryId)?.children) { state = previous; break; }
  }
  if (!state) { navigation(); return; }
  currentDirectory = find(state.directoryId);
  active = find(state.activeId) || currentDirectory;
  expanded.clear(); state.expandedIds.filter(id => find(id)?.children).forEach(id => expanded.add(id));
  selecting = state.selecting;
  selected.clear(); state.selectedIds.filter(id => find(id)).forEach(id => selected.add(id));
  render();
  $('#tree').scrollTop = state.scrollTop;
  $('#tree').scrollLeft = state.scrollLeft;
}
function navigation() {
  const breadcrumbs = $('#breadcrumbs'); breadcrumbs.replaceChildren();
  const ancestors = []; let directory = currentDirectory;
  while (directory) { ancestors.unshift(directory); directory = parentOf(directory.id); }
  ancestors.forEach((entry, index) => {
    if (index > 1) breadcrumbs.append(el('span', 'path-separator', '/'));
    const button = el('button', `crumb quiet${entry === currentDirectory ? ' current' : ''}`, entry.name);
    button.setAttribute('aria-label', `进入 ${pathOf(entry)}`);
    if (entry === currentDirectory) button.setAttribute('aria-current', 'location');
    button.onclick = () => navigate(entry); breadcrumbs.append(button);
  });
  $('#directory-back').disabled = !navigationHistory.some(state => find(state.directoryId)?.children);
  $('#up').disabled = currentDirectory === filesystemRoot;
  $('#location-label').textContent = currentDirectory === root ? '当前会话目录' : '当前浏览目录';
  $('#collapse').textContent = currentDirectory.children.some(child => child.children && expanded.has(child.id)) ? '收起' : '展开';
}
function el(tag, cls, text) { const element = document.createElement(tag); if (cls) element.className = cls; if (text !== undefined) element.textContent = text; return element; }
function toast(message) { $('#toast').textContent = message; $('#toast').style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').style.display = 'none', 2600); }
function bytes(size) { const [value, unit] = size.split(' '); return Number(value) * ({ B: 1, KB: 1024, MB: 1048576 }[unit] || 1); }
function ordered(children) { return [...children].filter(n => $('#hidden').checked || !n.name.startsWith('.')).sort((a, b) => { if (!!a.children !== !!b.children) return a.children ? -1 : 1; const order = sortKey === 'size' ? bytes(a.size) - bytes(b.size) : sortKey === 'date' ? a.date.localeCompare(b.date) : a.name.localeCompare(b.name); return descending ? -order : order; }); }
function render() {
  const tree = $('#tree'); tree.replaceChildren(); const content = el('div', 'tree-content'); tree.append(content); let count = 0;
  function row(item, depth) {
    count++; const line = el('div', `row${active === item ? ' active' : ''}${selected.has(item.id) ? ' selected' : ''}`); line.style.setProperty('--depth', depth); line.setAttribute('role', 'treeitem'); line.setAttribute('aria-level', depth + 1);
    if (item.children) line.setAttribute('aria-expanded', expanded.has(item.id));
    if (selecting) { const check = el('input', 'check'); check.type = 'checkbox'; check.checked = selected.has(item.id); check.setAttribute('aria-label', `选择 ${item.name}`); check.onchange = () => { check.checked ? selected.add(item.id) : selected.delete(item.id); render(); }; line.append(check); }
    const arrow = el('button', 'arrow quiet', item.children ? expanded.has(item.id) ? '⌄' : '›' : '·'); arrow.setAttribute('aria-label', item.children ? `展开或收起 ${item.name}` : item.name); arrow.disabled = !item.children; arrow.onclick = () => { expanded.has(item.id) ? expanded.delete(item.id) : expanded.add(item.id); render(); }; line.append(arrow, el('span', `file-icon${item.children ? ' folder' : ''}`, item.children ? '▰' : item.content === 'image' ? '▧' : '≡'));
    const name = el('button', 'name', item.name); name.append(el('small', '', item.children ? `${item.children.length} 个项目 · ${item.date.slice(5, 10)}` : `${item.size} · ${item.date.slice(5, 10)}`)); name.onclick = () => { if (Date.now() < suppressClickUntil) return; active = item; if (selecting) { selected.has(item.id) ? selected.delete(item.id) : selected.add(item.id); } render(); }; line.append(name);
    const meta = el('div', 'meta', item.size); meta.append(el('small', '', item.date.slice(5, 10))); line.append(meta);
    const more = el('button', 'more quiet', '⋯'); more.setAttribute('aria-label', `${item.name} 的操作`); more.onclick = () => menu(item); line.append(more);
    line.oncontextmenu = event => { event.preventDefault(); menu(item); };
    let startX, startY;
    line.onpointerdown = event => { if (event.pointerType === 'mouse' || event.target.closest('input,.arrow,.more')) return; startX = event.clientX; startY = event.clientY; longTimer = setTimeout(() => { longTimer = null; suppressClickUntil = Date.now() + 800; menu(item); }, 550); };
    line.onpointermove = event => { if (Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY) > 10) clearTimeout(longTimer); };
    line.onpointerup = line.onpointercancel = () => clearTimeout(longTimer);
    content.append(line); if (item.children && expanded.has(item.id)) ordered(item.children).forEach(child => row(child, depth + 1));
  }
  row(currentDirectory, 0); navigation(); $('#count').textContent = `${count} 项`; $('#select').textContent = selecting ? '取消多选' : '多选'; $('#select').classList.toggle('primary', selecting); details(active, $('#details')); footer();
}
function details(item, container) {
  container.replaceChildren(el('div', 'detail-icon', item.children ? '▰' : '≡'), el('strong', 'detail-name', item.name), el('div', 'detail-path', pathOf(item)));
  const list = el('dl'); for (const [key, value] of [['类型', item.children ? '文件夹' : '文件'], ['大小', item.size], ['修改时间', item.date], ['创建时间', '2026-10-09 09:18（模拟）'], ['权限', `${item.mode} · ${item.mode === '755' ? 'rwxr-xr-x' : '模拟权限'}`], ['所有者 / 组', 'tangsen / tangsen']]) { const entry = el('div'); entry.append(el('dt', '', key), el('dd', '', value)); list.append(entry); } container.append(list);
}
function footer() {
  $('#footer-label').textContent = selecting ? `已选 ${selected.size} 项` : currentDirectory === root ? '● 会话目录已定位' : '● 当前目录'; const box = $('#footer-actions'); box.replaceChildren();
  const actions = selecting
    ? [['全选', () => { document.querySelectorAll('.row input').forEach(input => { input.checked = true; input.dispatchEvent(new Event('change')); }); }], ['压缩', () => batch('压缩')], ['更多', () => menu(null)]]
    : active !== currentDirectory
      ? active.children
        ? [['进入', () => navigate(active)], ['更多', () => menu(active)]]
        : [['预览', () => preview(active)], ['编辑', () => action('编辑', active)], ['更多', () => menu(active)]]
      : [['＋ 新建', () => createMenu(currentDirectory)], ['↑ 上传', () => { target = currentDirectory; $('#upload').click(); }]];
  if (!selecting && active !== currentDirectory) $('#footer-label').textContent = `已选：${active.name}`;
  actions.forEach(([name, action]) => { const button = el('button', name.includes('上传') || name === '压缩' ? 'primary' : '', name); button.onclick = action; box.append(button); });
}
function sheet(title, subtitle) { $('#sheet-title').textContent = title; $('#sheet-sub').textContent = subtitle; $('#sheet-body').replaceChildren(); if (!$('#sheet').open) $('#sheet').showModal(); return $('#sheet-body'); }
function menu(item) {
  if (!item && !selected.size) return toast('请先选择文件或文件夹'); if (item) { active = item; render(); }
  const body = sheet(item ? item.name : `已选择 ${selected.size} 项`, item ? pathOf(item) : '批量操作 · 模拟数据'); const grid = el('div', 'menu-grid');
  const operations = item ? [['⧉', '复制路径'], ...(item.children ? [['↳', '进入']] : [['◉', '预览'], ['✎', '编辑']]), ['✎', '重命名'], ['▣', '复制'], ['↗', '移动'], ['▤', '压缩'], ['↓', '下载'], ['⚿', '权限'], ['∑', '统计'], ['ⓘ', '详情'], ['×', '删除']] : [['▣', '复制'], ['↗', '移动'], ['▤', '压缩'], ['⚿', '权限'], ['∑', '统计'], ['×', '删除']];
  if (item?.children) operations.splice(2, 0, ['↑', '上传'], ['＋', '新建']);
  for (const [icon, label] of operations) { const button = el('button', label === '删除' ? 'danger' : '', label); button.prepend(el('span', '', icon)); button.onclick = () => action(label, item); grid.append(button); } body.append(grid);
}
function form(title, subtitle, fields, onSubmit) {
  const body = sheet(title, subtitle); const form = el('form', 'form'); const inputs = {};
  fields.forEach(([key, label, value, type = 'text']) => { const holder = el('label', '', label); const input = el('input'); input.type = type; if (type === 'checkbox') input.checked = !!value; else input.value = value; input.required = type !== 'checkbox'; holder.append(input); form.append(holder); inputs[key] = input; });
  const submit = el('button', 'primary', '确认'); submit.type = 'submit'; form.append(submit); form.onsubmit = event => { event.preventDefault(); if (onSubmit(inputs) !== false) { $('#sheet').close(); render(); } }; body.append(form);
}
function validName(name) { return name.trim() && !name.includes('/') && name !== '.' && name !== '..'; }
function createMenu(directory) { const body = sheet('新建', pathOf(directory)); ['文件夹', '文件'].forEach(kind => { const button = el('button', '', `＋ 新建${kind}`); button.style.marginRight = '8px'; button.onclick = () => form(`新建${kind}`, pathOf(directory), [['name', '名称', kind === '文件夹' ? '新文件夹' : 'untitled.txt']], inputs => { const name = inputs.name.value.trim(); if (!validName(name) || directory.children.some(n => n.name === name)) { toast('名称无效或已存在'); return false; } directory.children.push(node(name, kind === '文件夹' ? '0 B' : '0 B', kind === '文件夹' ? [] : null, kind === '文件' ? '' : undefined)); expanded.add(directory.id); toast('已在模拟目录中创建'); }); body.append(button); }); }
function chosen(item) { const nodes = item ? [item] : [...selected].map(id => find(id)).filter(Boolean); return nodes.filter(n => { let parent = parentOf(n.id); while (parent) { if (nodes.includes(parent)) return false; parent = parentOf(parent.id); } return true; }); }
function batch(label) { if (!selected.size) return toast('请先选择文件或文件夹'); action(label, null); }
function compressionDestination(items) {
  if (items.includes(filesystemRoot)) return null;
  let directory = parentOf(items[0].id);
  while (directory && !items.every(item => {
    let parent = parentOf(item.id);
    while (parent) { if (parent === directory) return true; parent = parentOf(parent.id); }
    return false;
  })) directory = parentOf(directory.id);
  return directory;
}
function compressionDialog(items) {
  const destination = compressionDestination(items);
  if (!destination) return toast('请选择根目录下的文件或文件夹');
  const entries = [];
  const collect = (item, depth) => { entries.push({ item, depth }); item.children?.forEach(child => collect(child, depth + 1)); };
  items.forEach(item => collect(item, 0));
  const included = new Set(entries.map(entry => entry.item.id));
  let archiveName = 'archive.zip';
  function configure() {
    const body = sheet('压缩配置', '选中目录默认包含全部子项，可取消勾选以排除');
    const label = el('label', 'archive-label', '压缩包名称');
    const input = el('input', 'archive-name'); input.value = archiveName; label.append(input);
    body.append(label, el('p', 'archive-path', `产出目录：${pathOf(destination)}`));
    const list = el('div', 'archive-list');
    const checks = new Map();
    entries.forEach(({ item, depth }) => {
      const row = el('label', 'archive-entry'); row.style.paddingLeft = `${8 + depth * 12}px`;
      const check = el('input'); check.type = 'checkbox'; check.checked = included.has(item.id);
      check.onchange = () => {
        const apply = entry => { check.checked ? included.add(entry.id) : included.delete(entry.id); entry.children?.forEach(apply); };
        apply(item);
        if (check.checked) { let parent = parentOf(item.id); while (parent && checks.has(parent.id)) { included.add(parent.id); parent = parentOf(parent.id); } }
        checks.forEach((element, id) => element.checked = included.has(id));
      };
      checks.set(item.id, check); row.append(check, el('span', '', `${item.children ? '▰ ' : '≡ '}${item.name}`)); list.append(row);
    });
    const next = el('button', 'primary', '下一步：确认压缩内容');
    next.onclick = () => {
      archiveName = input.value.trim();
      if (!validName(archiveName) || !archiveName.endsWith('.zip')) return toast('请输入有效的 .zip 文件名');
      if (destination.children.some(item => item.name === archiveName)) return toast('产出目录存在同名文件，请修改名称');
      if (!included.size) return toast('请至少保留一个条目');
      review();
    };
    body.append(list, next);
  }
  function review() {
    const body = sheet('确认压缩', '核对包含项、排除项与产出路径后再执行');
    const outputPath = `${pathOf(destination).replace(/\/$/, '')}/${archiveName}`;
    const sections = [
      ['包含的文件和目录', entries.filter(entry => included.has(entry.item.id))],
      ['排除的文件和目录', entries.filter(entry => !included.has(entry.item.id))]
    ];
    sections.forEach(([title, rows]) => {
      body.append(el('h4', 'archive-heading', `${title}（${rows.length} 项）`));
      const list = el('div', 'archive-summary');
      if (!rows.length) list.append(el('p', 'muted', '无'));
      rows.forEach(({ item }) => list.append(el('div', '', pathOf(item))));
      body.append(list);
    });
    body.append(el('h4', 'archive-heading', '最终产出路径'), el('p', 'archive-path', outputPath), el('p', 'archive-note', '选择父目录与其子项时自动去重。未选择的范围不会打包；此处列出所选范围内主动排除的条目。多个不同分支合并压缩时，产出到它们最近的公共父目录。'));
    const buttons = el('div', 'archive-buttons');
    const back = el('button', '', '返回修改'); back.onclick = configure;
    const cancel = el('button', '', '取消'); cancel.onclick = () => $('#sheet').close();
    const execute = el('button', 'primary', '确认并压缩');
    execute.onclick = () => {
      if (destination.children.some(item => item.name === archiveName)) return toast('同名文件已存在，请返回修改');
      const manifest = ['模拟压缩包，不包含真实 ZIP 内容。', `产出路径：${outputPath}`, '包含：', ...entries.filter(entry => included.has(entry.item.id)).map(entry => pathOf(entry.item)), '排除：', ...entries.filter(entry => !included.has(entry.item.id)).map(entry => pathOf(entry.item))].join('\n');
      destination.children.push(node(archiveName, '0 B', null, manifest));
      $('#sheet').close(); selected.clear(); selecting = false; navigate(destination);
      toast('已确认并生成模拟压缩包');
    };
    buttons.append(back, cancel, execute); body.append(buttons);
  }
  configure();
}
function resolveDirectory(input) {
  if (!input.startsWith('/')) return { error: '请输入绝对目录路径，例如 /home/tangsen/Downloads' };
  const parts = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  let directory = filesystemRoot;
  for (const part of parts) {
    const child = directory.children?.find(entry => entry.name === part);
    if (!child) return { error: `目标目录不存在：/${parts.join('/')}` };
    if (!child.children) return { error: `目标路径不是目录：${pathOf(child)}` };
    directory = child;
  }
  return { directory };
}
function validateTransfer(items, directory) {
  if (items.some(item => !find(item.id))) return '所选条目已不存在，请重新选择';
  if (items.some(item => protectedDirectories.has(item.id))) return '演示基础目录不能复制或移动';
  if (items.some(item => directory === item || pathOf(directory).startsWith(pathOf(item) + '/'))) return '目标不能是所选目录自身或其子目录';
  const names = new Set();
  for (const item of items) {
    if (names.has(item.name) || directory.children.some(child => child.name === item.name)) return `目标存在同名条目：${item.name}，请更换目标目录`;
    names.add(item.name);
  }
  return null;
}
function transferDialog(operation, items) {
  let destinationPath = pathOf(currentDirectory);
  function configure() {
    const body = sheet(`${operation}到目录`, `${items.length} 个条目 · 手动输入绝对目录路径`);
    const form = el('form', 'form');
    const label = el('label', '', '目标目录绝对路径');
    const input = el('input'); input.type = 'text'; input.value = destinationPath;
    input.placeholder = '/home/tangsen/Downloads'; input.required = true;
    input.setAttribute('autocapitalize', 'off'); input.setAttribute('autocomplete', 'off'); input.spellcheck = false;
    label.append(input);
    const error = el('p', 'transfer-error'); error.setAttribute('role', 'alert');
    const next = el('button', 'primary', '下一步：确认操作'); next.type = 'submit';
    form.append(label, el('p', '', '演示中可使用 /home/tangsen/Downloads 或 /tmp。正式版将验证服务器实际目录。'), error, next);
    form.onsubmit = event => {
      event.preventDefault(); destinationPath = input.value.trim();
      const resolved = resolveDirectory(destinationPath);
      const message = resolved.error || validateTransfer(items, resolved.directory);
      if (message) { error.textContent = message; input.setAttribute('aria-invalid', 'true'); return; }
      destinationPath = pathOf(resolved.directory); review();
    };
    input.oninput = () => { error.textContent = ''; input.setAttribute('aria-invalid', 'false'); };
    body.append(form);
  }
  function review() {
    const body = sheet(`确认${operation}`, '确认以下来源及目标后执行');
    body.append(el('h4', 'archive-heading', '来源'));
    const sources = el('div', 'archive-summary'); items.forEach(item => sources.append(el('div', '', pathOf(item)))); body.append(sources);
    body.append(el('h4', 'archive-heading', '目标目录'), el('p', 'archive-path', destinationPath));
    body.append(el('h4', 'archive-heading', '执行后的路径'));
    const outputs = el('div', 'archive-summary'); items.forEach(item => outputs.append(el('div', '', `${destinationPath.replace(/\/$/, '')}/${item.name}`))); body.append(outputs);
    if (operation === '移动') body.append(el('p', 'archive-note', '确认后将从原位置移除这些模拟条目。'));
    const error = el('p', 'transfer-error'); error.setAttribute('role', 'alert'); body.append(error);
    const buttons = el('div', 'archive-buttons');
    const back = el('button', '', '返回修改'); back.onclick = configure;
    const cancel = el('button', '', '取消'); cancel.onclick = () => $('#sheet').close();
    const execute = el('button', 'primary', `确认${operation}`);
    execute.onclick = () => {
      const resolved = resolveDirectory(destinationPath);
      const message = resolved.error || validateTransfer(items, resolved.directory);
      if (message) { error.textContent = message; return; }
      const directory = resolved.directory;
      const clone = item => ({ ...item, id: nextId++, children: item.children?.map(clone) });
      items.forEach(item => {
        if (operation === '移动') {
          const parent = parentOf(item.id); parent.children = parent.children.filter(child => child !== item);
          directory.children.push(item);
        } else directory.children.push(clone(item));
      });
      expanded.add(directory.id); selected.clear(); $('#sheet').close(); render(); toast(`已${operation}到 ${destinationPath}`);
    };
    buttons.append(back, cancel, execute); body.append(buttons);
  }
  configure();
}
async function action(label, item) {
  const items = chosen(item);
  if (label === '进入') { $('#sheet').close(); return navigate(item); }
  if (label === '预览') { $('#sheet').close(); return preview(item); }
  if (label === '编辑') {
    if (item.content === undefined || item.content === 'image') return toast('此文件不支持文本编辑');
    $('#sheet').close(); preview(item); startEditing(); return;
  }
  if (label === '上传') { target = item; $('#sheet').close(); return $('#upload').click(); }
  if (label === '新建') return createMenu(item);
  if (label === '复制路径') { try { await navigator.clipboard.writeText(pathOf(item)); toast('路径已复制'); $('#sheet').close(); } catch { form('复制路径', '请手动选择并复制', [['path', '完整路径', pathOf(item)]], () => {}); } return; }
  if (label === '详情') { const body = sheet(item.name, '详情 · 模拟元数据'); return details(item, body); }
  if (label === '重命名') return form('重命名', pathOf(item), [['name', '新名称', item.name]], inputs => { const name = inputs.name.value.trim(); const parent = parentOf(item.id); if (protectedDirectories.has(item.id) || !validName(name) || parent.children.some(n => n !== item && n.name === name)) { toast('名称无效、重复或为演示根目录'); return false; } item.name = name; toast('已重命名'); });
  if (label === '权限') return form('权限设置', `${items.length} 个条目 · 仅修改模拟权限`, [['mode', 'Linux 权限（例如 755）', item?.mode || '755'], ['recursive', '递归应用到所有子项', false, 'checkbox']], inputs => { if (!/^[0-7]{3,4}$/.test(inputs.mode.value)) { toast('请输入有效八进制权限'); return false; } const apply = n => { n.mode = inputs.mode.value; if (inputs.recursive.checked) n.children?.forEach(apply); }; items.forEach(apply); toast('模拟权限已更新'); });
  if (label === '删除') return form('删除所选条目', `${items.length} 个条目，只影响演示数据`, [['confirm', '输入“删除”以确认', '']], inputs => { if (inputs.confirm.value !== '删除') { toast('请输入“删除”'); return false; } if (items.some(n => protectedDirectories.has(n.id))) { toast('不能删除演示根目录'); return false; } items.forEach(n => { const parent = parentOf(n.id); parent.children = parent.children.filter(child => child !== n); }); selected.clear(); if (!find(currentDirectory.id)) currentDirectory = root; active = currentDirectory; toast('已从模拟目录删除'); });
  if (label === '统计') { let files = 0, dirs = 0, total = 0; const visit = n => { if (n.children) { dirs++; n.children.forEach(visit); } else { files++; total += bytes(n.size); } }; items.forEach(visit); const body = sheet('占用统计', '根据模拟文件大小计算 · 父子条目自动去重'); body.append(el('p', '', `${dirs} 个文件夹 · ${files} 个文件`), el('h2', '', `${(total / 1048576).toFixed(2)} MB`), el('p', 'muted', '可在多选模式下只选需要统计的条目。实际磁盘占用将在接入服务器后提供。')); return; }
  if (label === '复制' || label === '移动') return transferDialog(label, items);
  if (label === '压缩') return compressionDialog(items);
  if (label === '下载') { if (item.children || item.content === undefined || item.content === 'image') return toast('演示：该类型下载将在正式版接入'); const url = URL.createObjectURL(new Blob([item.content], { type: 'text/plain;charset=utf-8' })); const anchor = el('a'); anchor.href = url; anchor.download = item.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('已下载模拟文本'); }
}
let previewItem;
function preview(item) {
  $('#preview-content').classList.remove('editing'); $('#preview-mode').textContent = '预览'; $('#editor-status').textContent = typeof item.content === 'string' && item.content !== 'image' ? `${item.content.split('\n').length} 行 · 只读` : '媒体预览';
  previewItem = item; $('#preview-title').textContent = item.name; const box = $('#preview-content'); box.replaceChildren(); $('#edit').hidden = item.content === 'image' || item.content === undefined; $('#copy-content').hidden = $('#edit').hidden; $('#edit').textContent = '编辑';
  if (item.content === 'image') { const image = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); image.setAttribute('viewBox', '0 0 800 500'); image.setAttribute('aria-label', '模拟山景图片'); image.innerHTML = '<rect width="800" height="500" fill="#24344f"/><circle cx="590" cy="120" r="48" fill="#ecc485"/><path d="M0 420L250 100L510 430L640 250L800 440V500H0Z" fill="#8298ae"/><path d="M0 500L210 275L400 500L560 330L800 500Z" fill="#425e78"/>'; image.style.width = '100%'; box.append(image); }
  else if (item.content === undefined) box.append(el('p', 'muted', '此二进制文件暂不支持预览。正式版将提供下载及媒体播放。'));
  else item.content.split('\n').forEach((text, index) => { const row = el('div', 'code-line'); row.append(el('span', 'line-no', index + 1), el('span', 'code-text', text || ' ')); box.append(row); });
  if (!$('#preview').open) $('#preview').showModal();
}
function startEditing() {
  const box = $('#preview-content');
  box.classList.add('editing');
  const wrapper = el('div', 'text-editor');
  const gutter = el('div', 'editor-gutter');
  gutter.setAttribute('aria-hidden', 'true');
  const numbers = el('div', 'editor-numbers');
  gutter.append(numbers);
  const area = el('textarea', 'editor-input');
  area.value = previewItem.content;
  area.wrap = 'off';
  area.spellcheck = false;
  area.setAttribute('autocapitalize', 'off');
  area.setAttribute('autocomplete', 'off');
  area.setAttribute('aria-label', '文本编辑，左侧实时显示行号');
  let previousCount = 0;
  const syncScroll = () => { numbers.style.transform = `translateY(${-area.scrollTop}px)`; };
  const update = () => {
    const count = area.value.split('\n').length;
    if (count !== previousCount) {
      numbers.textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
      wrapper.style.setProperty('--gutter-width', `${Math.max(3, String(count).length + 1)}ch`);
      previousCount = count;
    }
    const before = area.value.slice(0, area.selectionStart);
    const line = before.split('\n').length;
    const column = before.length - before.lastIndexOf('\n');
    $('#editor-status').textContent = `${count} 行 · Ln ${line}, Col ${column}`;
    syncScroll();
  };
  area.addEventListener('input', update);
  area.addEventListener('scroll', syncScroll);
  ['click', 'keyup', 'select'].forEach(event => area.addEventListener(event, update));
  area.addEventListener('compositionend', update);
  wrapper.append(gutter, area);
  box.replaceChildren(wrapper);
  $('#preview-mode').textContent = '编辑';
  $('#edit').textContent = '保存';
  update();
  area.focus({ preventScroll: true });
}
function previewText() {
  return $('#preview-content textarea')?.value ?? previewItem.content;
}
$('#copy-content').onclick = async () => {
  const text = previewText();
  if (typeof text !== 'string') return;
  try {
    await navigator.clipboard.writeText(text);
    toast('全文已复制');
    return;
  } catch { /* Plain HTTP mobile browsers may require the legacy copy path. */ }
  const focused = document.activeElement;
  const editor = $('#preview-content textarea');
  const selection = editor ? [editor.selectionStart, editor.selectionEnd, editor.scrollTop, editor.scrollLeft] : null;
  const temporary = el('textarea', 'copy-buffer');
  temporary.value = text;
  temporary.setAttribute('aria-label', '待复制内容');
  $('#preview').append(temporary);
  temporary.focus({ preventScroll: true });
  temporary.select();
  temporary.setSelectionRange(0, text.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* Offer manual selection below. */ }
  temporary.remove();
  focused?.focus({ preventScroll: true });
  if (selection) {
    editor.setSelectionRange(selection[0], selection[1]);
    editor.scrollTop = selection[2]; editor.scrollLeft = selection[3];
  }
  if (copied) return toast('全文已复制');
  if (!editor) startEditing();
  const input = $('#preview-content textarea');
  input.focus({ preventScroll: true }); input.select();
  toast('浏览器未允许自动复制，已选中全文，请长按选择复制');
};
$('#edit').onclick = () => {
  const editor = $('#preview-content textarea');
  if (editor) {
    previewItem.content = editor.value;
    preview(previewItem);
    toast('已保存到模拟数据');
  } else startEditing();
};

// Dot-prefixed files and directories start hidden on every page load.
$('#hidden').checked = false;
$('#hidden').onchange = render;
$('#select').onclick = () => { selecting = !selecting; if (!selecting) selected.clear(); render(); };
$('#collapse').onclick = () => { const collapse = currentDirectory.children.some(child => child.children && expanded.has(child.id)); const visit = directory => { directory.children?.forEach(child => { if (child.children) { if (collapse) expanded.delete(child.id); else expanded.add(child.id); if (collapse) visit(child); } }); }; expanded.add(currentDirectory.id); visit(currentDirectory); render(); };
$('#sort').onclick = () => { const body = sheet('排序', '文件夹优先 · 每一级目录独立排序'); const grid = el('div', 'menu-grid'); [['name', '名称'], ['date', '修改时间'], ['size', '大小']].forEach(([key, label]) => { const button = el('button', key === sortKey ? 'primary' : '', label); button.onclick = () => { sortKey = key; $('#sheet').close(); render(); toast(`按${label}${descending ? '降序' : '升序'}排列`); }; grid.append(button); }); const direction = el('button', '', descending ? '降序 ↓ · 点击切换' : '升序 ↑ · 点击切换'); direction.style.marginTop = '12px'; direction.onclick = () => { descending = !descending; $('#sheet').close(); render(); }; body.append(grid, direction); };
$('#locate').onclick = () => { navigate(root); toast('已定位模拟会话目录'); };
$('#directory-back').onclick = returnToPreviousDirectory;
$('#up').onclick = () => navigate(parentOf(currentDirectory.id));
$('#go-root').onclick = () => navigate(filesystemRoot);
$('#copy-path').onclick = () => action('复制路径', currentDirectory);
$('#upload').onchange = event => { for (const file of event.target.files) { if (target.children.some(n => n.name === file.name)) { toast(`已跳过同名文件：${file.name}`); continue; } target.children.push(node(file.name, `${(file.size / 1024).toFixed(1)} KB`, null, '本地上传占位演示，未读取或发送文件内容。')); } expanded.add(target.id); render(); toast('已添加上传占位条目，未发送到服务器'); event.target.value = ''; };
document.querySelectorAll('.close').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#back').onclick = () => $('#terminal-view').hidden = false;
$('#open-files').onclick = () => $('#terminal-view').hidden = true;
$('#sessions').onclick = () => toast('演示会话：main'); $('#terminal-upload').onclick = () => toast('请进入文件管理体验模拟上传');
render();
