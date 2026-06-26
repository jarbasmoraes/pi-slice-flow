/**
 * Tiny dependency-free async helper: bounded-concurrency map. Used to fetch the
 * content of several search results without opening unbounded browser pages.
 */

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const max = Math.max(1, Math.floor(limit));
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	}
	const workers = Array.from({ length: Math.min(max, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}
