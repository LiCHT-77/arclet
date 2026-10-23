function App() {
  return (
    <main className="w-80 bg-slate-50 p-6 font-sans text-slate-800">
      <header className="mb-6">
        <p className="mb-1 text-xs font-bold tracking-widest text-slate-500">ARCLET</p>
        <h1 className="text-xl font-bold">コマンドバー</h1>
      </header>
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-bold">キーボードショートカット</h2>
        <p className="text-xs leading-relaxed text-slate-500">ブラウザの拡張機能設定にある「キーボード ショートカット」から変更できます。</p>
      </section>
      <p className="mx-1 mt-4 text-xs leading-relaxed text-slate-500">初期設定は ⌘⇧K（Windows / Linux では Ctrl + Shift + K）です。</p>
      <button
        className="mt-4 w-full cursor-pointer rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-100"
        type="button"
        onClick={() => void browser.runtime.openOptionsPage()}
      >
        検索エンジンを設定
      </button>
    </main>
  );
}

export default App;
