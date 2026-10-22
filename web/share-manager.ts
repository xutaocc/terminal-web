import './share-manager.css';

let manager: HTMLDialogElement | null = null;
/** Keep the live terminal mounted while managing shares in a same-origin dialog. */
export function openShareManager(getCatalog: () => unknown[]): void {
  if (manager) { manager.focus(); return; }
  const previousFocus = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  manager = dialog;
  dialog.className = 'share-manager';
  dialog.setAttribute('aria-labelledby', 'share-manager-title');
  const header = document.createElement('header');
  const title = document.createElement('h2'); title.id = 'share-manager-title'; title.textContent = '分享管理';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭分享管理');
  const frame = document.createElement('iframe'); frame.title = '分享管理'; frame.src = '/shares?embedded=1';
  const sendTheme = () => frame.contentWindow?.postMessage({type:'terminal-theme', theme:document.documentElement.dataset.theme ?? 'dark'}, location.origin);
  const observer = new MutationObserver(sendTheme);
  observer.observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});
  let ready = false;
  const requestClose = () => {
    if (ready) frame.contentWindow?.postMessage({type:'share-manager-request-close'}, location.origin);
    else dialog.close();
  };
  const message = (event: MessageEvent) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'share-manager-ready') { ready = true; sendTheme(); }
    if (event.data?.type === 'share-manager-catalog-request') frame.contentWindow?.postMessage({type:'share-manager-catalog', requestId:event.data.requestId, groups:getCatalog()}, location.origin);
    if (event.data?.type === 'share-manager-close') dialog.close();
  };
  window.addEventListener('message', message);
  close.onclick = requestClose;
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  // Do not dismiss on backdrop clicks: a newly issued token may still be visible.
  dialog.addEventListener('close', () => {
    window.removeEventListener('message', message);
    observer.disconnect();
    dialog.remove(); manager = null;
    if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
  }, {once:true});
  header.append(title, close); dialog.append(header, frame); document.body.append(dialog);
  dialog.showModal(); close.focus();
}
