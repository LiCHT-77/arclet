import './App.css';

function App() {
  return (
    <main className="popup">
      <header>
        <p className="eyebrow">ARCLET</p>
        <h1>コマンドバー</h1>
      </header>
      <section className="setting">
        <h2>キーボードショートカット</h2>
        <p>ブラウザの拡張機能設定にある「キーボード ショートカット」から変更できます。</p>
      </section>
      <p className="hint">初期設定は ⌘⇧K（Windows / Linux では Ctrl + Shift + K）です。</p>
    </main>
  );
}

export default App;
