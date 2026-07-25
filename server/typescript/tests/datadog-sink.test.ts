import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ConsoleMetricSink,
	DatadogMetricSink,
	describeTelemetry,
	setMetricSink,
	usingDatadog,
} from "../telemetry";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	// Leave the process on the local sink so later files aren't affected.
	setMetricSink(new ConsoleMetricSink());
});

function captureFetch(impl?: () => Promise<unknown>) {
	// Declared with the fetch signature so mock.calls is typed as [url, init]
	// rather than an empty tuple.
	const fn = vi.fn(async (_url?: unknown, _init?: unknown) =>
		impl ? impl() : { ok: true },
	);
	vi.stubGlobal("fetch", fn);
	return fn;
}

/** The parsed body of the first fetch call. */
function body(fn: ReturnType<typeof captureFetch>) {
	const init = fn.mock.calls[0][1] as unknown as RequestInit;
	return JSON.parse(init.body as string) as {
		series: { metric: string; type: number; tags: string[] }[];
	};
}

describe("DatadogMetricSink", () => {
	it("sends nothing when there is nothing buffered", async () => {
		const fetchMock = captureFetch();
		const sink = new DatadogMetricSink("key", "datadoghq.com");

		await sink.flush();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("posts buffered metrics to the site's series endpoint", async () => {
		const fetchMock = captureFetch();
		const sink = new DatadogMetricSink("secret-key", "datadoghq.eu");

		sink.count("bid.accepted", 1, ["category:tractor"]);
		await sink.flush();

		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://api.datadoghq.eu/api/v2/series");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["DD-API-KEY"]).toBe(
			"secret-key",
		);
	});

	it("batches rather than posting per metric", async () => {
		// A request per bid would put Datadog's availability in the path of
		// ours.
		const fetchMock = captureFetch();
		const sink = new DatadogMetricSink("key", "datadoghq.com");

		sink.count("a", 1, []);
		sink.count("b", 1, []);
		sink.gauge("c", 5, []);
		await sink.flush();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(body(fetchMock).series).toHaveLength(3);
	});

	it("maps counts and gauges to Datadog's numeric types", () => {
		const fetchMock = captureFetch();
		const sink = new DatadogMetricSink("key", "datadoghq.com");

		sink.count("counted", 1, []);
		sink.gauge("gauged", 1, []);
		void sink.flush();

		return Promise.resolve().then(() => {
			const series = body(fetchMock).series;
			expect(series.find((s) => s.metric === "counted")?.type).toBe(1);
			expect(series.find((s) => s.metric === "gauged")?.type).toBe(3);
		});
	});

	it("suffixes timings so they don't collide with the count of the same name", async () => {
		const fetchMock = captureFetch();
		const sink = new DatadogMetricSink("key", "datadoghq.com");

		sink.timing("http.request", 42, []);
		await sink.flush();

		expect(body(fetchMock).series[0].metric).toBe("http.request.ms");
	});

	it("tags everything with env and service", async () => {
		const fetchMock = captureFetch();
		const sink = new DatadogMetricSink("key", "datadoghq.com");

		sink.count("bid.accepted", 1, ["category:tractor"]);
		await sink.flush();

		const tags = body(fetchMock).series[0].tags;
		expect(tags).toContain("category:tractor");
		expect(tags.some((t) => t.startsWith("env:"))).toBe(true);
		expect(tags.some((t) => t.startsWith("service:"))).toBe(true);
	});

	it("empties the buffer so a second flush sends nothing", async () => {
		const fetchMock = captureFetch();
		const sink = new DatadogMetricSink("key", "datadoghq.com");

		sink.count("once", 1, []);
		await sink.flush();
		await sink.flush();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("swallows a failed flush rather than throwing into a handler", async () => {
		// Telemetry must never be able to fail a request. The metrics are
		// dropped, not queued -- a retry buffer that grows while Datadog is
		// unreachable is a memory leak.
		const errors: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			errors.push(String(chunk));
			return true;
		});
		captureFetch(async () => {
			throw new Error("network unreachable");
		});

		const sink = new DatadogMetricSink("key", "datadoghq.com");
		sink.count("bid.accepted", 1, []);

		await expect(sink.flush()).resolves.toBeUndefined();
		expect(errors.some((e) => e.includes("telemetry.flush_failed"))).toBe(true);
	});

	it("flushes on its own interval", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = captureFetch();
			const sink = new DatadogMetricSink("key", "datadoghq.com", 1_000);
			sink.count("periodic", 1, []);

			await vi.advanceTimersByTimeAsync(1_100);

			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("sink selection", () => {
	it("reports the local sink by default", () => {
		setMetricSink(new ConsoleMetricSink());
		expect(usingDatadog()).toBe(false);
	});

	it("reports the Datadog sink once installed", () => {
		setMetricSink(new DatadogMetricSink("key", "datadoghq.com"));
		expect(usingDatadog()).toBe(true);
	});

	it("announces which sink is active without throwing", () => {
		// Runs at boot, so a mistake here takes the server down before it can
		// report anything.
		expect(() => describeTelemetry()).not.toThrow();
	});
});

describe("ConsoleMetricSink", () => {
	it("accepts every metric type and flushes to nothing", async () => {
		const sink = new ConsoleMetricSink();

		expect(() => {
			sink.count("a", 1, []);
			sink.gauge("b", 2, []);
			sink.timing("c", 3, []);
		}).not.toThrow();

		await expect(sink.flush()).resolves.toBeUndefined();
	});
});
