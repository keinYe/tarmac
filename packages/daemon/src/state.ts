import type { AgentView, HookEnvelope, Provider } from '../../protocol/src/index.ts';

function field(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// The event that submits a user prompt. Antigravity runs PreInvocation before every model call
// of a turn; invocationNum restarts at 0 for each user message, so only that first call submits.
export function isPromptEvent(provider: Provider, payload: Record<string, unknown>): boolean {
  const name = field(payload, 'hook_event_name');
  return name === 'UserPromptSubmit' || (provider === 'agy' && name === 'PreInvocation'
    && !(typeof payload.invocationNum === 'number' && payload.invocationNum > 0));
}

export function isSubagentEvent(payload: Record<string, unknown>): boolean {
  return Boolean(field(payload, 'agent_id'))
    || field(payload, 'hook_event_name')?.startsWith('Subagent') === true;
}

// A waiting session counts as idle after two minutes without activity.
export const IDLE_AFTER_MS = 2 * 60_000;

// Waiting for input that lasts IDLE_AFTER_MS is presented as idle, as the TUI does. The clock
// restarts whenever the view leaves waiting or names another conversation, run or turn, so it
// covers both the hook tracker and Codex rollouts without either of them knowing about it.
export class IdleClock {
  private key: string | undefined;
  private since = 0;

  present<T extends AgentView | null | undefined>(view: T, now: number): T {
    if (!view || view.activity !== 'waiting') { this.key = undefined; return view; }
    const key = [view.provider, view.agentSessionId, view.agentRunId, view.turnId ?? ''].join('\0');
    if (key !== this.key) { this.key = key; this.since = now; }
    return now - this.since >= IDLE_AFTER_MS ? { ...view, activity: 'idle' } : view;
  }
}

// The daemon binds this tracker to an observed foreground process, not to a hook claim.
export class StateTracker {
  private binding: { instanceId: string; agentRunId: string } | null = null;
  private current: AgentView | null = null;
  private exited = false;
  private seenEvents = new Set<string>();
  private retiredSessions = new Set<string>();
  private retiredTurns = new Set<string>();
  private pending = new Set<string>();
  private hasSubmitted = false;
  private lastHookAt = 0;
  private submittedAt = 0;
  private tools = new Map<string, string>();
  private kimiUserStopped = false;
  private kimiTurn: number | undefined;

  get view(): AgentView | null {
    return this.current ? { ...this.current, pendingTools: [...this.pending] } : null;
  }

  bind(instanceId: string, agentRunId: string): void {
    if (!instanceId || !agentRunId) throw new Error('state binding requires instance and agent run');
    if (this.binding?.instanceId === instanceId && this.binding.agentRunId === agentRunId) return;
    this.reset();
    this.binding = { instanceId, agentRunId };
  }

  reset(): void {
    this.binding = null;
    this.current = null;
    this.exited = false;
    this.seenEvents.clear();
    this.retiredSessions.clear();
    this.retiredTurns.clear();
    this.pending.clear();
    this.hasSubmitted = false;
    this.lastHookAt = 0;
    this.submittedAt = 0;
    this.tools.clear();
    this.kimiUserStopped = false;
    this.kimiTurn = undefined;
  }

  /** Numeric turn of the latest Kimi TurnStarted hook still awaiting its end. */
  get openKimiTurn(): number | undefined { return this.kimiTurn; }

  // Supplementary end for Kimi turns whose Stop hook never arrives. Only the exact
  // turn announced by TurnStarted, in the same conversation and run, may end.
  kimiTurnEnded(agentSessionId: string, agentRunId: string, turnId: number, reason: string, time: number): boolean {
    const current = this.current;
    if (!current || this.exited || current.provider !== 'kimi' || current.agentSessionId !== agentSessionId
      || this.binding?.agentRunId !== agentRunId || this.kimiTurn !== turnId) return false;
    if (this.submittedAt && time < this.submittedAt) return false;
    if (current.activity !== 'working' && current.activity !== 'permission') return false;
    if (reason !== 'completed' && reason !== 'cancelled' && reason !== 'failed') return false;
    this.kimiTurn = undefined;
    this.pending.clear();
    if (reason === 'completed') {
      this.set('waiting');
      this.kimiUserStopped = true;
    } else this.set('running', reason === 'cancelled' ? 'turn_interrupted' : 'turn_failed');
    return true;
  }

  exit(): void {
    this.exited = true;
    this.pending.clear();
    if (this.current) this.current = { ...this.current, activity: 'exited', reason: 'agent_exited', pendingTools: [] };
  }

  apply(event: HookEnvelope, agentRunId: string): AgentView | null {
    if (!this.binding || this.exited || this.binding.instanceId !== event.instanceId
      || this.binding.agentRunId !== agentRunId || this.seenEvents.has(event.eventId)) return this.view;
    const p = event.payload;
    const name = field(p, 'hook_event_name');
    const sessionId = field(p, 'session_id');
    if (!name || !sessionId || isSubagentEvent(p)) return this.view;
    if (name === 'StatusLine') return this.view;
    const at = Number.isSafeInteger(event.hookStartedAt) && event.hookStartedAt! > 0
      && event.hookStartedAt! <= Date.now() + 1000 ? event.hookStartedAt! : 0;
    // Capture time is assigned before CLI stdin/transport waits, not on arrival.
    // Synchronous Claude hooks have no native turn ID. Ignore older invocations.
    if (at && at < this.lastHookAt) return this.view;

    const sessionKey = `${event.provider}:${sessionId}`;
    if (this.retiredSessions.has(sessionKey)) return this.view;
    if (this.current && (this.current.provider !== event.provider || this.current.agentSessionId !== sessionId)) {
      // Only a newly observed SessionStart may switch agent conversation in the same process.
      if (name !== 'SessionStart') return this.view;
      this.retiredSessions.add(`${this.current.provider}:${this.current.agentSessionId}`);
      this.retiredTurns.clear();
      this.pending.clear();
      this.hasSubmitted = false;
      this.tools.clear();
      this.kimiUserStopped = false;
      this.kimiTurn = undefined;
      this.submittedAt = 0;
      this.current = null;
    }
    this.seenEvents.add(event.eventId);
    if (!this.current) {
      this.current = {
        provider: event.provider, agentSessionId: sessionId, agentRunId,
        activity: 'running', pendingTools: [], reason: 'awaiting_activity_evidence',
      };
    }
    if (name === 'PostModelRequest') return this.view; // Usage is diagnostic, not completion evidence.
    // Kimi emits TurnStarted asynchronously, while UserPromptSubmit/Stop are
    // synchronous. A late notification cannot reopen the already closed input.
    if (event.provider === 'kimi' && name === 'TurnStarted' && p.origin_kind === 'user' && this.kimiUserStopped) return this.view;

    const turnId = field(p, 'turn_id');
    if (turnId && this.retiredTurns.has(turnId)) return this.view;
    if (isPromptEvent(event.provider, p) || (event.provider === 'kimi' && name === 'TurnStarted')) {
      this.kimiUserStopped = false;
      if (event.provider === 'kimi') {
        // The CLI normalizes Kimi's numeric turn_id to a decimal string.
        this.kimiTurn = name === 'TurnStarted' && turnId && /^\d{1,15}$/.test(turnId) ? Number(turnId) : undefined;
      }
      if (at) this.lastHookAt = at;
      if (this.current.turnId && turnId !== this.current.turnId) this.retiredTurns.add(this.current.turnId);
      this.current.turnId = turnId;
      this.hasSubmitted = true;
      this.submittedAt = at;
      this.pending.clear();
      this.tools.clear();
      this.set('working');
      return this.view;
    }
    if (turnId && this.current.turnId && turnId !== this.current.turnId) return this.view;
    if (turnId && !this.current.turnId) this.current.turnId = turnId;
    if (at) this.lastHookAt = at;

    switch (name) {
      case 'SessionStart':
        // Resume/compact can announce the same session while a turn is still working.
        break;
      case 'PermissionRequest': {
        const matching = [...this.tools].filter(([, name]) => name === field(p, 'tool_name'));
        const toolId = field(p, 'tool_use_id') ?? (matching.length === 1 ? matching[0][0] : undefined);
        this.pending.add(toolId ?? `unresolved:${event.eventId}`);
        this.set('permission', toolId ? undefined : 'permission_has_no_tool_id');
        break;
      }
      case 'Notification': {
        const kind = field(p, 'notification_type');
        if (kind === 'permission_prompt') {
          this.pending.add(field(p, 'tool_use_id') ?? 'unresolved:notification');
          this.set('permission', field(p, 'tool_use_id') ? undefined : 'permission_has_no_tool_id');
        } else if (kind === 'idle_prompt') {
          // A delayed notification without a turn cannot end a newer working turn. Claude sends
          // idle_prompt about 60 s after Stop with no turn id; its hook time places it after the submit.
          if (!this.endsCurrentTurn(event, turnId, at)) {
            if (this.pending.size === 0) this.set('running', 'idle_without_turn_correlation');
            break;
          }
          this.pending.clear();
          this.set('waiting');
        }
        break;
      }
      case 'PostToolUse':
      case 'PermissionResult':
      case 'PostToolUseFailure': {
        if (name === 'PermissionResult' && event.provider !== 'kimi') break;
        const toolId = field(p, 'tool_use_id');
        if (toolId) this.pending.delete(toolId);
        if (toolId && name !== 'PermissionResult') this.tools.delete(toolId);
        if (this.pending.size > 0) {
          this.set('permission', 'other_permission_still_pending');
        } else if (name === 'PostToolUseFailure' && p.is_interrupt === true) {
          this.set('running', 'tool_interrupted');
        } else this.set('working');
        break;
      }
      case 'PreToolUse':
        if (field(p, 'tool_use_id') && field(p, 'tool_name')) this.tools.set(field(p, 'tool_use_id')!, field(p, 'tool_name')!);
        if (this.pending.size === 0) this.set('working');
        break;
      case 'PreModelRequest':
      case 'PreInvocation':
        if (this.pending.size === 0) this.set('working');
        break;
      case 'PermissionDenied': {
        // Claude's event describes auto-mode denial, not a manual dialog response.
        if (event.provider !== 'claude' || p.permission_mode !== 'auto') break;
        const toolId = field(p, 'tool_use_id');
        if (toolId) this.pending.delete(toolId);
        if (this.pending.size === 0) this.set('running', 'auto_permission_denied');
        break;
      }
      case 'Stop':
        if (!this.endsCurrentTurn(event, turnId, at)) {
          this.set(this.pending.size > 0 ? 'permission' : 'running', 'stop_without_turn_correlation');
          break;
        }
        if (p.stop_hook_active === true || (Array.isArray(p.background_tasks) && p.background_tasks.length > 0)
          || (Array.isArray(p.session_crons) && p.session_crons.length > 0)
          || (event.provider === 'agy' && p.fullyIdle === false)) {
          if (this.pending.size === 0) this.set('running', 'stop_may_continue');
          break;
        }
        if (event.provider === 'agy' && p.terminationReason === 'USER_CANCELED') {
          this.pending.clear();
          this.set('running', 'turn_interrupted');
          break;
        }
        if (event.provider === 'agy' && p.terminationReason === 'ERROR') {
          this.pending.clear();
          this.set('running', 'turn_failed');
          break;
        }
        this.pending.clear();
        this.set('waiting');
        if (event.provider === 'kimi') this.kimiUserStopped = true;
        break;
      case 'Interrupt':
        if (event.provider !== 'codex' && event.provider !== 'kimi') break;
        this.pending.clear();
        this.set('running', 'turn_interrupted');
        break;
      case 'StopFailure':
        if (event.provider !== 'claude' && event.provider !== 'kimi') break;
        this.pending.clear();
        this.set('running', 'turn_failed');
        break;
      case 'SessionEnd':
        this.pending.clear();
        this.set('running', 'session_ended_process_probe_required');
        break;
      default:
        // Unknown events cannot clear verified work or outstanding permission facts.
        break;
    }
    return this.view;
  }

  // A completion signal belongs to the latest submitted turn when it names that turn, or, for the
  // synchronous Claude, Kimi and Antigravity hooks that carry no turn id, when it started after the submit.
  private endsCurrentTurn(event: HookEnvelope, turnId: string | undefined, at: number): boolean {
    return !this.hasSubmitted || Boolean(turnId) || ((event.provider === 'claude' || event.provider === 'kimi' || event.provider === 'agy')
      && Boolean(at) && Boolean(this.submittedAt) && at >= this.submittedAt);
  }

  private set(activity: AgentView['activity'], reason?: string): void {
    if (!this.current) return;
    this.current.activity = activity;
    this.current.reason = reason;
    this.current.pendingTools = [...this.pending];
  }
}
