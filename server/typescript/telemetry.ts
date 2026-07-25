/**
 * Structured logging and metrics.
 *
 * Two sinks behind one interface. Locally, everything is written to stdout as
 * one JSON object per line — greppable, and parseable by whatever collects
 * container logs. With DD_API_KEY set, metrics are additionally shipped to
 * Datadog's intake.
 *
 * Deliberately dependency-free. dd-trace is the real answer in production —
 * it gives distributed tracing and runtime metrics that a hand-rolled client
 * never will — but it's a large agent-dependent dependency to add to an
 * exercise, and the seam here is small enough to swap for it: replace the sink
 * and the call sites don't move.
 *
 * Configuration, all optional:
 *   DD_API_KEY   enables the Datadog sink
 *   DD_SITE      intake host, defaults to datadoghq.com (use datadoghq.eu etc.)
 *   DD_ENV       tagged on everything, defaults to "development"
 *   DD_SERVICE   defaults to "interview-auctions-api"
 *   LOG_LEVEL    debug | info | warn | error, defaults to info
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export interface Fields {
	[key: string]: unknown;
}

const SERVICE = process.env.DD_SERVICE ?? "interview-auctions-api";
const ENV = process.env.DD_ENV ?? "development";
const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) ?? "info";

/**
 * Keys whose values should never reach a log line or a metric tag.
 *
 * Bidder names are the live example: they're user-supplied, they're personal
 * data, and a metric tagged with them would also create unbounded cardinality,
 * which is how a metrics bill becomes a surprise.
 */
const REDACTED = new Set(["bidder", "currentBidder", "password", "token"]);

function scrub(fields: Fields): Fields {
	const out: Fields = {};
	for (const [key, value] of Object.entries(fields)) {
		out[key] = REDACTED.has(key) ? "[redacted]" : value;
	}
	return out;
}

// ============================================================
// Metric sinks
// ============================================================

export interface MetricSink {
	count(metric: string, value: number, tags: string[]): void;
	gauge(metric: string, value: number, tags: string[]): void;
	timing(metric: string, ms: number, tags: string[]): void;
	flush(): Promise<void>;
}

/** Writes metrics to stdout as structured lines. The local default. */
export class ConsoleMetricSink implements MetricSink {
	private emit(type: string, metric: string, value: number, tags: string[]) {
		write("debug", "metric", { metric, type, value, tags });
	}

	count(metric: string, value: number, tags: string[]) {
		this.emit("count", metric, value, tags);
	}
	gauge(metric: string, value: number, tags: string[]) {
		this.emit("gauge", metric, value, tags);
	}
	timing(metric: string, ms: number, tags: string[]) {
		this.emit("timing", metric, ms, tags);
	}
	async flush() {}
}

/**
 * Buffers metrics and posts them to Datadog on an interval.
 *
 * Batched rather than one request per metric: a per-bid HTTP call to a third
 * party would put their availability in the path of ours. Failures are logged
 * and dropped — telemetry must never be able to fail a request or throw inside
 * a handler.
 */
export class DatadogMetricSink implements MetricSink {
	private buffer: {
		metric: string;
		type: number;
		points: [number, number][];
		tags: string[];
	}[] = [];
	private timer: NodeJS.Timeout;

	constructor(
		private apiKey: string,
		private site: string,
		flushMs = 10_000,
	) {
		this.timer = setInterval(() => void this.flush(), flushMs);
		this.timer.unref();
	}

	private push(metric: string, type: number, value: number, tags: string[]) {
		this.buffer.push({
			metric,
			type,
			points: [[Math.floor(Date.now() / 1000), value]],
			tags: [...tags, `env:${ENV}`, `service:${SERVICE}`],
		});
	}

	// Datadog's series API: 1 = count, 3 = gauge.
	count(metric: string, value: number, tags: string[]) {
		this.push(metric, 1, value, tags);
	}
	gauge(metric: string, value: number, tags: string[]) {
		this.push(metric, 3, value, tags);
	}
	timing(metric: string, ms: number, tags: string[]) {
		this.push(`${metric}.ms`, 3, ms, tags);
	}

	async flush() {
		if (this.buffer.length === 0) return;

		const series = this.buffer;
		this.buffer = [];

		try {
			await fetch(`https://api.${this.site}/api/v2/series`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"DD-API-KEY": this.apiKey,
				},
				body: JSON.stringify({ series }),
			});
		} catch (err) {
			// Dropped, not retried. A retry queue that grows while Datadog is
			// unreachable is a memory leak wearing a helpful hat.
			write("warn", "telemetry.flush_failed", {
				error: err instanceof Error ? err.message : String(err),
				dropped: series.length,
			});
		}
	}
}

// ============================================================
// Logging
// ============================================================

function write(level: Level, event: string, fields: Fields = {}): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

	const line = JSON.stringify({
		timestamp: new Date().toISOString(),
		level,
		event,
		service: SERVICE,
		env: ENV,
		...scrub(fields),
	});

	// stderr for warn and above so a shell can separate the two streams;
	// collectors treat both as log lines either way.
	if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
	else process.stdout.write(`${line}\n`);
}

export const log = {
	debug: (event: string, fields?: Fields) => write("debug", event, fields),
	info: (event: string, fields?: Fields) => write("info", event, fields),
	warn: (event: string, fields?: Fields) => write("warn", event, fields),
	error: (event: string, fields?: Fields) => write("error", event, fields),
};

// ============================================================
// Public surface
// ============================================================

let sink: MetricSink = process.env.DD_API_KEY
	? new DatadogMetricSink(
			process.env.DD_API_KEY,
			process.env.DD_SITE ?? "datadoghq.com",
		)
	: new ConsoleMetricSink();

/** Swaps the sink. Used by tests, and by anything wanting a different backend. */
export function setMetricSink(next: MetricSink): void {
	sink = next;
}

export function usingDatadog(): boolean {
	return sink instanceof DatadogMetricSink;
}

export const metrics = {
	count: (metric: string, tags: string[] = [], value = 1) =>
		sink.count(metric, value, tags),
	gauge: (metric: string, value: number, tags: string[] = []) =>
		sink.gauge(metric, value, tags),
	timing: (metric: string, ms: number, tags: string[] = []) =>
		sink.timing(metric, ms, tags),
	flush: () => sink.flush(),
};

/** Announces which sink is active, so it's obvious what is and isn't shipping. */
export function describeTelemetry(): void {
	log.info("telemetry.configured", {
		metricSink: usingDatadog() ? "datadog" : "stdout",
		site: usingDatadog() ? (process.env.DD_SITE ?? "datadoghq.com") : undefined,
		logLevel: MIN_LEVEL,
	});
}
