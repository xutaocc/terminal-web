import './confirm-dialog.css';

let pending: Promise<boolean> | undefined;
/** A modal in the top layer, including above existing dialogs within an iframe. */
export function confirmAction(message: string, title = '确认操作', accept = '确认'): Promise<boolean> {
  // Ignore repeated triggers while the current decision is pending.
  if (pending) return Promise.resolve(false);
  pending = new Promise<boolean>(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'app-confirm';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-labelledby', 'app-confirm-title');
    dialog.setAttribute('aria-describedby', 'app-confirm-message');
    const heading = document.createElement('h2');
    heading.id = 'app-confirm-title'; heading.textContent = title;
    const body = document.createElement('p');
    body.id = 'app-confirm-message'; body.textContent = message;
    const actions = document.createElement('div'); actions.className = 'app-confirm-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
    const ok = document.createElement('button'); ok.type = 'button'; ok.textContent = accept; ok.className = 'app-confirm-accept';
    let accepted = false;
    cancel.onclick = () => dialog.close();
    ok.onclick = () => { accepted = true; dialog.close(); };
    // Keep Escape local: it must not close the editor or management panel underneath.
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    dialog.addEventListener('close', () => {
      dialog.remove(); pending = undefined;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      resolve(accepted);
    }, { once: true });
    actions.append(cancel, ok); dialog.append(heading, body, actions);
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
  return pending;
}
