import { getCollection, type CollectionEntry } from 'astro:content';

export const INITIAL_COUNT = 2;
export const PAGE_SIZE = 5;

export async function getRecentPosts(): Promise<CollectionEntry<'docs'>[]> {
	return ((await getCollection('docs')) ?? [])
		.filter((d) => d.data.lastUpdated)
		.filter((d) => (d.body?.length ?? 0) > 800)
		.sort(
			(a, b) => new Date(b.data.lastUpdated).valueOf() - new Date(a.data.lastUpdated).valueOf()
		)
		.slice(0, 100);
}

export function recentPageCount(total: number) {
	return Math.ceil(Math.max(0, total - INITIAL_COUNT) / PAGE_SIZE);
}
