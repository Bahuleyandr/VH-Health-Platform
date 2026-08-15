// src/tests/unit/probeRateLimitProfile.test.js
//
// Finding 2026-08-15: the probe limiter mounted on `/metrics`, `GET /` and
// `HEAD /` (app.js) reused the generic `default` profile and a key that
// collapsed the whole fleet into one bucket. This suite pins the replacement
// `probe` profile's SIZING against the live infra manifests, so the number
// cannot quietly stop being correct when someone tightens the scrape interval,
// adds a Prometheus replica, or raises the HPA ceiling. If any input moves,
// this fails and forces a re-derivation rather than a silent re-blinding of
// monitoring.
//
// The behavioural half — abuse still throttles, fleet-scale scraping does not —
// lives in src/tests/root-probe-rate-limit.deep.test.js.

import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { RATE_LIMIT_PROFILES } from '../../config/rateLimitProfiles.js';
import { __testing__ } from '../../middleware/rateLimitMiddleware.js';

const readManifest = (relative) =>
  parseYaml(readFileSync(new URL(relative, import.meta.url), 'utf8'));

const serviceMonitor = readManifest(
  '../../../../../infra/kubernetes/apps/backend/service-monitor.yaml'
);
const hpa = readManifest('../../../../../infra/kubernetes/apps/backend/hpa.yaml');
const backendConfigMap = readManifest(
  '../../../../../infra/kubernetes/apps/backend/configmap.yaml'
);
const backendDeployment = readManifest(
  '../../../../../infra/kubernetes/apps/backend/deployment.yaml'
);
const kubePrometheusValues = readManifest(
  '../../../../../infra/kubernetes/base/monitoring/kube-prometheus-values.yaml'
);

const seconds = (duration) => {
  const match = /^(\d+)(s|m)$/.exec(String(duration));
  if (!match) throw new Error(`Unparseable duration in manifest: ${duration}`);
  return Number(match[1]) * (match[2] === 'm' ? 60 : 1);
};

// ---- Inputs, read from the manifests rather than restated -----------------
const endpoint = serviceMonitor.spec.endpoints.find((e) => e.path === '/metrics');
const SCRAPE_INTERVAL_S = seconds(endpoint.interval);
const SCRAPE_TIMEOUT_S = seconds(endpoint.scrapeTimeout);
const PROMETHEUS_REPLICAS = kubePrometheusValues.prometheus.prometheusSpec.replicas;
const HPA_MIN = hpa.spec.minReplicas;
const HPA_MAX = hpa.spec.maxReplicas;
const PROD_DEFAULT_WINDOW_S = Number(backendConfigMap.data.RATE_LIMIT_WINDOW_MS) / 1000;
const PROD_DEFAULT_MAX = Number(backendConfigMap.data.RATE_LIMIT_MAX);
const podAnnotations = backendDeployment.spec.template.metadata.annotations || {};

// A second annotation-driven scrape job would hit the same endpoint again. No
// additionalScrapeConfigs exists today, but the pods advertise themselves, so
// the sizing carries the factor rather than betting against it.
const ANNOTATION_SCRAPE_FACTOR = podAnnotations['prometheus.io/scrape'] === 'true' ? 2 : 1;
// Interval can be tightened during an incident, but not below the configured
// scrapeTimeout — that is the hard floor.
const INTERVAL_TIGHTENING_FACTOR = SCRAPE_INTERVAL_S / SCRAPE_TIMEOUT_S;

describe('probe rate-limit profile sizing', () => {
  const probe = RATE_LIMIT_PROFILES.probe;

  it('exists as a dedicated per-surface profile, not an alias of default', () => {
    expect(probe).toBeDefined();
    expect(probe.windowMs).toBe(60 * 1000);
    expect(probe.max).toBe(120);
    expect(probe).not.toBe(RATE_LIMIT_PROFILES.default);
  });

  it('deliberately ignores the blanket RATE_LIMIT_* operator knobs', async () => {
    const previousWindow = process.env.RATE_LIMIT_WINDOW_MS;
    const previousMax = process.env.RATE_LIMIT_MAX;
    // Exactly what prod sets — the values that made the probe surface 100/15min.
    process.env.RATE_LIMIT_WINDOW_MS = String(PROD_DEFAULT_WINDOW_S * 1000);
    process.env.RATE_LIMIT_MAX = String(PROD_DEFAULT_MAX);
    try {
      jest.resetModules();
      const fresh = await import('../../config/rateLimitProfiles.js');
      // The knobs still govern the generic bucket…
      expect(fresh.RATE_LIMIT_PROFILES.default.windowMs).toBe(PROD_DEFAULT_WINDOW_S * 1000);
      expect(fresh.RATE_LIMIT_PROFILES.default.max).toBe(PROD_DEFAULT_MAX);
      // …and must not reach the tuned probe surface.
      expect(fresh.RATE_LIMIT_PROFILES.probe.windowMs).toBe(60 * 1000);
      expect(fresh.RATE_LIMIT_PROFILES.probe.max).toBe(120);
    } finally {
      if (previousWindow === undefined) delete process.env.RATE_LIMIT_WINDOW_MS;
      else process.env.RATE_LIMIT_WINDOW_MS = previousWindow;
      if (previousMax === undefined) delete process.env.RATE_LIMIT_MAX;
      else process.env.RATE_LIMIT_MAX = previousMax;
      jest.resetModules();
    }
  });

  it('leaves 5x headroom over the worst-case legitimate per-pod scrape rate', () => {
    const windowS = probe.windowMs / 1000;
    // Prometheus scrapes pod endpoints directly, so this is per pod and does
    // NOT scale with replica count — which is the whole point of mounting the
    // limiter instanceScoped.
    const steadyStatePerPod = (windowS / SCRAPE_INTERVAL_S) * PROMETHEUS_REPLICAS;
    const worstCasePerPod =
      steadyStatePerPod * ANNOTATION_SCRAPE_FACTOR * INTERVAL_TIGHTENING_FACTOR;

    // 60/30 x 2 = 4 steady state; x2 annotation job x3 tightening = 24.
    expect(steadyStatePerPod).toBe(4);
    expect(worstCasePerPod).toBe(24);
    expect(probe.max).toBeGreaterThanOrEqual(worstCasePerPod * 5);
    expect(probe.max / steadyStatePerPod).toBeGreaterThanOrEqual(30);
  });

  it('still bounds abuse of the DB-touching root probe', () => {
    const windowS = probe.windowMs / 1000;
    const perPodRps = probe.max / windowS;
    // 2 rps of `SELECT 1` per pod per caller.
    expect(perPodRps).toBeLessThanOrEqual(2);
    // A single attacker credential round-robined by the Service across the HPA
    // ceiling still tops out in the tens of rps against a 3-replica CNPG
    // cluster — bounded, versus completely unmetered before the probeLimiter.
    expect(perPodRps * HPA_MAX).toBeLessThanOrEqual(20);
    // And the window is short enough that one burst cannot blind Prometheus
    // for longer than a couple of scrape cycles.
    expect(windowS).toBeLessThanOrEqual(SCRAPE_INTERVAL_S * 2);
  });

  it('records why `default` could not be the probe bucket', () => {
    // Same arithmetic as above but over the 15-minute default window, and
    // fleet-wide because the old key collapsed every replica into one bucket.
    const scrapesPerPod = (PROD_DEFAULT_WINDOW_S / SCRAPE_INTERVAL_S) * PROMETHEUS_REPLICAS;
    expect(scrapesPerPod).toBe(60);

    const fleetAtFloor = scrapesPerPod * HPA_MIN;
    const fleetAtCeiling = scrapesPerPod * HPA_MAX;
    expect(fleetAtFloor).toBe(180);
    expect(fleetAtCeiling).toBe(600);

    // Already over quota at the HPA floor — monitoring was partly blind at
    // steady state, and 83% blind at the ceiling.
    expect(fleetAtFloor).toBeGreaterThan(PROD_DEFAULT_MAX);
    const refusedAtCeiling = (fleetAtCeiling - PROD_DEFAULT_MAX) / fleetAtCeiling;
    expect(Math.round(refusedAtCeiling * 1000) / 1000).toBe(0.833);
  });
});

describe('probe rate-limit key scoping', () => {
  const { instancePrefix, resolveInstanceId } = __testing__;

  const withEnv = (vars, fn) => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('derives a distinct bucket prefix per pod so replicas do not share a quota', () => {
    const a = withEnv(
      { RATE_LIMIT_INSTANCE_ID: undefined, POD_NAME: 'vhhealth-backend-7c9f-aaaaa' },
      instancePrefix
    );
    const b = withEnv(
      { RATE_LIMIT_INSTANCE_ID: undefined, POD_NAME: 'vhhealth-backend-7c9f-bbbbb' },
      instancePrefix
    );
    expect(a).toBe('i:vhhealth-backend-7c9f-aaaaa:');
    expect(b).toBe('i:vhhealth-backend-7c9f-bbbbb:');
    expect(a).not.toBe(b);
  });

  it('prefers the explicit override, then POD_NAME, then HOSTNAME', () => {
    expect(
      withEnv(
        { RATE_LIMIT_INSTANCE_ID: 'override-1', POD_NAME: 'pod-1', HOSTNAME: 'host-1' },
        resolveInstanceId
      )
    ).toBe('override-1');
    expect(
      withEnv(
        { RATE_LIMIT_INSTANCE_ID: undefined, POD_NAME: 'pod-1', HOSTNAME: 'host-1' },
        resolveInstanceId
      )
    ).toBe('pod-1');
    expect(
      withEnv(
        { RATE_LIMIT_INSTANCE_ID: undefined, POD_NAME: undefined, HOSTNAME: 'host-1' },
        resolveInstanceId
      )
    ).toBe('host-1');
  });

  it('never resolves to an empty identity, which would re-collapse the fleet', () => {
    const resolved = withEnv(
      { RATE_LIMIT_INSTANCE_ID: undefined, POD_NAME: undefined, HOSTNAME: undefined },
      resolveInstanceId
    );
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it('POD_NAME is actually injected into the backend pod', () => {
    const container = backendDeployment.spec.template.spec.containers.find(
      (c) => c.name === 'backend' || (c.ports || []).some((p) => p.name === 'http')
    );
    const podName = container.env.find((e) => e.name === 'POD_NAME');
    expect(podName.valueFrom.fieldRef.fieldPath).toBe('metadata.name');
  });
});
