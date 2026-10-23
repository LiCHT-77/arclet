/** 検索エンジン。keyword を一意キーとして扱う。 */
export interface SearchEngine {
  name: string;
  keyword: string;
  urlTemplate: string;
}

export const SEARCH_ENGINES_STORAGE_KEY = 'searchEngines';

export const DEFAULT_SEARCH_ENGINES: SearchEngine[] = [
  { name: 'Google', keyword: 'g', urlTemplate: 'https://www.google.com/search?q=%s' },
  { name: 'Bing', keyword: 'b', urlTemplate: 'https://www.bing.com/search?q=%s' },
  { name: 'DuckDuckGo', keyword: 'd', urlTemplate: 'https://duckduckgo.com/?q=%s' },
  { name: 'Yahoo! JAPAN', keyword: 'y', urlTemplate: 'https://search.yahoo.co.jp/search?p=%s' },
  { name: 'YouTube', keyword: 'yt', urlTemplate: 'https://www.youtube.com/results?search_query=%s' },
  { name: 'GitHub', keyword: 'gh', urlTemplate: 'https://github.com/search?q=%s' },
  { name: 'MDN', keyword: 'mdn', urlTemplate: 'https://developer.mozilla.org/search?q=%s' },
];

export function normalizeKeyword(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, '');
}

// テンプレートに埋め込んだスクリプトが検索語を引数に実行されるのを防ぐ。
const UNSAFE_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'blob:', 'filesystem:'];

/** URL テンプレートの `%s` と Chrome の `{searchTerms}` の両方を置換する。 */
export function searchUrlFrom(urlTemplate: string, query: string): string | null {
  const template = urlTemplate.trim();
  if (!/%s|\{searchTerms\}/.test(template)) return null;

  try {
    const url = new URL(template.replace(/%s|\{searchTerms\}/g, encodeURIComponent(query)));
    return UNSAFE_PROTOCOLS.includes(url.protocol) ? null : url.href;
  } catch {
    return null;
  }
}

export function searchEngineOrigin(engine: SearchEngine): string | null {
  const url = searchUrlFrom(engine.urlTemplate, 'q');
  if (!url) return null;

  // http(s) 以外のスキームは origin を持たず "null" 文字列になる。
  const { origin } = new URL(url);
  return origin === 'null' ? null : origin;
}

export function searchEngineFaviconUrl(engine: SearchEngine): string | undefined {
  const origin = searchEngineOrigin(engine);
  if (!origin) return undefined;

  const faviconUrl = new URL(browser.runtime.getURL('/command-bar.html'));
  faviconUrl.pathname = '/_favicon/';
  faviconUrl.searchParams.set('pageUrl', origin);
  faviconUrl.searchParams.set('size', '32');
  return faviconUrl.href;
}

/** 入力されたトークンに対応するエンジン。keyword を名前より優先する。 */
export function matchSearchEngine(engines: SearchEngine[], token: string): SearchEngine | undefined {
  const lowered = normalizeKeyword(token);
  if (!lowered) return undefined;

  return engines.find((engine) => engine.keyword.startsWith(lowered))
    ?? engines.find((engine) => engine.name.toLocaleLowerCase().startsWith(lowered));
}

function isSearchEngine(value: unknown): value is SearchEngine {
  if (typeof value !== 'object' || value === null) return false;
  const { name, keyword, urlTemplate } = value as Record<string, unknown>;
  return typeof name === 'string' && typeof keyword === 'string' && typeof urlTemplate === 'string';
}

export async function loadSearchEngines(): Promise<SearchEngine[]> {
  try {
    const stored = await browser.storage.sync.get(SEARCH_ENGINES_STORAGE_KEY);
    const engines = stored[SEARCH_ENGINES_STORAGE_KEY];
    if (!Array.isArray(engines)) return DEFAULT_SEARCH_ENGINES;

    const valid = engines.filter(isSearchEngine).filter((engine) => searchUrlFrom(engine.urlTemplate, 'q'));
    return valid.length ? valid : DEFAULT_SEARCH_ENGINES;
  } catch {
    return DEFAULT_SEARCH_ENGINES;
  }
}

export async function saveSearchEngines(engines: SearchEngine[]): Promise<void> {
  await browser.storage.sync.set({ [SEARCH_ENGINES_STORAGE_KEY]: engines });
}

export type SearchEngineImport =
  | { ok: true; engines: SearchEngine[] }
  | { ok: false; message: string };

/**
 * chrome://settings/searchEngines の `getSearchEnginesList` が返す形、
 * またはその中の 1 リストをそのまま受け取る。
 */
export function parseImportedSearchEngines(raw: string): SearchEngineImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'JSON として読めません。' };
  }

  const lists = Array.isArray(parsed)
    ? [parsed]
    : typeof parsed === 'object' && parsed !== null
      ? ['defaults', 'actives', 'others'].map((key) => (parsed as Record<string, unknown>)[key])
      : [];

  const seen = new Set<string>();
  const engines: SearchEngine[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { name, keyword, url } = entry as Record<string, unknown>;
      if (typeof name !== 'string' || typeof keyword !== 'string' || typeof url !== 'string') continue;

      const normalizedKeyword = normalizeKeyword(keyword);
      if (!name.trim() || !normalizedKeyword || seen.has(normalizedKeyword)) continue;
      if (!searchUrlFrom(url, 'q')) continue;

      seen.add(normalizedKeyword);
      engines.push({ name: name.trim(), keyword: normalizedKeyword, urlTemplate: url.trim() });
    }
  }

  if (!engines.length) return { ok: false, message: '検索エンジンが見つかりません。name / keyword / url を持つ配列が必要です。' };
  return { ok: true, engines };
}
