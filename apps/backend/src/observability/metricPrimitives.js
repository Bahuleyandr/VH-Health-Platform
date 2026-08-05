// src/observability/metricPrimitives.js
// Prometheus exposition-format metric primitives — no external dependency.
// Moved out of middleware/prometheusMiddleware.js (2026-06-27) so the RED
// middleware and the reliability collector can share one implementation.

export class Histogram {
  constructor(name, help, labelNames, buckets) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = buckets;
    // key = sorted label string, value = { counts: [per-bucket], sum, count }
    this.data = new Map();
  }

  _key(labels) {
    return this.labelNames.map((n) => `${n}="${labels[n] || ''}"`).join(',');
  }

  _entry(labels) {
    const k = this._key(labels);
    if (!this.data.has(k)) {
      this.data.set(k, { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 });
    }
    return this.data.get(k);
  }

  observe(labels, value) {
    const entry = this._entry(labels);
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) entry.counts[i]++;
    }
    entry.sum += value;
    entry.count++;
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [, entry] of this.data) {
      const lblStr = this.labelNames.map((n) => `${n}="${entry.labels[n] || ''}"`).join(',');
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += entry.counts[i];
        lines.push(`${this.name}_bucket{${lblStr},le="${this.buckets[i]}"} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket{${lblStr},le="+Inf"} ${entry.count}`);
      lines.push(`${this.name}_sum{${lblStr}} ${entry.sum}`);
      lines.push(`${this.name}_count{${lblStr}} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

export class Counter {
  constructor(name, help, labelNames) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.data = new Map();
  }

  _key(labels) {
    return this.labelNames.map((n) => `${n}="${labels[n] || ''}"`).join(',');
  }

  inc(labels, val = 1) {
    const k = this._key(labels);
    this.data.set(k, { labels, value: (this.data.get(k)?.value || 0) + val });
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [, entry] of this.data) {
      const lblStr = this.labelNames.map((n) => `${n}="${entry.labels[n] || ''}"`).join(',');
      const lblPart = lblStr ? `{${lblStr}}` : '';
      lines.push(`${this.name}${lblPart} ${entry.value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.data = new Map();
  }

  set(labels, value) {
    const k = this.labelNames.map((n) => `${n}="${labels[n] || ''}"`).join(',');
    this.data.set(k, { labels, value });
  }

  replace(entries) {
    const next = new Map();
    for (const { labels, value } of entries) {
      const k = this.labelNames.map((n) => `${n}="${labels[n] || ''}"`).join(',');
      next.set(k, { labels, value });
    }
    this.data = next;
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [, entry] of this.data) {
      const lblStr = this.labelNames.length
        ? '{' + this.labelNames.map((n) => `${n}="${entry.labels[n] || ''}"`).join(',') + '}'
        : '';
      lines.push(`${this.name}${lblStr} ${entry.value}`);
    }
    return lines.join('\n');
  }
}
