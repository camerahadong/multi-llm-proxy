/**
 * Fixed-size ring buffer of numeric samples. Used for latency percentile tracking.
 * O(1) push, O(n log n) percentile via lazy-sorted copy.
 */
export class LatencyRing {
  private buf: number[];
  private idx = 0;
  private filled = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(sample: number): void {
    this.buf[this.idx] = sample;
    this.idx = (this.idx + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  size(): number {
    return this.filled;
  }

  percentile(p: number): number {
    if (this.filled === 0) return 0;
    const sorted = this.buf.slice(0, this.filled).sort((a, b) => a - b);
    const rank = Math.min(this.filled - 1, Math.max(0, Math.floor((p / 100) * this.filled)));
    return sorted[rank];
  }

  p50(): number {
    return this.percentile(50);
  }

  p95(): number {
    return this.percentile(95);
  }
}
