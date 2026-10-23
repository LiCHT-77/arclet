# arclet

Chromium 拡張（WXT + React 19 + Tailwind 4）。Arc の Little arc とコマンドバーを提供する。

```yaml
delivery: ship
base: main
branch: feat/<topic>
max-commits-per-pr: 5
checks:
  - ./node_modules/.bin/tsc --noEmit
  - ./node_modules/.bin/wxt build
```

## 配送

- `delivery: ship` なので作業はコミット整形と PR 作成まで進める。push --force / merge / 削除は毎回確認する。
- `base` は `main`。stack を組む場合は子 PR の base を親ブランチに向ける。

## 緑の定義

上の `checks` を自分で実行して全て exit 0 のときだけ緑。`bun run compile` / `bun run build` と同じ内容だが、bun 本体の取得にネットワークが必要で環境によって失敗するため、`node_modules` のバイナリを直接呼ぶ。

自動テストは無い。ブラウザ上の挙動が変わる変更は `.output/chrome-mv3` を未パッケージ拡張として読み込み、実際の画面で確認した内容を PR の Verification に書く。

## 言語

- 返答・PR 本文・コミット本文は日本語。
- コミット subject、識別子、コード中の文字列は英語。Conventional Commits の scope は `little-arc`, `command-bar`, `background`, `content`, `devtools` など変更箇所。

## 構成

- `entrypoints/` — WXT のエントリ（background、content、popup、command-bar、devtools）。
- `utils/` — エントリ間で共有するロジック。
- `wxt.config.ts` — manifest、権限、Tailwind プラグイン。
