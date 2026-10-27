import { labelBadge } from './hosts.js';
import { bindIntentionalClick } from './intentional-click.js';
import './mobile-actions.css';

export const mobileActions = (): boolean => matchMedia('(max-width: 640px), (hover: none) and (pointer: coarse)').matches;

export interface ActionContext {
  tag: { name: string; color: string; note: string };
  remote: boolean;
  hostTitle: string;
  directory: string;
  path: string;
  folder?: string;
  session?: string;
  count: number;
}

function contextHeader(context: ActionContext): HTMLElement {
  const header = document.createElement('header'); header.className = 'mobile-actions-context';
  const host = document.createElement('div'); host.className = 'mobile-actions-host';
  const kind = document.createElement('span'); kind.textContent = `${context.remote ? '远程' : '本地'} · ${context.hostTitle}`;
  host.append(labelBadge(context.tag.name, context.tag.color, context.tag.note), kind);
  const scope = document.createElement('div'); scope.className = 'mobile-actions-scope';
  scope.textContent = context.session ? `会话操作 · ${context.session}` : `目录操作 · ${context.count} 个会话`;
  const directory = document.createElement('div'); directory.className = 'mobile-actions-directory';
  directory.textContent = `目录：${context.directory}${context.folder ? ` · 分组：${context.folder}` : ''}`;
  const path = document.createElement('div'); path.className = 'mobile-actions-path';
  path.textContent = context.path || '暂未获取目录路径';
  header.append(host, scope, directory, path); return header;
}

/** Keep dismissal taps inside a modal, so they cannot activate the session below. */
export function mountMobileActions(menu: HTMLElement, close: () => void, context?: ActionContext): (() => void) | null {
  if (!mobileActions()) return null;
  const previous = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'mobile-actions';
  dialog.setAttribute('aria-label', menu.querySelector('.ps-menu-title')?.textContent || '会话操作');
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'mobile-actions-cancel'; cancel.textContent = '取消';
  bindIntentionalClick(cancel, close);
  bindIntentionalClick(dialog, event => { if (event.target === dialog) close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  if (context) {
    menu.querySelector('.ps-menu-title')?.remove();
    dialog.append(contextHeader(context));
  }
  dialog.append(menu, cancel); document.body.append(dialog); dialog.showModal(); cancel.focus();
  return () => {
    dialog.close(); dialog.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  };
}
