import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from '../lib/logger.js';

export type RpcId = number | string;

export interface AppServerMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AppServerRpcError';
  }
}

const rpcKey = (id: RpcId): string => `${typeof id}:${String(id)}`;

/**
 * Minimal, allow-list-friendly Codex App Server transport. It intentionally
 * exposes request()/respond() instead of a raw HTTP bridge so callers cannot
 * invoke unsafe protocol methods such as thread/shellCommand.
 */
export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = '';
  private stopping = false;
  private processGeneration = 0;

  constructor(
    private readonly command: () => string,
    private readonly timeoutMs: () => number,
  ) {
    super();
  }

  get connected(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  get generation(): number {
    return this.processGeneration;
  }

  async ensureStarted(): Promise<void> {
    if (this.connected) return;
    if (this.starting) return this.starting;
    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params);
  }

  notify(method: string, params?: unknown): void {
    if (!this.connected) throw new Error('Codex App Server is not connected');
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: RpcId, result: unknown): void {
    if (!this.connected) throw new Error('Codex App Server is not connected');
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    if (!this.connected) return;
    this.write({ id, error: { code, message } });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.rejectAll(new Error('Codex App Server stopped'));
    if (!child || child.exitCode !== null) return;

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 2000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async startProcess(): Promise<void> {
    this.stopping = false;
    const child = spawn(this.command(), ['app-server', '--stdio'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child = child;
    this.stdoutBuffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim().slice(0, 2000);
      if (message) logger.warn({ message }, 'codex app-server stderr');
    });
    child.once('error', (error) => this.onExit(child, error));
    child.once('exit', (code, signal) => {
      const error = new Error(`Codex App Server exited (${signal ?? code ?? 'unknown'})`);
      this.onExit(child, error);
    });

    try {
      await this.sendRequest('initialize', {
        clientInfo: {
          name: 'multi-llm-proxy',
          title: 'Multi LLM Proxy Agent API',
          version: '2.1.0',
        },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized');
      this.processGeneration += 1;
      this.emit('connected', this.processGeneration);
    } catch (error) {
      if (this.child === child) {
        this.child = null;
        if (child.exitCode === null) child.kill('SIGTERM');
      }
      throw error;
    }
  }

  private sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('Codex App Server is not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcKey(id));
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.timeoutMs());
      timer.unref?.();
      this.pending.set(rpcKey(id), {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(rpcKey(id));
        reject(error as Error);
      }
    });
  }

  private write(message: AppServerMessage): void {
    if (!this.child?.stdin.writable) throw new Error('Codex App Server stdin is unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > 20 * 1024 * 1024) {
      this.onProtocolError(new Error('Codex App Server emitted an oversized JSONL frame'));
      return;
    }

    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch {
      logger.warn({ line: line.slice(0, 500) }, 'ignored non-JSON app-server output');
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit('serverRequest', message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(rpcKey(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(rpcKey(message.id));
      if (message.error) {
        pending.reject(new AppServerRpcError(
          message.error.message ?? 'Codex App Server RPC error',
          message.error.code,
          message.error.data,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) this.emit('notification', message);
  }

  private onProtocolError(error: Error): void {
    logger.error({ err: error.message }, 'codex app-server protocol error');
    const child = this.child;
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }

  private onExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.rejectAll(error);
    if (!this.stopping) {
      logger.error({ err: error.message }, 'codex app-server disconnected');
      this.emit('disconnected', error);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
