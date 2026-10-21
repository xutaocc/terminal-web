import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hookSignal, isShell, paneSignal, screenSignal, titleWorking } from '../src/agent-status.js';

test('hook events map to turn states', () => {
  assert.equal(hookSignal('UserPromptSubmit'), 'working');
  assert.equal(hookSignal('PreToolUse', 'Bash'), 'working');
  assert.equal(hookSignal('PreToolUse', 'AskUserQuestion'), 'waiting');
  assert.equal(hookSignal('PermissionRequest', 'Bash'), 'waiting');
  assert.equal(hookSignal('Notification', '', 'permission_prompt'), 'waiting');
  assert.equal(hookSignal('Notification', '', 'idle_prompt'), null);
  assert.equal(hookSignal('Stop'), 'done');
  assert.equal(hookSignal('Interrupt'), 'done');
  assert.equal(hookSignal('SessionEnd'), 'idle');
  assert.equal(hookSignal('SessionStart'), null);
});

const claudeWorking = [
  '● Reading files…',
  '· Proofing… (23s · ↓ 1.5k tokens · thought for 18s)',
  '────────────────',
  '❯ ',
  '────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents',
].join('\n');

const claudeIdle = [
  '● Done. Should I say "esc to interrupt" again?',
  '',
  '────────────────',
  '❯ ',
  '────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

const claudePermission = [
  ' Bash command',
  '   rm -rf build',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don\'t ask again for rm commands',
  '   3. No, and tell Claude what to do differently (esc)',
].join('\n');

const codexApproval = [
  'Would you like to run the following command?',
  '$ npm test',
  '› 1. Yes, proceed (y)',
  '  2. No, and tell Codex what to do differently (esc)',
  'Press enter to confirm or esc to cancel',
].join('\n');

test('screens: running turns, prompts that ask, and idle prompts', () => {
  assert.equal(screenSignal(claudeWorking), 'working');
  assert.equal(screenSignal(`${'x\n'.repeat(40)}• Working (12s • esc to interrupt)\n\n› \n`), 'working');
  assert.equal(screenSignal(claudeIdle), 'idle');
  assert.equal(screenSignal(claudePermission), 'waiting');
  assert.equal(screenSignal('some transcript\n    ↑/↓ to scroll · c to copy · Esc to close\n'), 'unknown');
  assert.equal(screenSignal(codexApproval), 'waiting');
});

test('a question in the conversation without a menu is not a prompt', () => {
  assert.equal(screenSignal('Do you want to proceed with this plan?\n\n❯ \n'), 'idle');
  // "esc to interrupt" quoted high up the screen does not count either.
  assert.equal(screenSignal(`esc to interrupt\n${'line\n'.repeat(10)}❯ \n`), 'idle');
});

test('titles and foreground commands', () => {
  assert.equal(titleWorking('◐ Fix bug'), true);
  assert.equal(titleWorking('⠋ Fix bug'), true);
  assert.equal(titleWorking('✳ Fix bug'), false);
  assert.equal(isShell('zsh'), true);
  assert.equal(isShell('-zsh'), true);
  assert.equal(isShell('pwsh'), true);
  assert.equal(isShell('powershell'), true);
  assert.equal(isShell('cmd.exe'), true);
  assert.equal(isShell('claude.exe'), false);
  assert.equal(isShell('node'), false);
});

test('an idle Codex prompt wins over a stale spinner in the pane title', () => {
  const prompt = '› Ask Codex to do anything\nGPT-6-Sol medium · C:\\devMyHome\\terminal-web';
  assert.equal(paneSignal(prompt, '⠋ Old task'), 'idle');
  assert.equal(paneSignal('full-screen viewer', '⠋ Current task'), 'working');
});

test('dots fold several sessions by urgency', async () => {
  const { combineStatus, wantsAttention } = await import('../web/agent-indicator.js');
  const s = (state: 'idle' | 'working' | 'waiting' | 'done', unread = false) => ({ state, unread });
  assert.equal(combineStatus([]), 'idle');
  assert.equal(combineStatus([undefined, s('idle')]), 'idle');
  assert.equal(combineStatus([s('done')]), 'done');
  assert.equal(combineStatus([s('done', true), s('done')]), 'unread');
  assert.equal(combineStatus([s('done', true), s('working')]), 'working');
  assert.equal(combineStatus([s('working'), s('waiting', true)]), 'waiting');
  assert.equal(wantsAttention('unread'), true);
  assert.equal(wantsAttention('working'), false);
});

// Fixtures below are built from each agent's own literals (see screenSignal).
test('qwen-code: cancel hint while working, numbered approval, › prompt when idle', () => {
  assert.equal(screenSignal('⠋ Thinking… (12s · esc to cancel)\n\n› \n? for shortcuts'), 'working');
  assert.equal(screenSignal('⠋ Reading files (3s · esc to cancel)\nPress Esc again to stop'), 'working');
  assert.equal(screenSignal([
    "Allow execution of: 'rm -rf build'?",
    '› 1. Yes, allow once',
    '  2. Yes, allow always',
    '  3. No, suggest changes (esc)',
  ].join('\n')), 'waiting');
  assert.equal(screenSignal('Apply this change?\n› 1. Yes, allow once\n  2. Modify with external editor'), 'waiting');
  assert.equal(screenSignal('✦ Done.\n\n› Type your message\n? for shortcuts'), 'idle');
});

test('Kimi Code: armed interrupt, approval options, boxed prompt', () => {
  assert.equal(screenSignal('working on it\nPress Esc again to interrupt'), 'working');
  assert.equal(screenSignal([
    'Run shell command: rm -rf build',
    '❯ 1. Approve once',
    '  2. Approve for this session',
    '  3. Reject',
  ].join('\n')), 'waiting');
  assert.equal(screenSignal([
    ' ╭──────────────╮',
    ' │ >            │',
    ' ╰──────────────╯',
    ' GLM-5.3-Flash thinking: high  ~      /init: generate AGENTS.md',
  ].join('\n')), 'idle');
});

test('opencode / MiMo Code: esc interrupt footer, permission buttons, idle footer', () => {
  assert.equal(screenSignal('┃ Type your message...\n🛸·∙˙   Rebuilding context…        esc interrupt'), 'working');
  assert.equal(screenSignal('┃\n⋯ Writing checkpoint…   again to interrupt'), 'working');
  assert.equal(screenSignal([
    '△  Permission required',
    '  → Edit src/foo.ts',
    '─────────────',
    ' Allow once   Allow always   Reject        ⇆ select   enter confirm',
  ].join('\n')), 'waiting');
  assert.equal(screenSignal('┃ Type your message... (type / for commands)\n52.4K/960K (5%) · $0.01  tab switch mode  ctrl+p settings      @ attach file  $ subagent  / commands'), 'idle');
});

test('the new wording quoted in a reply still proves nothing', () => {
  // A reply mentioning the hints, with no status line or prompt beneath it.
  assert.equal(screenSignal('You can press esc to cancel the request.\nOr say "esc interrupt" to stop it.'), 'unknown');
  // Approval words without any menu are just text.
  assert.equal(screenSignal('I would Approve once if asked.\nAllow once and Allow always differ.\n❯ '), 'idle');
});
