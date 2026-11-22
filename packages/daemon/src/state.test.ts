import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IDLE_AFTER_MS, IdleClock, StateTracker } from './state.ts';
import type { AgentView, HookEnvelope, Provider } from '../../protocol/src/index.ts';

test('waiting turns idle after the TUI threshold and the clock restarts on any other view', () => {
  const clock = new IdleClock();
  const waiting: AgentView = { provider: 'claude', agentSessionId: 'a', agentRunId: '7', activity: 'waiting', turnId: 't1', pendingTools: [] };
  assert.equal(IDLE_AFTER_MS, 120_000);
  assert.equal(clock.present(null, 0), null);
  assert.equal(clock.present(waiting, 1000).activity, 'waiting');
  assert.equal(clock.present(waiting, 1000 + IDLE_AFTER_MS - 1).activity, 'waiting');
  const idle = clock.present(waiting, 1000 + IDLE_AFTER_MS);
  assert.equal(idle.activity, 'idle');
  assert.equal(waiting.activity, 'waiting', 'the tracked view itself is never rewritten');
  // Working in between restarts the clock even when the next turn ends with the same identity.
  assert.equal(clock.present({ ...waiting, activity: 'working' }, 200_000).activity, 'working');
  assert.equal(clock.present(waiting, 200_001).activity, 'waiting');
  assert.equal(clock.present(waiting, 200_001 + IDLE_AFTER_MS).activity, 'idle');
  // A new turn, conversation or run seen only while waiting also restarts it.
  for (const next of [{ turnId: 't2' }, { agentSessionId: 'b' }, { agentRunId: '8' }]) {
    const view = { ...waiting, ...next };
    assert.equal(clock.present(view, 900_000).activity, 'waiting');
    assert.equal(clock.present(view, 900_000 + IDLE_AFTER_MS).activity, 'idle');
  }
  // Other states pass through untouched however long they last.
  for (const activity of ['running', 'working', 'permission', 'exited'] as const) {
    assert.equal(clock.present({ ...waiting, activity }, 0).activity, activity);
    assert.equal(clock.present({ ...waiting, activity }, 10 * IDLE_AFTER_MS).activity, activity);
  }
});

// Synthetic protocol fixtures: these are not recordings of installed agent behavior.
function event(name: string, payload: Record<string, unknown> = {}, provider: Provider = 'codex'): HookEnvelope {
  return {
    eventId: randomUUID(), sessionId: 'pty', instanceId: 'instance', provider,
    payload: { session_id: 'agent-session', hook_event_name: name, ...payload },
  };
}
function tracker(): StateTracker {
  const state = new StateTracker();
  state.bind('instance', 'process-1');
  return state;
}

test('a hook cannot bind itself to a foreground process', () => {
  const state = new StateTracker();
  assert.equal(state.apply(event('SessionStart'), 'process-1'), null);
  state.bind('instance', 'process-1');
  assert.equal(state.apply(event('SessionStart'), 'process-1')?.activity, 'running');
});

test('bound instance and foreground run reject stale hooks; exit is final', () => {
  const state = tracker();
  const initial = event('UserPromptSubmit', { turn_id: 't1', prompt: 'work' });
  assert.equal(state.apply(initial, 'process-1')?.activity, 'working');
  assert.equal(state.apply(event('Stop'), 'old-process')?.activity, 'working');
  assert.equal(state.apply({ ...event('Stop'), instanceId: 'old-instance' }, 'process-1')?.activity, 'working');
  state.exit();
  assert.equal(state.apply(event('UserPromptSubmit', { prompt: 'late' }), 'process-1')?.activity, 'exited');
  state.bind('instance', 'process-2');
  assert.equal(state.view, null);
  state.reset();
  assert.equal(state.apply(event('SessionStart'), 'process-2'), null);
});

test('new turns retire previous turns and ignore late old results', () => {
  const state = tracker();
  state.apply(event('UserPromptSubmit', { turn_id: 't1', prompt: 'first' }), 'process-1');
  state.apply(event('PermissionRequest', { turn_id: 't1', tool_use_id: 'tool-1' }), 'process-1');
  assert.equal(state.view?.activity, 'permission');
  state.apply(event('UserPromptSubmit', { turn_id: 't2', prompt: 'second' }), 'process-1');
  for (const name of ['Stop', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit']) {
    state.apply(event(name, { turn_id: 't1', tool_use_id: 'tool-1', prompt: 'old' }), 'process-1');
    assert.equal(state.view?.activity, 'working');
    assert.equal(state.view?.turnId, 't2');
  }
  state.apply(event('Stop', { turn_id: 'unknown-turn' }), 'process-1');
  assert.equal(state.view?.activity, 'working');
});

test('separate permissions stay pending until each correlated tool returns', () => {
  const state = tracker();
  state.apply(event('UserPromptSubmit', { turn_id: 'turn' }), 'process-1');
  for (const toolId of ['a', 'b']) state.apply(event('PermissionRequest', { turn_id: 'turn', tool_use_id: toolId }), 'process-1');
  state.apply(event('PreToolUse', { turn_id: 'turn', tool_use_id: 'a' }), 'process-1');
  state.apply(event('PostToolUse', { turn_id: 'turn', tool_use_id: 'unrelated' }), 'process-1');
  assert.deepEqual(state.view?.pendingTools, ['a', 'b']);
  state.apply(event('PostToolUse', { turn_id: 'turn', tool_use_id: 'a' }), 'process-1');
  assert.equal(state.view?.activity, 'permission');
  assert.deepEqual(state.view?.pendingTools, ['b']);
  state.apply(event('PostToolUseFailure', { turn_id: 'turn', tool_use_id: 'b' }), 'process-1');
  assert.equal(state.view?.activity, 'working');
  assert.deepEqual(state.view?.pendingTools, []);
});

test('permission without tool id cannot be cleared by an unrelated result', () => {
  const state = tracker();
  state.apply(event('PermissionRequest', { tool_name: 'Bash' }), 'process-1');
  assert.equal(state.view?.reason, 'permission_has_no_tool_id');
  state.apply(event('PostToolUse', { tool_name: 'Bash', tool_use_id: 'a' }), 'process-1');
  assert.equal(state.view?.activity, 'permission');
  state.apply(event('UnexpectedEvent', {}), 'process-1');
  assert.equal(state.view?.activity, 'permission');
  state.apply(event('Stop'), 'process-1');
  assert.equal(state.view?.activity, 'waiting');
});

test('subagent hooks and completions cannot overwrite parent state', () => {
  const state = tracker();
  state.apply(event('UserPromptSubmit', { turn_id: 'turn' }), 'process-1');
  state.apply(event('Stop', { turn_id: 'turn', agent_id: 'child' }), 'process-1');
  state.apply(event('SubagentStop', { turn_id: 'turn' }), 'process-1');
  assert.equal(state.view?.activity, 'working');
  state.apply(event('PermissionRequest', { turn_id: 'turn', agent_id: 'child' }), 'process-1');
  assert.deepEqual(state.view?.pendingTools, []);
});

test('same session SessionStart does not reset working state; retired sessions stay retired', () => {
  const state = tracker();
  state.apply(event('UserPromptSubmit', { turn_id: 'turn' }), 'process-1');
  state.apply(event('SessionStart', { source: 'compact' }), 'process-1');
  assert.equal(state.view?.activity, 'working');
  state.apply(event('Stop', { session_id: 'other-session' }), 'process-1');
  assert.equal(state.view?.agentSessionId, 'agent-session');
  state.apply(event('SessionStart', { session_id: 'other-session' }), 'process-1');
  assert.equal(state.view?.agentSessionId, 'other-session');
  state.apply(event('SessionStart'), 'process-1');
  assert.equal(state.view?.agentSessionId, 'other-session');
});

test('Stop continuations and background work degrade conservatively', () => {
  for (const payload of [{ stop_hook_active: true }, { background_tasks: [{ id: 'background' }] }, { session_crons: [{ id: 'scheduled' }] }]) {
    const state = tracker();
    state.apply(event('UserPromptSubmit', { turn_id: 't' }), 'process-1');
    state.apply(event('Stop', { turn_id: 't', ...payload }), 'process-1');
    assert.equal(state.view?.activity, 'running');
    assert.equal(state.view?.reason, 'stop_may_continue');
  }
});

test('provider-specific interrupt, API failure, and auto denial have limited meanings', () => {
  const state = tracker();
  state.apply(event('PermissionRequest', { turn_id: 't', tool_use_id: 'a' }), 'process-1');
  state.apply(event('Interrupt', { turn_id: 't' }), 'process-1');
  assert.equal(state.view?.activity, 'running');
  assert.equal(state.view?.reason, 'turn_interrupted');
  state.reset();
  state.bind('instance', 'process-1');
  state.apply(event('PermissionRequest', { tool_use_id: 'a' }, 'claude'), 'process-1');
  state.apply(event('PermissionDenied', { tool_use_id: 'a', permission_mode: 'default' }, 'claude'), 'process-1');
  assert.equal(state.view?.activity, 'permission');
  state.apply(event('StopFailure', {}, 'claude'), 'process-1');
  assert.equal(state.view?.activity, 'running');
  assert.equal(state.view?.reason, 'turn_failed');
  state.apply(event('PermissionRequest', { tool_use_id: 'a' }, 'claude'), 'process-1');
  state.apply(event('PermissionDenied', { tool_use_id: 'a', permission_mode: 'auto' }, 'claude'), 'process-1');
  assert.equal(state.view?.activity, 'running');
  assert.deepEqual(state.view?.pendingTools, []);
});

test('duplicate prompt and missing fields cannot clear a permission', () => {
  const state = tracker();
  const prompt = event('UserPromptSubmit', { turn_id: 't' });
  state.apply(prompt, 'process-1');
  state.apply(event('PermissionRequest', { turn_id: 't', tool_use_id: 'a' }), 'process-1');
  state.apply(prompt, 'process-1');
  state.apply(event('Stop', { session_id: '' }), 'process-1');
  state.apply(event('', { session_id: 'agent-session' }), 'process-1');
  assert.equal(state.view?.activity, 'permission');
  const copy = state.view;
  copy!.pendingTools.length = 0;
  assert.deepEqual(state.view?.pendingTools, ['a']);
});

test('a notification without current turn evidence cannot end a newer working turn', () => {
  const state = tracker();
  state.apply(event('UserPromptSubmit', { turn_id: 't' }), 'process-1');
  state.apply(event('Notification', { notification_type: 'idle_prompt' }), 'process-1');
  assert.equal(state.view?.activity, 'running');
  assert.equal(state.view?.reason, 'idle_without_turn_correlation');
  state.apply(event('Notification', { notification_type: 'idle_prompt', turn_id: 't' }), 'process-1');
  assert.equal(state.view?.activity, 'waiting');
});

test('Claude idle_prompt after its Stop keeps waiting, while one older than the latest submit cannot end it', () => {
  const state = tracker();
  const apply = (name: string, at: number, payload = {}) => state.apply({ ...event(name, payload, 'claude'), hookStartedAt: at }, 'process-1');
  apply('UserPromptSubmit', 1000, { prompt: 'first' });
  apply('Stop', 1100);
  assert.equal(state.view?.activity, 'waiting');
  // Claude sends idle_prompt about 60 s after the turn ends, without a turn id.
  apply('Notification', 61_100, { notification_type: 'idle_prompt' });
  assert.equal(state.view?.activity, 'waiting');
  apply('UserPromptSubmit', 70_000, { prompt: 'second' });
  apply('Notification', 65_000, { notification_type: 'idle_prompt' });
  assert.notEqual(state.view?.activity, 'waiting', 'a notification older than the latest submit is not completion');
});

test('Claude without turn ids exposes unresolved completion instead of trusting an old Stop', () => {
  const state = tracker();
  state.apply(event('UserPromptSubmit', { prompt: 'first' }, 'claude'), 'process-1');
  state.apply(event('UserPromptSubmit', { prompt: 'second' }, 'claude'), 'process-1');
  state.apply(event('Stop', {}, 'claude'), 'process-1');
  assert.equal(state.view?.activity, 'running');
  assert.equal(state.view?.reason, 'stop_without_turn_correlation');
  state.apply(event('PermissionRequest', {}, 'claude'), 'process-1');
  state.apply(event('Stop', {}, 'claude'), 'process-1');
  assert.equal(state.view?.activity, 'permission');
  assert.equal(state.view?.reason, 'stop_without_turn_correlation');
});

test('synchronous Claude hooks complete without native turn IDs and reject delayed old invocations', () => {
  const state = tracker();
  const apply = (name: string, at: number, payload = {}) => state.apply({ ...event(name, payload, 'claude'), hookStartedAt: at }, 'process-1');
  apply('UserPromptSubmit', 1000, { prompt: 'first' });
  apply('Stop', 1100);
  assert.equal(state.view?.activity, 'waiting');
  apply('UserPromptSubmit', 2000, { prompt: 'second' });
  apply('Stop', 1500);
  assert.equal(state.view?.activity, 'working');
  apply('PreToolUse', 2100, { tool_use_id: 'a', tool_name: 'Bash' });
  apply('PermissionRequest', 2200, { tool_name: 'Bash' });
  assert.equal(state.view?.activity, 'permission');
  apply('PostToolUse', 2300, { tool_use_id: 'a', tool_name: 'Bash' });
  assert.equal(state.view?.activity, 'working');
  apply('Stop', 2400);
  assert.equal(state.view?.activity, 'waiting');
});

test('Kimi lifecycle and permission events preserve parent and turn isolation', () => {
  const state = tracker();
  const apply = (name: string, at: number, payload = {}) => state.apply({ ...event(name, payload, 'kimi'), hookStartedAt: at }, 'process-1');
  apply('TurnStarted', 1000, { turn_id: 'k1' });
  apply('PermissionRequest', 1100, { turn_id: 'k1', tool_use_id: 'tool' });
  assert.equal(state.view?.activity, 'permission');
  apply('PermissionResult', 1200, { turn_id: 'k1', tool_use_id: 'tool' });
  assert.equal(state.view?.activity, 'working');
  apply('Stop', 1300);
  assert.equal(state.view?.activity, 'waiting');
  apply('TurnStarted', 2000, { turn_id: 'k2' });
  apply('Stop', 2100, { turn_id: 'k1' });
  assert.equal(state.view?.activity, 'working');
  apply('SubagentStop', 2200);
  assert.equal(state.view?.activity, 'working');
});

test('Kimi wire turn.ended ends only the exact open turn when Stop never arrives', () => {
  const state = tracker();
  const apply = (name: string, at: number, payload = {}) => state.apply({ ...event(name, payload, 'kimi'), hookStartedAt: at }, 'process-1');
  // Without a numbered TurnStarted there is nothing to correlate.
  apply('UserPromptSubmit', 1000, { prompt: 'first' });
  assert.equal(state.openKimiTurn, undefined);
  assert.equal(state.kimiTurnEnded('agent-session', 'process-1', 0, 'completed', 5000), false);
  assert.equal(state.view?.activity, 'working');
  apply('TurnStarted', 1100, { turn_id: '3', origin_kind: 'user' });
  assert.equal(state.openKimiTurn, 3);
  // Wrong turn, conversation, run, older end time and unknown reasons are ignored.
  assert.equal(state.kimiTurnEnded('agent-session', 'process-1', 2, 'completed', 5000), false);
  assert.equal(state.kimiTurnEnded('other-session', 'process-1', 3, 'completed', 5000), false);
  assert.equal(state.kimiTurnEnded('agent-session', 'process-2', 3, 'completed', 5000), false);
  assert.equal(state.kimiTurnEnded('agent-session', 'process-1', 3, 'completed', 1050), false);
  assert.equal(state.kimiTurnEnded('agent-session', 'process-1', 3, 'paused', 5000), false);
  assert.equal(state.view?.activity, 'working');
  assert.equal(state.kimiTurnEnded('agent-session', 'process-1', 3, 'completed', 5000), true);
  assert.equal(state.view?.activity, 'waiting');
  assert.equal(state.openKimiTurn, undefined);
  // The same end is not applied twice, and a late user TurnStarted cannot reopen it.
  assert.equal(state.kimiTurnEnded('agent-session', 'process-1', 3, 'completed', 5000), false);
  apply('TurnStarted', 5100, { turn_id: '3', origin_kind: 'user' });
  assert.equal(state.view?.activity, 'waiting');

  apply('UserPromptSubmit', 6000, { prompt: 'second' });
  apply('TurnStarted', 6100, { turn_id: '4', origin_kind: 'user' });
  apply('PermissionRequest', 6200, { turn_id: '4', tool_use_id: 'tool' });
  assert.equal(state.kimiTurnEnded('agent-session', 'process-1', 4, 'cancelled', 7000), true);
  assert.deepEqual([state.view?.activity, state.view?.reason, state.view?.pendingTools], ['running', 'turn_interrupted', []]);

  apply('UserPromptSubmit', 8000, { prompt: 'third' });
  apply('TurnStarted', 8100, { turn_id: '5', origin_kind: 'user' });
  apply('Stop', 8200);
  assert.equal(state.view?.activity, 'waiting');
  // A turn already closed by its Stop hook stays as it is.
  assert.equal(state.kimiTurnEnded('agent-session', 'process-1', 5, 'failed', 9000), false);
  assert.equal(state.view?.activity, 'waiting');
});

test('a delayed Kimi user TurnStarted cannot reopen a completed submitted turn', () => {
  const state = tracker();
  const apply = (name: string, at: number, payload = {}) => state.apply({ ...event(name, payload, 'kimi'), hookStartedAt: at }, 'process-1');
  apply('UserPromptSubmit', 1000, { prompt: 'first' });
  apply('Stop', 1200);
  assert.equal(state.view?.activity, 'waiting');
  apply('TurnStarted', 1500, { turn_id: '1', origin_kind: 'user' });
  assert.equal(state.view?.activity, 'waiting');
  apply('UserPromptSubmit', 2000, { prompt: 'second' });
  apply('TurnStarted', 2100, { turn_id: '2', origin_kind: 'user' });
  assert.equal(state.view?.activity, 'working');
});

test('Antigravity lifecycle, PreInvocation, PreToolUse and Stop transitions', () => {
  const state = tracker();
  const apply = (name: string, at: number, payload = {}) => state.apply({ ...event(name, payload, 'agy'), hookStartedAt: at }, 'process-1');

  // Shape captured from agy: PreInvocation runs before every model call, tools carry stepIdx
  // (not forwarded as a turn), and Stop carries no turn id.
  apply('PreInvocation', 1000, { invocationNum: 0, prompt: 'test agy' });
  assert.equal(state.view?.activity, 'working');
  assert.equal(state.view?.provider, 'agy');

  for (const [index, tool] of ['run_command', 'read_file'].entries()) {
    apply('PreToolUse', 1100 + index * 10, { tool_use_id: `tool-${index}`, tool_name: tool });
    assert.equal(state.view?.activity, 'working');
    apply('PostToolUse', 1105 + index * 10, { tool_use_id: `tool-${index}`, tool_name: tool });
    assert.equal(state.view?.activity, 'working');
  }
  apply('PostInvocation', 1200, { invocationNum: 0 });
  apply('PreInvocation', 1210, { invocationNum: 1, prompt: 'test agy' });
  assert.equal(state.view?.activity, 'working');

  apply('Stop', 1300, { terminationReason: 'NO_TOOL_CALL', continuationActive: false, fullyIdle: true });
  assert.equal(state.view?.activity, 'waiting');

  // continuationActive only says a Stop hook already continued this turn; this Stop still ends it.
  apply('PreInvocation', 2000, { invocationNum: 0, prompt: 'test continuation' });
  apply('Stop', 2100, { terminationReason: 'NO_TOOL_CALL', continuationActive: true, fullyIdle: true });
  assert.equal(state.view?.activity, 'waiting');

  apply('PreInvocation', 2500, { invocationNum: 0, prompt: 'test background' });
  apply('Stop', 2600, { terminationReason: 'NO_TOOL_CALL', fullyIdle: false });
  assert.equal(state.view?.activity, 'running');
  assert.equal(state.view?.reason, 'stop_may_continue');

  apply('PreInvocation', 3000, { invocationNum: 0, prompt: 'test cancel' });
  apply('Stop', 3100, { terminationReason: 'USER_CANCELED' });
  assert.equal(state.view?.activity, 'running');
  assert.equal(state.view?.reason, 'turn_interrupted');
});
