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
  assert.equal(paneSignal('full-screen viewer', '⠋ Current task'), 'unknown');
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
test('qwen-code: cancel hint while working, numbered approval, ➜ footer when idle', () => {
  assert.equal(screenSignal('⠋ Thinking… (12s · esc to cancel)\n\n➜ \n? for shortcuts'), 'working');
  assert.equal(screenSignal('⠋ Reading files (3s · esc to cancel)\nPress Esc again to stop'), 'working');
  assert.equal(screenSignal([
    "Allow execution of: 'rm -rf build'?",
    '› 1. Yes, allow once',
    '  2. Yes, allow always',
    '  3. No, suggest changes (esc)',
  ].join('\n')), 'waiting');
  assert.equal(screenSignal('Apply this change?\n› 1. Yes, allow once\n  2. Modify with external editor'), 'waiting');
  assert.equal(screenSignal([
    '✦ Done.',
    '',
    '➜ terminal-web · git:(multi-platform) · deepseek-v4-flash high · 1.0m Context 1.9% used',
    'YOLO mode (shift + tab to cycle)',
  ].join('\n')), 'idle');
  assert.equal(screenSignal('➜ ~\n'), 'unknown');
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


test('legacy activity and read acknowledgements share one server snapshot', async () => {
  const { AgentStatusMonitor } = await import('../src/agent-status.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'tw-legacy-status-'));
  const monitor = new AgentStatusMonitor(join(dir, 'status.json'));
  try {
    await monitor.setMode('legacy');
    const updates: unknown[] = [];
    const unsubscribe = monitor.subscribe(snapshot => updates.push(snapshot));
    monitor.legacyOutput('session-one');
    assert.equal(monitor.snapshot().sessions['session-one'].state, 'working');
    assert.equal(monitor.snapshot().sessions['session-one'].unread, true);
    await new Promise(resolve => setImmediate(resolve));
    monitor.read(['session-one']);
    assert.equal(monitor.snapshot().sessions['session-one'].unread, false);
    assert.equal(monitor.snapshot().sessions['session-one'].state, 'working');
    await new Promise(resolve => setImmediate(resolve));
    monitor.legacyOutput('session-one');
    assert.equal(monitor.snapshot().sessions['session-one'].unread, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updates.length, 3);
    unsubscribe();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('draft text and wrapped draft continuations never become running status', () => {
  for (const draft of [
    '› 请解释 (esc to interrupt) 为什么会误判\nGPT-6.1-Sol · ~/project',
    '› 输入一些内容\n  • Working (12s • esc to interrupt)\nGPT-6.1-Sol · ~/project',
    '│ > Press Esc again to interrupt\n╰──────────────╯',
    '› 讨论这个提示\nPress Esc again to stop\nGPT-6.1-Sol · ~/project',
  ]) assert.equal(screenSignal(draft), 'idle', draft);
  assert.equal(paneSignal('layout redraw without a visible prompt', '⠋ Previous task'), 'unknown');
  assert.equal(screenSignal('The reply said (esc to interrupt).\n› '), 'idle');
});

test('completed/read hook turns ignore delayed tool results but allow new work', async () => {
  const { AgentStatusMonitor } = await import('../src/agent-status.js');
  const monitor = new AgentStatusMonitor('/unused', async () => '');
  const hook = (event: string, tool = '') => monitor.hook('%1', event, tool, '', 'task');
  const state = () => monitor.snapshot().sessions.task;
  await hook('UserPromptSubmit');
  assert.equal(state().state, 'working');
  await hook('PreToolUse', 'request_user_input');
  assert.equal(state().state, 'waiting');
  await hook('PostToolUse');
  assert.equal(state().state, 'working');
  await hook('Stop');
  monitor.read(['task']);
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'Stop']) {
    await hook(event);
    assert.equal(state().state, 'done');
    assert.equal(state().unread, false);
  }
  assert.equal(await monitor.hook('%1', 'Notification', '', 'permission_prompt', 'task'), false);
  assert.equal(state().unread, false);
  await hook('UserPromptSubmit');
  assert.equal(state().state, 'working');
  await hook('Stop');
  assert.equal(state().unread, true);
  monitor.read(['task']);
  await hook('PreToolUse', 'Bash');
  assert.equal(state().state, 'working');
  await hook('Stop');
  assert.equal(state().unread, true);
});

for (const windows of [false, true]) test(`screen fallback preserves read completion and detects new work (${windows ? 'Windows' : 'Unix'})`, async t => {
  const { AgentStatusMonitor } = await import('../src/agent-status.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'tw-screen-state-'));
  const file = join(dir, 'status.json');
  await writeFile(file, JSON.stringify({ mode: 'screen' }));
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100_000 });
  let screen = '› 待输入\nGPT-6.1-Sol';
  let activity = 0;
  const monitor = new AgentStatusMonitor(file, async args => args[0] === 'list-panes'
    ? `%1 task 11 ${activity} node ⠋ Old title` : screen, windows);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const tick = async () => { activity++; t.mock.timers.tick(1000); await flush(); };
  const state = () => monitor.snapshot().sessions.task;
  try {
    await monitor.start(); await flush();
    screen = '› 输入中的草稿 (esc to interrupt)\nGPT-6.1-Sol'; await tick();
    assert.equal(state().state, 'idle');
    screen = 'redraw'; await tick();
    assert.equal(state().state, 'idle');
    screen = '• Working (12s • esc to interrupt)\n› \nGPT-6.1-Sol'; await tick();
    assert.equal(state().state, 'working');
    screen = 'redraw'; await tick();
    assert.equal(state().state, 'working'); // unknown must not interrupt a real task
    screen = '› \nGPT-6.1-Sol'; await tick(); await tick(); await tick();
    assert.equal(state().state, 'done');
    assert.equal(state().unread, true);
    monitor.read(['task']);
    screen = 'redraw'; await tick();
    assert.equal(state().state, 'done');
    assert.equal(state().unread, false);
    screen = '› 解释执行提示\n  • Working (3s • esc to interrupt)\nGPT-6.1-Sol'; await tick();
    assert.equal(state().state, 'done');
    assert.equal(state().unread, false);
    screen = '• Working (1s • esc to interrupt)\n› \nGPT-6.1-Sol'; await tick();
    assert.equal(state().state, 'working');
    screen = '› \nGPT-6.1-Sol'; await tick(); await tick(); await tick();
    assert.equal(state().state, 'done');
    assert.equal(state().unread, true);
  } finally { monitor.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('a capture already in flight cannot overwrite a newer Stop/read acknowledgement', async () => {
  const { AgentStatusMonitor } = await import('../src/agent-status.js');
  let release: (screen: string) => void = () => {};
  const pending = new Promise<string>(resolve => { release = resolve; });
  let captureStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { captureStarted = resolve; });
  const monitor = new AgentStatusMonitor('/nonexistent-status-test', async args => {
    if (args[0] === 'list-panes') return '%1 task 11 1 node Task';
    if (args[0] === 'capture-pane') { captureStarted(); return pending; }
    return '';
  });
  try {
    await monitor.start(); await started;
    await monitor.hook('%1', 'UserPromptSubmit', '', '', 'task');
    await monitor.hook('%1', 'Stop', '', '', 'task');
    monitor.read(['task']);
    release('• Working (12s • esc to interrupt)\n› ');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(monitor.snapshot().sessions.task.state, 'done');
    assert.equal(monitor.snapshot().sessions.task.unread, false);
  } finally { monitor.stop(); }
});


test('standalone and boxed running footers remain valid without title inference', () => {
  assert.equal(screenSignal('· esc to interrupt'), 'working');
  assert.equal(screenSignal('Writing checkpoint…   esc interrupt'), 'working');
  assert.equal(screenSignal('(12s · esc to cancel)'), 'working');
  assert.equal(screenSignal('│ > draft\n╰──────────────╯\nPress Esc again to interrupt'), 'working');
  assert.equal(paneSignal('• Working (1s • esc to interrupt)\n› Draft while task runs', 'Task'), 'working');
});

test('only hooked Windows quiet panes reduce capture load; busy and expired hooks keep fallback', async t => {
  const { AgentStatusMonitor } = await import('../src/agent-status.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'tw-win-poll-'));
  const file = join(dir, 'status.json');
  await writeFile(file, JSON.stringify({mode:'hooks'}));
  t.mock.timers.enable({apis:['Date','setInterval'], now:100000});
  let captures = 0;
  const monitor = new AgentStatusMonitor(file, async args => {
    if (args[0] === 'list-panes') return '%1 task 11 0 node title';
    if (args[0] === 'capture-pane') { captures++; return '› 待输入\nGPT-6.1-Sol'; }
    return '';
  }, true);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    await monitor.start(); await flush(); assert.equal(captures, 1);
    await monitor.hook('%1','Stop','','','task');
    for (let i=0;i<4;i++) {t.mock.timers.tick(1000); await flush();}
    assert.equal(captures, 1);
    t.mock.timers.tick(1000); await flush(); assert.equal(captures, 2);
    await monitor.hook('%1','UserPromptSubmit','','','task');
    assert.equal(monitor.snapshot().sessions.task.state, 'working');
    t.mock.timers.tick(1000); await flush(); assert.equal(captures, 3);
    t.mock.timers.tick(1000); await flush(); assert.equal(captures, 4);
    await monitor.hook('%1','Stop','','','task');
    t.mock.timers.tick(30 * 60_000); await flush();
    const afterExpiry = captures;
    t.mock.timers.tick(1000); await flush();
    assert.equal(captures, afterExpiry + 1);
  } finally {monitor.stop(); await rm(dir, {recursive:true,force:true});}
});


test('Windows hooks mode without received hooks detects short tasks on the next poll', async t => {
  const { AgentStatusMonitor } = await import('../src/agent-status.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'tw-win-unhooked-'));
  const file = join(dir, 'status.json');
  await writeFile(file, JSON.stringify({mode:'hooks'}));
  // Within HOOK_FRESH_MS of epoch: hookAt=0 must not count as a received hook.
  t.mock.timers.enable({apis:['Date','setInterval'], now:100000});
  let screen = '› 待输入\nGPT-6.1-Sol';
  let captures = 0;
  const monitor = new AgentStatusMonitor(file, async args => {
    if (args[0] === 'list-panes') return '%1 task 11 0 node title';
    if (args[0] === 'capture-pane') { captures++; return screen; }
    return '';
  }, true);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    await monitor.start(); await flush();
    screen = '• Working (1s • esc to interrupt)\n› \nGPT-6.1-Sol';
    t.mock.timers.tick(1000); await flush();
    assert.equal(captures, 2);
    assert.equal(monitor.snapshot().sessions.task.state, 'working');
    screen = '› 待输入\nGPT-6.1-Sol';
    for (let i=0;i<3;i++) {t.mock.timers.tick(1000); await flush();}
    assert.equal(monitor.snapshot().sessions.task.state, 'done');
  } finally {monitor.stop(); await rm(dir, {recursive:true,force:true});}
});
