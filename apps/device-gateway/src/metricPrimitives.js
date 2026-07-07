class Metric {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map();
  }

  key(labels = {}) {
    return this.labelNames.map((name) => `${name}=${labels[name] ?? ''}`).join('\u0000');
  }

  labelsFromKey(key) {
    if (!key) return {};
    const parts = key.split('\u0000');
    return Object.fromEntries(parts.map((part) => {
      const [name, ...rest] = part.split('=');
      return [name, rest.join('=')];
    }));
  }

  formatLabels(labels) {
    const keys = this.labelNames.filter((name) => labels[name] !== undefined && labels[name] !== '');
    if (keys.length === 0) return '';
    return `{${keys.map((name) => `${name}="${String(labels[name]).replaceAll('"', '\\"')}"`).join(',')}}`;
  }
}

export class Counter extends Metric {
  inc(labels = {}, amount = 1) {
    const key = this.key(labels);
    this.values.set(key, (this.values.get(key) || 0) + amount);
  }

  serialize() {
    const samples = [...this.values.entries()].map(([key, value]) => {
      const labels = this.labelsFromKey(key);
      return `${this.name}${this.formatLabels(labels)} ${value}`;
    });
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...samples].join('\n');
  }
}

export class Gauge extends Metric {
  set(labels = {}, value) {
    this.values.set(this.key(labels), Number(value) || 0);
  }

  inc(labels = {}, amount = 1) {
    const key = this.key(labels);
    this.values.set(key, (this.values.get(key) || 0) + amount);
  }

  dec(labels = {}, amount = 1) {
    this.inc(labels, -amount);
  }

  serialize() {
    const samples = [...this.values.entries()].map(([key, value]) => {
      const labels = this.labelsFromKey(key);
      return `${this.name}${this.formatLabels(labels)} ${value}`;
    });
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, ...samples].join('\n');
  }
}

export class Histogram extends Metric {
  constructor(name, help, buckets = [0.005, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], labelNames = []) {
    super(name, help, labelNames);
    this.buckets = buckets;
    this.counts = new Map();
    this.sums = new Map();
  }

  observe(labels = {}, value) {
    const baseKey = this.key(labels);
    this.sums.set(baseKey, (this.sums.get(baseKey) || 0) + value);
    for (const bucket of [...this.buckets, '+Inf']) {
      const le = String(bucket);
      const key = `${baseKey}\u0000le=${le}`;
      if (bucket === '+Inf' || value <= bucket) {
        this.counts.set(key, (this.counts.get(key) || 0) + 1);
      }
    }
  }

  serialize() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, value] of this.counts.entries()) {
      const raw = Object.fromEntries(key.split('\u0000').filter(Boolean).map((part) => {
        const [name, ...rest] = part.split('=');
        return [name, rest.join('=')];
      }));
      const { le, ...labels } = raw;
      out.push(`${this.name}_bucket${formatLabels({ ...labels, le }, [...this.labelNames, 'le'])} ${value}`);
    }
    for (const [key, sum] of this.sums.entries()) {
      const labels = this.labelsFromKey(key);
      const count = this.counts.get(`${key}\u0000le=+Inf`) || 0;
      out.push(`${this.name}_sum${this.formatLabels(labels)} ${sum}`);
      out.push(`${this.name}_count${this.formatLabels(labels)} ${count}`);
    }
    return out.join('\n');
  }
}

function formatLabels(labels, labelNames) {
  const keys = labelNames.filter((name) => labels[name] !== undefined && labels[name] !== '');
  if (keys.length === 0) return '';
  return `{${keys.map((name) => `${name}="${String(labels[name]).replaceAll('"', '\\"')}"`).join(',')}}`;
}
