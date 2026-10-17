import type { QuickCommand, QuickCommandData } from '../src/quick-commands.js';
import { moveTab } from './tab-order.js';
import { bindIntentionalClick } from './intentional-click.js';

/** `url` is the quick-commands API of the server they belong to; `where` names it, when there are several. */
export function showQuickCommands(url: string, where: string, send: (text: string) => boolean): void {
  if (document.querySelector('.quick-command-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'paste-overlay quick-command-overlay';
  const box = document.createElement('div');
  box.className = 'paste-box quick-command-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '快捷命令');
  const title = document.createElement('h2');
  title.textContent = where ? `快捷命令 · ${where}` : '快捷命令';
  const hint = document.createElement('p');
  hint.className = 'qc-hint';
  hint.textContent = '发送不追加回车；按住左侧手柄拖动排序。';
  const list = document.createElement('div');
  list.className = 'qc-list';
  const status = document.createElement('div');
  status.className = 'qc-status';
  status.setAttribute('role', 'status');
  status.textContent = '正在读取…';
  const controls = document.createElement('div');
  controls.className = 'paste-row';
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tb-btn'; b.textContent = label;
    bindIntentionalClick(b, action, box);
    return b;
  };
  let busy = false;
  let data: QuickCommandData | null = null;
  const requests = new AbortController();
  const close = (): void => {
    if (busy) return;
    requests.abort(); overlay.remove();
  };
  const closeBtn = button('关闭', close);
  const add = button('＋ 新增', () => { if (data && !busy) edit(); });
  add.disabled = true;
  controls.append(add, closeBtn);
  const form = document.createElement('form');
  form.className = 'qc-form';
  form.hidden = true;
  const nameLabel = document.createElement('label');
  nameLabel.textContent = '命令名称';
  const nameInput = document.createElement('input');
  nameInput.maxLength = 64; nameInput.required = true;
  nameInput.placeholder = '例如：查看 Git 状态';
  nameLabel.append(nameInput);
  const textLabel = document.createElement('label');
  textLabel.textContent = '命令内容';
  const textInput = document.createElement('textarea');
  textInput.maxLength = 4000; textInput.required = true; textInput.rows = 4;
  textInput.placeholder = 'git status';
  textInput.spellcheck = false;
  textInput.autocapitalize = 'off';
  textLabel.append(textInput);
  const fields = document.createElement('div');
  fields.className = 'qc-fields';
  fields.append(nameLabel, textLabel);
  const formControls = document.createElement('div');
  formControls.className = 'paste-row';
  const cancelEdit = button('取消编辑', () => { if (!busy) { form.hidden = true; controls.hidden = false; render(); } });
  let editing: string | null = null;
  const save = button('保存命令', () => { form.requestSubmit(); });
  formControls.append(cancelEdit, save);
  form.append(fields, formControls);
  box.append(title, hint, list, form, status, controls);
  overlay.append(box); document.body.append(overlay);
  closeBtn.focus({ preventScroll: true });
  const keepInputVisible = (): void => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !fields.contains(active)) return;
    const bounds = fields.getBoundingClientRect();
    const inputBounds = active.getBoundingClientRect();
    if (inputBounds.top < bounds.top) fields.scrollTop -= bounds.top - inputBounds.top;
    else if (inputBounds.bottom > bounds.bottom) fields.scrollTop +=
      Math.min(inputBounds.bottom - bounds.bottom, inputBounds.top - bounds.top);
  };
  fields.addEventListener('focusin', () => requestAnimationFrame(keepInputVisible));
  window.visualViewport?.addEventListener('resize', () => requestAnimationFrame(keepInputVisible),
    { signal: requests.signal });

  async function persist(commands: QuickCommand[]): Promise<boolean> {
    if (!data || busy) return false;
    busy = true;
    add.disabled = save.disabled = cancelEdit.disabled = closeBtn.disabled = true;
    nameInput.disabled = textInput.disabled = true;
    status.textContent = '正在保存…';
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: data.revision, commands }), signal: requests.signal,
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'conflict' : 'save');
      data = await response.json();
      status.textContent = '已保存，其他设备打开后可查看。';
      return true;
    } catch (error) {
      status.textContent = (error as Error).message === 'conflict' ?
        '其他设备已修改命令，请关闭后重新打开。当前输入仍保留，可先复制。' : '保存失败，输入已保留，请重试。';
      return false;
    } finally {
      busy = false;
      add.disabled = save.disabled = cancelEdit.disabled = closeBtn.disabled = false;
      nameInput.disabled = textInput.disabled = false;
    }
  }
  function edit(command?: QuickCommand): void {
    editing = command?.id ?? null;
    nameInput.value = command?.label ?? '';
    textInput.value = command?.text ?? '';
    form.hidden = false; controls.hidden = true;
    render(); nameInput.focus({ preventScroll: true });
  }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!data || busy) return;
    const label = nameInput.value.trim();
    const text = textInput.value;
    if (!label || !text.trim()) { status.textContent = '请填写命令名称和内容。'; return; }
    const id = editing ?? Array.from(crypto.getRandomValues(new Uint8Array(12)))
      .map(n => n.toString(16).padStart(2, '0')).join('');
    const command = { id, label, text };
    const commands = editing ? data.commands.map(c => c.id === editing ? command : c) : [...data.commands, command];
    if (commands.length > 50) { status.textContent = '最多保存 50 条命令。'; return; }
    if (await persist(commands)) { form.hidden = true; controls.hidden = false; render(); }
  });

  function render(): void {
    box.classList.toggle('qc-editing', !form.hidden);
    list.hidden = !form.hidden;
    list.replaceChildren();
    if (!data) return;
    if (!data.commands.length) {
      const empty = document.createElement('p');
      empty.className = 'qc-hint'; empty.textContent = '还没有快捷命令，点击“＋ 新增”创建。';
      list.append(empty);
    }
    for (const command of data.commands) {
      const row = document.createElement('div');
      row.className = 'qc-item'; row.dataset.commandId = command.id;
      const handle = document.createElement('button');
      handle.type = 'button'; handle.className = 'qc-drag';
      const grip = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      grip.setAttribute('viewBox', '0 0 14 20');
      grip.setAttribute('aria-hidden', 'true');
      for (const x of [4, 10]) for (const y of [4, 10, 16]) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y));
        dot.setAttribute('r', '1.5'); grip.append(dot);
      }
      handle.append(grip);
      handle.setAttribute('aria-label', `拖动排序：${command.label}`);
      const body = document.createElement('div'); body.className = 'qc-body';
      const label = document.createElement('strong'); label.textContent = command.label;
      const preview = document.createElement('pre'); preview.textContent = command.text;
      body.append(label, preview);
      const actions = document.createElement('div'); actions.className = 'qc-actions';
      const output = button('发送', () => {
        if (busy || !form.hidden) return;
        if (send(command.text)) close();
        else status.textContent = '当前终端未连接，请连接后重试。';
      });
      const modify = button('编辑', () => { if (!busy && form.hidden) edit(command); });
      let confirming = false;
      const remove = button('删除', () => {
        if (busy || !form.hidden || !data) return;
        if (!confirming) { confirming = true; remove.textContent = '确定'; remove.title = '再次点击确认删除'; return; }
        void persist(data.commands.filter(c => c.id !== command.id)).then(ok => { if (ok) render(); });
      });
      output.disabled = modify.disabled = remove.disabled = !form.hidden;
      actions.append(output, modify, remove);
      row.append(handle, body, actions); list.append(row);
      let drag: { id: number; y: number; target: string | null; after: boolean; moved: boolean } | null = null;
      const clear = (): void => {
        drag = null;
        for (const item of list.children) item.classList.remove('qc-dragging', 'qc-drop-before', 'qc-drop-after');
      };
      handle.addEventListener('pointerdown', e => {
        if (busy || !form.hidden || e.button !== 0 || !e.isPrimary) return;
        e.preventDefault();
        drag = { id: e.pointerId, y: e.clientY, target: null, after: false, moved: false };
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', e => {
        if (!drag || drag.id !== e.pointerId) return;
        if (Math.abs(e.clientY - drag.y) > 6) drag.moved = true;
        if (!drag.moved) return;
        row.classList.add('qc-dragging');
        for (const item of list.children) item.classList.remove('qc-drop-before', 'qc-drop-after');
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.qc-item');
        if (target && list.contains(target)) {
          drag.target = target.dataset.commandId ?? null;
          const rect = target.getBoundingClientRect();
          drag.after = e.clientY >= rect.top + rect.height / 2;
          if (target !== row) target.classList.add(drag.after ? 'qc-drop-after' : 'qc-drop-before');
        } else drag.target = null;
        const rect = list.getBoundingClientRect();
        if (e.clientY < rect.top + 30) list.scrollTop -= 16;
        else if (e.clientY > rect.bottom - 30) list.scrollTop += 16;
      });
      handle.addEventListener('pointerup', e => {
        if (!drag || drag.id !== e.pointerId) return;
        const finished = drag;
        clear();
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        const target = data?.commands.find(c => c.id === finished.target);
        if (finished.moved && target && target !== command && data) {
          void persist(moveTab(data.commands, command, target, finished.after)).then(ok => { if (ok) render(); });
        }
      });
      handle.addEventListener('pointercancel', clear);
      handle.addEventListener('lostpointercapture', clear);
      handle.addEventListener('keydown', e => {
        if (busy || !form.hidden || !data || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const neighbor = data.commands[data.commands.indexOf(command) + (e.key === 'ArrowUp' ? -1 : 1)];
        if (neighbor) void persist(moveTab(data.commands, command, neighbor, e.key === 'ArrowDown')).then(ok => { if (ok) render(); });
      });
    }
  }
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape' && form.hidden) { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !form.hidden) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Tab') {
      const elements = Array.from(box.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea'))
        .filter(el => el.getClientRects().length > 0);
      const first = elements[0], last = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  void fetch(url, { cache: 'no-store', signal: requests.signal }).then(async response => {
    if (!response.ok) throw new Error('load');
    data = await response.json(); add.disabled = false; status.textContent = ''; render();
  }).catch(() => { if (!requests.signal.aborted) status.textContent = '读取失败，请关闭后重试。'; });
}
