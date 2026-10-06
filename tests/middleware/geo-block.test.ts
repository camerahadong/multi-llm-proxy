import { describe, expect, it } from 'vitest';
import { geoDecision } from '../../src/middleware/geo-block.js';

const cfg = { enabled: true, allowCountries: ['VN'], allowIps: ['180.93.3.29'] };
const req = (headers: Record<string, string>, remote = '127.0.0.1') =>
  ({ headers, socket: { remoteAddress: remote } }) as any;

describe('geoDecision', () => {
  it('allows Vietnam via Cloudflare', () => {
    expect(geoDecision(req({ 'cf-connecting-ip': '14.161.1.1', 'cf-ipcountry': 'VN' }), cfg).allow).toBe(true);
  });
  it('blocks foreign countries with a clear reason', () => {
    const d = geoDecision(req({ 'cf-connecting-ip': '8.8.8.8', 'cf-ipcountry': 'US' }), cfg);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/Việt Nam.*US/);
  });
  it('blocks Tor / unknown (T1, XX)', () => {
    expect(geoDecision(req({ 'cf-connecting-ip': '1.2.3.4', 'cf-ipcountry': 'T1' }), cfg).allow).toBe(false);
  });
  it('blocks public IPs without a country header (cannot verify)', () => {
    expect(geoDecision(req({ 'x-real-ip': '8.8.4.4' }), cfg).allow).toBe(false);
  });
  it('always allows LAN / localhost', () => {
    expect(geoDecision(req({}, '192.168.1.50'), cfg).allow).toBe(true);
    expect(geoDecision(req({}), cfg).allow).toBe(true);
  });
  it('allows allow-listed IPs (own VPS)', () => {
    expect(geoDecision(req({ 'x-real-ip': '180.93.3.29' }), cfg).allow).toBe(true);
  });
  it('a spoofed X-Real-IP cannot override Cloudflare-provided IP', () => {
    const d = geoDecision(req({ 'cf-connecting-ip': '8.8.8.8', 'x-real-ip': '192.168.1.5', 'cf-ipcountry': 'US' }), cfg);
    expect(d.allow).toBe(false);
  });
  it('does nothing when disabled', () => {
    expect(geoDecision(req({ 'cf-connecting-ip': '8.8.8.8', 'cf-ipcountry': 'US' }), { ...cfg, enabled: false }).allow).toBe(true);
  });
});
