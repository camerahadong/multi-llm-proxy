/**
 * Reproduce the BIBPIX-style concurrency test: N calls × M workers.
 * Usage: tsx scripts/bench-pool.ts [n=30] [workers=5] [model=gemini-2.5-flash]
 */
import { performance } from 'node:perf_hooks';

const PORT = process.env.PORT ?? '3456';
const URL = `http://127.0.0.1:${PORT}/v1/chat/completions`;
const API_KEY = process.env.PROXY_API_KEY ?? '';

const n = parseInt(process.argv[2] ?? '30', 10);
const workers = parseInt(process.argv[3] ?? '5', 10);
const model = process.argv[4] ?? 'gemini-2.5-flash';

async function callOne(idx: number): Promise<{ idx: number; ms: number; ok: boolean; status: number }> {
  const t0 = performance.now();
  try {
    const resp = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `Reply with just the number ${idx}` }],
      }),
    });
    await resp.text();
    return { idx, ms: performance.now() - t0, ok: resp.ok, status: resp.status };
  } catch (err) {
    return { idx, ms: performance.now() - t0, ok: false, status: 0 };
  }
}

async function runWorkers(): Promise<void> {
  const queue = Array.from({ length: n }, (_, i) => i);
  const results: Array<Awaited<ReturnType<typeof callOne>>> = [];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length) {
        const idx = queue.shift()!;
        results.push(await callOne(idx));
      }
    }),
  );
  const wall = performance.now() - t0;

  const ok = results.filter((r) => r.ok).length;
  const fails = results.filter((r) => !r.ok);
  const latencies = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  console.log(`\n── ${n} calls × ${workers} workers × ${model} ──`);
  console.log(`wall:  ${(wall / 1000).toFixed(1)}s`);
  console.log(`ok:    ${ok}/${n}`);
  console.log(`p50:   ${p50.toFixed(0)}ms  p95: ${p95.toFixed(0)}ms`);
  console.log(`tput:  ${(n / (wall / 60_000)).toFixed(1)} call/min`);
  if (fails.length) {
    const byStatus = new Map<number, number>();
    fails.forEach((f) => byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1));
    console.log(`fail:`, Object.fromEntries(byStatus));
  }
}

runWorkers().catch((err) => {
  console.error(err);
  process.exit(1);
});
