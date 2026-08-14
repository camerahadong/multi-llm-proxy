import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from '../config/runtime.js';
import { logger } from '../lib/logger.js';
import {
  CodexAppServerClient,
  type AppServerMessage,
  type RpcId,
} from './app-server-client.js';

export type AgentSandbox = 'read-only' | 'workspace-write';
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ApprovalDecision = 'accept' | 'decline' | 'cancel';

export type AgentInput =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: 'localImage'; path: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: 'audio'; url: string }
  | { type: 'localAudio'; path: string };

export interface CreateAgentSessionInput {
  cwd?: string;
  model?: string;
  sandbox?: AgentSandbox;
  networkAccess?: boolean;
  effort?: AgentEffort;
  resumeThreadId?: string;
}

export interface StartAgentTurnInput {
  input: AgentInput[];
  effort?: AgentEffort;
}

export interface AgentEvent {
  seq: number;
  time: string;
  kind: 'notification' | 'request' | 'system';
  method: string;
  params: unknown;
}

export interface PendingAgentRequest {
  id: string;
  method: string;
  params: unknown;
  createdAt: string;
}

export interface AgentSessionView {
  id: string;
  threadId: string;
  cwd: string;
  model: string;
  sandbox: AgentSandbox;
  networkAccess: boolean;
  effort: AgentEffort;
  status: 'idle' | 'running' | 'disconnected';
  activeTurnId: string | null;
  createdAt: string;
  lastActivityAt: string;
  pendingRequests: PendingAgentRequest[];
  nextEventSeq: number;
}

interface InternalPendingRequest extends PendingAgentRequest {
  rpcId: RpcId;
}

interface AgentSession extends Omit<AgentSessionView, 'pendingRequests' | 'nextEventSeq'> {
  generation: number;
  nextSeq: number;
  events: AgentEvent[];
  pending: Map<string, InternalPendingRequest>;
  subscribers: Set<(event: AgentEvent) => void>;
}

interface ThreadStartResult {
  thread?: { id?: string };
}

interface TurnStartResult {
  turn?: { id?: string; status?: string };
}

export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'invalid_agent_request',
  ) {
    super(message);
    this.name = 'AgentApiError';
  }
}

const isInside = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;

function extractThreadId(params: unknown): string | null {
  const obj = asObject(params);
  if (!obj) return null;
  if (typeof obj.threadId === 'string') return obj.threadId;
  const thread = asObject(obj.thread);
  if (thread && typeof thread.id === 'string') return thread.id;
  return null;
}

function extractTurnId(params: unknown): string | null {
  const obj = asObject(params);
  if (!obj) return null;
  if (typeof obj.turnId === 'string') return obj.turnId;
  const turn = asObject(obj.turn);
  if (turn && typeof turn.id === 'string') return turn.id;
  return null;
}

export class AgentService {
  private readonly client: CodexAppServerClient;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionByThread = new Map<string, string>();
  private creatingSessions = 0;
  private cleanupTimer: NodeJS.Timeout;

  constructor(private readonly runtime: RuntimeConfig) {
    this.client = new CodexAppServerClient(
      () => this.runtime.get().agent.codexCommand,
      () => this.runtime.get().agent.rpcTimeoutSeconds * 1000,
    );
    this.client.on('notification', (message: AppServerMessage) => this.onNotification(message));
    this.client.on('serverRequest', (message: AppServerMessage) => this.onServerRequest(message));
    this.client.on('disconnected', (error: Error) => this.onDisconnected(error));
    this.cleanupTimer = setInterval(() => void this.cleanupExpired(), 60_000);
    this.cleanupTimer.unref?.();
  }

  status(): { enabled: boolean; connected: boolean; sessions: number; maxSessions: number } {
    const config = this.runtime.get().agent;
    return {
      enabled: config.enabled,
      connected: this.client.connected,
      sessions: this.sessions.size,
      maxSessions: config.maxSessions,
    };
  }

  listSessions(): AgentSessionView[] {
    return [...this.sessions.values()].map((session) => this.view(session));
  }

  getSession(id: string): AgentSessionView {
    return this.view(this.requireSession(id));
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSessionView> {
    const config = this.assertEnabled();
    if (this.sessions.size + this.creatingSessions >= config.maxSessions) {
      throw new AgentApiError('Maximum number of agent sessions reached', 429, 'agent_session_limit');
    }

    const cwd = this.resolveDirectory(input.cwd ?? config.defaultCwd, config.allowedRoots, 'cwd');
    const sandbox = input.sandbox ?? config.defaultSandbox;
    if (sandbox === 'workspace-write') {
      this.assertWithinRoots(cwd, config.writableRoots, 'cwd is not inside an allowed writable root');
    }
    const networkAccess = input.networkAccess ?? false;
    if (networkAccess && !config.allowNetwork) {
      throw new AgentApiError('Network access is disabled for agent sessions', 403, 'agent_network_disabled');
    }
    const model = input.model ?? config.defaultModel;
    if (!config.allowedModels.includes(model)) {
      throw new AgentApiError(`Model is not allowed for agent sessions: ${model}`, 400, 'agent_model_not_allowed');
    }
    const effort = input.effort ?? 'medium';

    this.creatingSessions += 1;
    try {
      await this.client.ensureStarted();
      const common = {
        model,
        cwd,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox,
        runtimeWorkspaceRoots: [cwd],
      };
      const result = input.resumeThreadId
        ? await this.client.request<ThreadStartResult>('thread/resume', {
          ...common,
          threadId: input.resumeThreadId,
        })
        : await this.client.request<ThreadStartResult>('thread/start', {
          ...common,
          serviceName: 'multi-llm-proxy-agent',
          ephemeral: false,
          developerInstructions:
            'This thread is controlled through an authenticated remote agent API. Stay within the configured workspace, never disclose credentials or secret values, and request approval before any operation that needs elevated access.',
        });

      const threadId = result.thread?.id;
      if (!threadId) throw new AgentApiError('Codex App Server returned no thread id', 502, 'agent_protocol_error');
      if (this.sessionByThread.has(threadId)) {
        throw new AgentApiError('This Codex thread is already attached to another session', 409, 'agent_thread_in_use');
      }

      const now = new Date().toISOString();
      const session: AgentSession = {
        id: randomUUID(),
        threadId,
        cwd,
        model,
        sandbox,
        networkAccess,
        effort,
        status: 'idle',
        activeTurnId: null,
        createdAt: now,
        lastActivityAt: now,
        generation: this.client.generation,
        nextSeq: 1,
        events: [],
        pending: new Map(),
        subscribers: new Set(),
      };
      this.sessions.set(session.id, session);
      this.sessionByThread.set(threadId, session.id);
      this.record(session, 'system', 'proxy/sessionCreated', {
        sessionId: session.id,
        threadId,
        resumed: Boolean(input.resumeThreadId),
      });
      return this.view(session);
    } finally {
      this.creatingSessions -= 1;
    }
  }

  async startTurn(sessionId: string, body: StartAgentTurnInput): Promise<{ turnId: string; status: string }> {
    this.assertEnabled();
    const session = this.requireSession(sessionId);
    if (session.activeTurnId) {
      throw new AgentApiError('A turn is already running; use /steer or interrupt it first', 409, 'agent_turn_running');
    }
    await this.ensureSessionAttached(session);
    const input = this.validateInput(session, body.input);
    const effort = body.effort ?? session.effort;
    const result = await this.client.request<TurnStartResult>('turn/start', {
      threadId: session.threadId,
      input,
      cwd: session.cwd,
      model: session.model,
      effort,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: this.sandboxPolicy(session),
      runtimeWorkspaceRoots: [session.cwd],
    });
    const turnId = result.turn?.id;
    if (!turnId) throw new AgentApiError('Codex App Server returned no turn id', 502, 'agent_protocol_error');
    session.activeTurnId = turnId;
    session.status = 'running';
    session.lastActivityAt = new Date().toISOString();
    this.record(session, 'system', 'proxy/turnAccepted', { turnId });
    return { turnId, status: result.turn?.status ?? 'inProgress' };
  }

  async steer(sessionId: string, input: AgentInput[]): Promise<{ turnId: string }> {
    this.assertEnabled();
    const session = this.requireSession(sessionId);
    if (!session.activeTurnId) {
      throw new AgentApiError('There is no active turn to steer', 409, 'agent_no_active_turn');
    }
    await this.ensureSessionAttached(session);
    await this.client.request('turn/steer', {
      threadId: session.threadId,
      expectedTurnId: session.activeTurnId,
      input: this.validateInput(session, input),
    });
    session.lastActivityAt = new Date().toISOString();
    this.record(session, 'system', 'proxy/turnSteered', { turnId: session.activeTurnId });
    return { turnId: session.activeTurnId };
  }

  async interrupt(sessionId: string): Promise<{ interrupted: boolean; turnId: string | null }> {
    const session = this.requireSession(sessionId);
    const turnId = session.activeTurnId;
    if (!turnId) return { interrupted: false, turnId: null };
    await this.ensureSessionAttached(session);
    await this.client.request('turn/interrupt', { threadId: session.threadId, turnId });
    session.lastActivityAt = new Date().toISOString();
    this.record(session, 'system', 'proxy/turnInterruptRequested', { turnId });
    return { interrupted: true, turnId };
  }

  async respondToRequest(
    sessionId: string,
    requestId: string,
    body: { decision?: ApprovalDecision; result?: unknown },
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const pending = session.pending.get(requestId);
    if (!pending) throw new AgentApiError('Pending request not found', 404, 'agent_request_not_found');
    await this.ensureSessionAttached(session);

    let response: unknown;
    if (pending.method === 'item/commandExecution/requestApproval'
      || pending.method === 'item/fileChange/requestApproval') {
      if (!body.decision || !['accept', 'decline', 'cancel'].includes(body.decision)) {
        throw new AgentApiError('decision must be accept, decline, or cancel');
      }
      response = { decision: body.decision };
    } else {
      if (!Object.prototype.hasOwnProperty.call(body, 'result')) {
        throw new AgentApiError('result is required for this request type');
      }
      const serialized = JSON.stringify(body.result);
      if (serialized.length > 100_000) throw new AgentApiError('Response is too large');
      response = body.result;
    }

    this.client.respond(pending.rpcId, response);
    session.pending.delete(requestId);
    session.lastActivityAt = new Date().toISOString();
    this.record(session, 'system', 'proxy/requestResolved', {
      requestId,
      method: pending.method,
      decision: body.decision,
    });
  }

  getEvents(sessionId: string, after = 0, limit = 500): {
    events: AgentEvent[];
    nextSeq: number;
    replayGap: boolean;
  } {
    const session = this.requireSession(sessionId);
    session.lastActivityAt = new Date().toISOString();
    const firstSeq = session.events[0]?.seq ?? session.nextSeq;
    const events = session.events.filter((event) => event.seq > after).slice(0, limit);
    return {
      events,
      nextSeq: events.at(-1)?.seq ?? after,
      replayGap: after > 0 && after < firstSeq - 1,
    };
  }

  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void {
    const session = this.requireSession(sessionId);
    session.subscribers.add(listener);
    session.lastActivityAt = new Date().toISOString();
    return () => session.subscribers.delete(listener);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (this.client.connected && session.generation === this.client.generation) {
      if (session.activeTurnId) {
        await this.client.request('turn/interrupt', {
          threadId: session.threadId,
          turnId: session.activeTurnId,
        }).catch(() => undefined);
      }
      for (const pending of session.pending.values()) {
        if (pending.method.includes('requestApproval')) {
          this.client.respond(pending.rpcId, { decision: 'cancel' });
        } else {
          this.client.respondError(pending.rpcId, -32001, 'Agent session closed');
        }
      }
      await this.client.request('thread/unsubscribe', { threadId: session.threadId }).catch(() => undefined);
    }
    this.sessions.delete(sessionId);
    this.sessionByThread.delete(session.threadId);
    session.subscribers.clear();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.deleteSession(id).catch(() => undefined);
    await this.client.shutdown();
  }

  private assertEnabled() {
    const config = this.runtime.get().agent;
    if (!config.enabled) {
      throw new AgentApiError('Agent API is disabled', 503, 'agent_disabled');
    }
    return config;
  }

  private requireSession(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new AgentApiError('Agent session not found', 404, 'agent_session_not_found');
    return session;
  }

  private resolveDirectory(input: string, roots: string[], label: string): string {
    let resolved: string;
    try {
      resolved = realpathSync(path.resolve(input));
      if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new AgentApiError(`${label} does not exist or is not a directory`);
    }
    this.assertWithinRoots(resolved, roots, `${label} is outside the configured allowed roots`);
    return resolved;
  }

  private assertWithinRoots(candidate: string, roots: string[], message: string): void {
    const realRoots = roots.flatMap((root) => {
      try {
        const real = realpathSync(path.resolve(root));
        return statSync(real).isDirectory() ? [real] : [];
      } catch {
        return [];
      }
    });
    if (!realRoots.some((root) => isInside(candidate, root))) {
      throw new AgentApiError(message, 403, 'agent_path_not_allowed');
    }
  }

  private validateInput(session: AgentSession, input: AgentInput[]): AgentInput[] {
    if (input.length === 0) throw new AgentApiError('input must contain at least one item');
    return input.map((item) => {
      if (item.type !== 'localImage' && item.type !== 'localAudio') return item;
      let resolved: string;
      try {
        resolved = realpathSync(path.resolve(session.cwd, item.path));
        if (!statSync(resolved).isFile()) throw new Error('not a file');
      } catch {
        throw new AgentApiError(`${item.type} path does not exist or is not a file`);
      }
      if (!isInside(resolved, session.cwd)) {
        throw new AgentApiError(`${item.type} path must be inside the session cwd`, 403, 'agent_path_not_allowed');
      }
      return { ...item, path: resolved };
    });
  }

  private sandboxPolicy(session: AgentSession): Record<string, unknown> {
    if (session.sandbox === 'read-only') {
      return { type: 'readOnly', networkAccess: session.networkAccess };
    }
    return {
      type: 'workspaceWrite',
      writableRoots: [session.cwd],
      networkAccess: session.networkAccess,
    };
  }

  private async ensureSessionAttached(session: AgentSession): Promise<void> {
    await this.client.ensureStarted();
    if (session.generation === this.client.generation) return;
    await this.client.request<ThreadStartResult>('thread/resume', {
      threadId: session.threadId,
      model: session.model,
      cwd: session.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: session.sandbox,
      runtimeWorkspaceRoots: [session.cwd],
    });
    session.generation = this.client.generation;
    session.status = 'idle';
    session.activeTurnId = null;
    session.pending.clear();
    this.record(session, 'system', 'proxy/sessionReconnected', { threadId: session.threadId });
  }

  private onNotification(message: AppServerMessage): void {
    if (!message.method) return;
    const threadId = extractThreadId(message.params);
    if (!threadId) return;
    const sessionId = this.sessionByThread.get(threadId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return;

    const turnId = extractTurnId(message.params);
    if (message.method === 'turn/started' && turnId) {
      session.activeTurnId = turnId;
      session.status = 'running';
    } else if (message.method === 'turn/completed') {
      session.activeTurnId = null;
      session.status = 'idle';
    }
    session.lastActivityAt = new Date().toISOString();
    this.record(session, 'notification', message.method, message.params ?? {});
  }

  private onServerRequest(message: AppServerMessage): void {
    if (message.id === undefined || !message.method) return;
    const threadId = extractThreadId(message.params);
    const sessionId = threadId ? this.sessionByThread.get(threadId) : undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      this.client.respondError(message.id, -32000, 'No attached proxy session for server request');
      return;
    }

    const request: InternalPendingRequest = {
      id: randomUUID(),
      rpcId: message.id,
      method: message.method,
      params: message.params ?? {},
      createdAt: new Date().toISOString(),
    };
    session.pending.set(request.id, request);
    session.lastActivityAt = request.createdAt;
    this.record(session, 'request', message.method, {
      requestId: request.id,
      params: request.params,
    });
  }

  private onDisconnected(error: Error): void {
    for (const session of this.sessions.values()) {
      session.status = 'disconnected';
      session.activeTurnId = null;
      session.pending.clear();
      this.record(session, 'system', 'proxy/disconnected', { message: error.message });
    }
  }

  private record(
    session: AgentSession,
    kind: AgentEvent['kind'],
    method: string,
    params: unknown,
  ): void {
    const event: AgentEvent = {
      seq: session.nextSeq++,
      time: new Date().toISOString(),
      kind,
      method,
      params,
    };
    session.events.push(event);
    const maxEvents = this.runtime.get().agent.maxEventsPerSession;
    if (session.events.length > maxEvents) {
      session.events.splice(0, session.events.length - maxEvents);
    }
    for (const subscriber of session.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        logger.warn({ err: (error as Error).message }, 'agent event subscriber failed');
      }
    }
  }

  private view(session: AgentSession): AgentSessionView {
    return {
      id: session.id,
      threadId: session.threadId,
      cwd: session.cwd,
      model: session.model,
      sandbox: session.sandbox,
      networkAccess: session.networkAccess,
      effort: session.effort,
      status: session.status,
      activeTurnId: session.activeTurnId,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      pendingRequests: [...session.pending.values()].map(({ rpcId: _rpcId, ...request }) => request),
      nextEventSeq: session.nextSeq,
    };
  }

  private async cleanupExpired(): Promise<void> {
    const ttlMs = this.runtime.get().agent.sessionTtlSeconds * 1000;
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - Date.parse(session.lastActivityAt) > ttlMs) {
        await this.deleteSession(session.id).catch((error) => {
          logger.warn({ sessionId: session.id, err: (error as Error).message }, 'failed to expire agent session');
        });
      }
    }
  }
}
