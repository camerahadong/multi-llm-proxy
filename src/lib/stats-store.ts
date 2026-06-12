import { appendFile, appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

export interface DailyStats {
  requests: number;
  tokens: number;
  cost: number;
  errors: number;
}

export interface AppStats {
  requests: number;
  tokens: number;
  cost: number;
}

export interface StatsShape {
  daily: Record<string, DailyStats>;
  apps: Record<string, AppStats>;
  total: { requests: number; tokens: number; cost: number };
}

export interface TrackInput {
  app: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  duration: number;
  success: boolean;
  ip?: string;
  userAgent?: string;
}

export class StatsStore {
  private stats: StatsShape;
  private flushTimer: NodeJS.Timeout | null = null;
  private logBuf: string[] = [];
  private logFlushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly statsFile: string,
    private readonly logFile: string,
    private readonly enableLogging: () => boolean,
  ) {
    mkdirSync(path.dirname(statsFile), { recursive: true });
    this.stats = this.load();
    this.cleanOld();
  }

  private load(): StatsShape {
    try {
      return JSON.parse(readFileSync(this.statsFile, 'utf-8')) as StatsShape;
    } catch {
      return { daily: {}, apps: {}, total: { requests: 0, tokens: 0, cost: 0 } };
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, 5000);
    this.flushTimer.unref?.();
  }

  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2));
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'stats flush failed');
    }
    this.flushLogSync();
  }

  /** Buffered access-log writes: append goes through an in-memory buffer flushed
   * async every 2s (or at 200 lines) so the request path never blocks on disk. */
  private queueLogLine(line: string): void {
    this.logBuf.push(line);
    if (this.logBuf.length >= 200) {
      this.flushLog();
      return;
    }
    if (this.logFlushTimer) return;
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = null;
      this.flushLog();
    }, 2000);
    this.logFlushTimer.unref?.();
  }

  private flushLog(): void {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    if (this.logBuf.length === 0) return;
    const chunk = this.logBuf.join('');
    this.logBuf = [];
    appendFile(this.logFile, chunk, (err) => {
      if (err) logger.error({ err: err.message }, 'log append failed');
    });
  }

  private flushLogSync(): void {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    if (this.logBuf.length === 0) return;
    const chunk = this.logBuf.join('');
    this.logBuf = [];
    try {
      appendFileSync(this.logFile, chunk);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'log append failed');
    }
  }

  private cleanOld(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const day of Object.keys(this.stats.daily)) {
      if (day < cutoffStr) delete this.stats.daily[day];
    }
    this.scheduleFlush();
  }

  track(input: TrackInput): void {
    const today = new Date().toISOString().slice(0, 10);
    const tokens = input.inputTokens + input.outputTokens;

    const daily = this.stats.daily[today] ?? (this.stats.daily[today] = {
      requests: 0,
      tokens: 0,
      cost: 0,
      errors: 0,
    });
    daily.requests++;
    daily.tokens += tokens;
    daily.cost += input.cost;
    if (!input.success) daily.errors++;

    const app = input.app || 'unknown';
    const appStats = this.stats.apps[app] ?? (this.stats.apps[app] = {
      requests: 0,
      tokens: 0,
      cost: 0,
    });
    appStats.requests++;
    appStats.tokens += tokens;
    appStats.cost += input.cost;

    this.stats.total.requests++;
    this.stats.total.tokens += tokens;
    this.stats.total.cost += input.cost;

    this.scheduleFlush();

    if (this.enableLogging()) {
      const ip = input.ip ?? '-';
      const ua = (input.userAgent ?? '-').replace(/\|/g, '/').slice(0, 80);
      const line = `${new Date().toISOString()} | ${app} | ${ip} | ${input.model} | in=${input.inputTokens} out=${input.outputTokens} | $${input.cost.toFixed(4)} | ${input.duration}ms | ${input.success ? 'OK' : 'ERR'} | ${ua}\n`;
      this.queueLogLine(line);
    }
  }

  /**
   * Log a denied request (auth failure / rate limit) to the access log without
   * touching billing stats. Makes probing / key-guessing attempts visible.
   */
  logDenied(input: { app?: string; ip?: string; userAgent?: string; status: number; reason: string }): void {
    if (!this.enableLogging()) return;
    const app = input.app || 'denied';
    const ip = input.ip ?? '-';
    const ua = (input.userAgent ?? '-').replace(/\|/g, '/').slice(0, 80);
    const reason = input.reason.replace(/\|/g, '/').slice(0, 40);
    const line = `${new Date().toISOString()} | ${app} | ${ip} | DENIED:${reason} | in=0 out=0 | $0.0000 | 0ms | ${input.status} | ${ua}\n`;
    this.queueLogLine(line);
  }

  snapshot(): StatsShape {
    return JSON.parse(JSON.stringify(this.stats)) as StatsShape;
  }

  reset(): void {
    this.stats = { daily: {}, apps: {}, total: { requests: 0, tokens: 0, cost: 0 } };
    this.flushSync();
  }

  readLogs(n: number): { total: number; lines: string[] } {
    this.flushLogSync();
    // Read only the tail window — log file grows unbounded and loading it
    // whole would block the event loop and balloon memory.
    const WINDOW = 512 * 1024;
    try {
      const size = statSync(this.logFile).size;
      let text: string;
      if (size > WINDOW) {
        const fd = openSync(this.logFile, 'r');
        try {
          const buf = Buffer.alloc(WINDOW);
          readSync(fd, buf, 0, WINDOW, size - WINDOW);
          text = buf.toString('utf-8');
          text = text.slice(text.indexOf('\n') + 1); // drop partial first line
        } finally {
          closeSync(fd);
        }
      } else {
        text = readFileSync(this.logFile, 'utf-8');
      }
      const all = text.trim().split('\n');
      return { total: all.length, lines: all.slice(-n) };
    } catch {
      return { total: 0, lines: [] };
    }
  }
}
