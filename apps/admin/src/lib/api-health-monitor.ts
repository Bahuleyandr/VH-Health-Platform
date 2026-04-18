import { API_ENDPOINTS, buildProxyUrl } from "@/lib/api-config";

type HealthStatus = 'healthy' | 'degraded' | 'down';

interface HealthState {
  status: HealthStatus;
  lastCheck: Date;
  consecutiveFailures: number;
  lastError?: string;
}

class ApiHealthMonitor {
  private state: HealthState = {
    status: 'healthy',
    lastCheck: new Date(),
    consecutiveFailures: 0,
  };
  private listeners: Set<(state: HealthState) => void> = new Set();
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  start(intervalMs = 30_000) {
    if (this.checkInterval) return;
    this.checkInterval = setInterval(() => this.check(), intervalMs);
    this.check(); // immediate first check
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  subscribe(listener: (state: HealthState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): HealthState {
    return { ...this.state };
  }

  recordSuccess() {
    this.state.consecutiveFailures = 0;
    this.state.status = 'healthy';
    this.state.lastCheck = new Date();
    this.notify();
  }

  recordFailure(error?: string) {
    this.state.consecutiveFailures++;
    this.state.lastError = error;
    this.state.lastCheck = new Date();
    this.state.status = this.state.consecutiveFailures >= 3 ? 'down' : 'degraded';
    this.notify();
  }

  private async check() {
    try {
      const res = await fetch(buildProxyUrl(API_ENDPOINTS.health.check), {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.recordSuccess();
      } else {
        this.recordFailure(`HTTP ${res.status}`);
      }
    } catch (e) {
      this.recordFailure((e as Error).message);
    }
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.getState());
    }
  }
}

export const apiHealthMonitor = new ApiHealthMonitor();
