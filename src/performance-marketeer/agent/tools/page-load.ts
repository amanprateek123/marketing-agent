import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Instagram's Android in-app browser (a WebView) — where most Meta ad clicks land. */
export const INSTAGRAM_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36 Instagram 309.0.0.40.113 Android (33/13; 420dpi; 1080x2400; Google; Pixel 7; panther; panther; en_IN; 541635890) PM-Analyst';

/** A typical Indian 4G connection on a mid-range phone. */
const NETWORK = {
  label: '4G (150 ms latency, 4 Mbps down), phone CPU 4× slower than a laptop',
  latency: 150,
  downloadThroughput: (4 * 1024 * 1024) / 8,
  uploadThroughput: (1 * 1024 * 1024) / 8,
  cpu: 4,
};

/** Google's Core Web Vitals bands for Largest Contentful Paint (the main content showing). */
export function loadVerdict(lcpMs: number | null): 'good' | 'needs work' | 'slow' | 'unknown' {
  if (lcpMs === null) return 'unknown';
  return lcpMs <= 2500 ? 'good' : lcpMs <= 4000 ? 'needs work' : 'slow';
}

export interface PageLoadResult {
  url: string;
  conditions: string;
  /** Server answered (first byte). */
  ttfbMs: number | null;
  /** Anything painted. */
  firstPaintMs: number | null;
  /** The main content painted (usually the hero image or main heading). */
  mainContentMs: number | null;
  domReadyMs: number | null;
  fullyLoadedMs: number | null;
  requests: number;
  transferKB: number;
  verdict: ReturnType<typeof loadVerdict>;
  note: string;
}

type Cdp = {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  on: (method: string, fn: (params: any) => void) => void;
  close: () => void;
};

/** Minimal Chrome DevTools Protocol client over Node's built-in WebSocket. */
async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((ok, fail) => {
    ws.addEventListener('open', () => ok(), { once: true });
    ws.addEventListener('error', () => fail(new Error('DevTools connection failed')), { once: true });
  });
  let id = 0;
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  const listeners = new Map<string, ((p: any) => void)[]>();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.fail(new Error(msg.error.message));
      else p.ok(msg.result);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  });
  return {
    send: (method, params = {}) =>
      new Promise((ok, fail) => {
        const n = ++id;
        pending.set(n, { ok, fail });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    on: (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]),
    close: () => ws.close(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Loads `url` once in headless Chrome posing as Instagram's in-app browser on
 * 4G with a slowed CPU, cache off, trackers unresolvable (`blockedHosts`), and
 * returns how long the page takes to show. ponytail: one cold load, not a
 * median of several; run it again if a number looks off.
 */
export async function measurePageLoad(
  chrome: string,
  url: string,
  blockedHosts: string[],
  timeoutMs = 60_000,
): Promise<PageLoadResult> {
  const profile = await mkdtemp(join(tmpdir(), 'pm-load-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--host-resolver-rules=${blockedHosts.map((h) => `MAP ${h} ~NOTFOUND`).join(', ')}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + timeoutMs;
  let cdp: Cdp | null = null;
  try {
    // Chrome writes its debugging port here once it is up.
    const portFile = join(profile, 'DevToolsActivePort');
    while (!existsSync(portFile)) {
      if (Date.now() > deadline) throw new Error('headless Chrome did not start');
      await sleep(100);
    }
    const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target in headless Chrome');
    cdp = await connect(page.webSocketDebuggerUrl);

    let requests = 0;
    let bytes = 0;
    cdp.on('Network.requestWillBeSent', () => requests++);
    cdp.on('Network.loadingFinished', (p) => (bytes += Number(p.encodedDataLength) || 0));
    const loaded = new Promise<void>((ok) => cdp!.on('Page.loadEventFired', () => ok()));

    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: INSTAGRAM_UA });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: NETWORK.cpu });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: NETWORK.latency,
      downloadThroughput: NETWORK.downloadThroughput,
      uploadThroughput: NETWORK.uploadThroughput,
    });
    await cdp.send('Page.navigate', { url });
    const timedOut = await Promise.race([
      loaded.then(() => false),
      sleep(Math.max(1000, deadline - Date.now() - 5000)).then(() => true),
    ]);
    await sleep(1500); // let late paints land
    const { result } = await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise((done) => {
        const nav = performance.getEntriesByType('navigation')[0] || {};
        const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
        let lcp = null;
        try {
          new PerformanceObserver((l) => { const e = l.getEntries(); if (e.length) lcp = e[e.length - 1].startTime; })
            .observe({ type: 'largest-contentful-paint', buffered: true });
        } catch (e) {}
        setTimeout(() => done({
          ttfb: nav.responseStart || null,
          fcp: fcp ? fcp.startTime : null,
          lcp,
          dom: nav.domContentLoadedEventEnd || null,
          load: nav.loadEventEnd || null,
        }), 300);
      })`,
    });
    const v = result?.value ?? {};
    const ms = (n: unknown) => (typeof n === 'number' && n > 0 ? Math.round(n) : null);
    const mainContentMs = ms(v.lcp);
    return {
      url,
      conditions: NETWORK.label,
      ttfbMs: ms(v.ttfb),
      firstPaintMs: ms(v.fcp),
      mainContentMs,
      domReadyMs: ms(v.dom),
      fullyLoadedMs: ms(v.load),
      requests,
      transferKB: Math.round(bytes / 1024),
      verdict: loadVerdict(mainContentMs),
      note:
        (timedOut ? 'The page had not finished loading when the test stopped. ' : '') +
        "One cold load in headless Chrome posing as Instagram's Android in-app browser; trackers blocked, so a real visit can be a little slower. Main content under 2.5 s is good, over 4 s is slow (Google's bands).",
    };
  } finally {
    cdp?.close();
    proc.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}
