import { useEffect, useRef, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import {
  DEFAULT_SEARCH_ENGINES,
  loadSearchEngines,
  normalizeKeyword,
  parseImportedSearchEngines,
  saveSearchEngines,
  searchUrlFrom,
  type SearchEngine,
} from '@/utils/search-engines';

const IMPORT_SNIPPET = `const { sendWithPromise } = await import('chrome://resources/js/cr.js');
copy(await sendWithPromise('getSearchEnginesList'));`;

interface Row extends SearchEngine {
  rowId: number;
}

function rowsFrom(engines: SearchEngine[], nextRowId: () => number): Row[] {
  return engines.map((engine) => ({ ...engine, rowId: nextRowId() }));
}

function issuesFor(rows: Row[]): Map<number, string> {
  const issues = new Map<number, string>();
  const keywordCounts = new Map<string, number>();
  for (const row of rows) {
    const keyword = normalizeKeyword(row.keyword);
    if (keyword) keywordCounts.set(keyword, (keywordCounts.get(keyword) ?? 0) + 1);
  }

  for (const row of rows) {
    const keyword = normalizeKeyword(row.keyword);
    if (!row.name.trim()) issues.set(row.rowId, '名前を入力してください。');
    else if (!keyword) issues.set(row.rowId, 'ショートカットを入力してください。');
    else if ((keywordCounts.get(keyword) ?? 0) > 1) issues.set(row.rowId, `ショートカット「${keyword}」が重複しています。`);
    else if (!searchUrlFrom(row.urlTemplate, 'q')) issues.set(row.rowId, 'URL に %s を含む http(s) の URL を入力してください。');
  }

  return issues;
}

export default function SearchEnginesPage() {
  const rowIdRef = useRef(0);
  const nextRowId = () => ++rowIdRef.current;
  const [rows, setRows] = useState<Row[]>([]);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string>();
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    void loadSearchEngines().then((engines) => setRows(rowsFrom(engines, nextRowId)));
  }, []);

  const issues = issuesFor(rows);
  const updateRows = (next: Row[]) => {
    setRows(next);
    setStatus(undefined);
  };
  const updateRow = (rowId: number, patch: Partial<SearchEngine>) => (
    updateRows(rows.map((row) => row.rowId === rowId ? { ...row, ...patch } : row))
  );

  const save = async () => {
    if (issues.size) return;
    const engines = rows.map(({ name, keyword, urlTemplate }) => ({
      name: name.trim(),
      keyword: normalizeKeyword(keyword),
      urlTemplate: urlTemplate.trim(),
    }));
    await saveSearchEngines(engines);
    setRows(rowsFrom(engines, nextRowId));
    setStatus(`${engines.length} 件を保存しました。`);
  };

  const importEngines = () => {
    const result = parseImportedSearchEngines(importText);
    if (!result.ok) {
      setImportError(result.message);
      return;
    }
    setImportError(undefined);
    setImportText('');
    updateRows(rowsFrom(result.engines, nextRowId));
    setStatus(`${result.engines.length} 件を読み込みました。保存を押すと反映されます。`);
  };

  return (
    <main className="mx-auto max-w-3xl bg-white p-8 font-sans text-slate-800">
      <header className="mb-6">
        <p className="mb-1 text-xs font-bold tracking-widest text-slate-500">ARCLET</p>
        <h1 className="text-xl font-bold">検索エンジン</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          コマンドバーでショートカットを入力して Tab を押すと、そのエンジンでの検索に切り替わります。URL の <code className="rounded bg-slate-100 px-1 font-mono">%s</code> が検索語に置き換わります。
        </p>
      </header>

      <section className="mb-8">
        <div className="grid grid-cols-[10rem_6rem_1fr_2rem] gap-2 pb-1 text-xs font-bold text-slate-500">
          <span>名前</span><span>ショートカット</span><span>URL</span><span />
        </div>
        {rows.map((row) => (
          <div className="mb-2" key={row.rowId}>
            <div className="grid grid-cols-[10rem_6rem_1fr_2rem] items-center gap-2">
              <input className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" value={row.name} placeholder="Google" onChange={(event) => updateRow(row.rowId, { name: event.target.value })} />
              <input className="rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm" value={row.keyword} placeholder="g" onChange={(event) => updateRow(row.rowId, { keyword: event.target.value })} />
              <input className="rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm" value={row.urlTemplate} placeholder="https://example.com/search?q=%s" onChange={(event) => updateRow(row.rowId, { urlTemplate: event.target.value })} />
              <button className="flex size-8 cursor-pointer items-center justify-center rounded-md text-slate-500 hover:bg-slate-100" type="button" aria-label={`${row.name || 'この行'} を削除`} onClick={() => updateRows(rows.filter((candidate) => candidate.rowId !== row.rowId))}>
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </div>
            {issues.has(row.rowId) && <p className="mt-1 text-xs text-red-600">{issues.get(row.rowId)}</p>}
          </div>
        ))}

        <div className="mt-3 flex items-center gap-3">
          <button className="flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100" type="button" onClick={() => updateRows([...rows, { rowId: nextRowId(), name: '', keyword: '', urlTemplate: '' }])}>
            <Plus className="size-4" aria-hidden="true" />追加
          </button>
          <button className="flex cursor-pointer items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300" type="button" disabled={issues.size > 0} onClick={() => void save()}>
            <Check className="size-4" aria-hidden="true" />保存
          </button>
          <button className="cursor-pointer rounded-md px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100" type="button" onClick={() => updateRows(rowsFrom(DEFAULT_SEARCH_ENGINES, nextRowId))}>
            既定に戻す
          </button>
          {status && <span className="text-sm text-slate-600">{status}</span>}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 p-4">
        <h2 className="mb-1 text-sm font-bold">Chrome の設定から取り込む</h2>
        <p className="text-xs leading-relaxed text-slate-600">
          拡張機能から <code className="rounded bg-slate-100 px-1 font-mono">chrome://settings/searchEngines</code> を直接読む API はありません。同じページの DevTools コンソールで次を実行し、クリップボードの JSON を貼ってください。
        </p>
        <pre className="mt-2 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">{IMPORT_SNIPPET}</pre>
        <textarea
          className="mt-3 h-24 w-full rounded-md border border-slate-300 p-2 font-mono text-xs"
          value={importText}
          placeholder='{"defaults":[...],"actives":[...],"others":[...]}'
          onChange={(event) => { setImportText(event.target.value); setImportError(undefined); }}
        />
        {importError && <p className="mt-1 text-xs text-red-600">{importError}</p>}
        <button className="mt-2 cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400" type="button" disabled={!importText.trim()} onClick={importEngines}>
          一覧を置き換える
        </button>
      </section>
    </main>
  );
}
