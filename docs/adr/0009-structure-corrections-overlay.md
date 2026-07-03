# ADR-0009: structure 層に「人の指摘で差分を更新する」補正オーバーレイを置く

- **status**: accepted
- **date**: 2026-06-27
- **affects**: packages/structure（analyze / emit / CRUD）

## Context

structure 層（rdra-analyzer 移植）の静的解析は LLM 駆動で、**一回で完璧に作り込むのは原理的に不可能**だと実運用で判明した。実リポ（roomport, Laravel・モデル221）解析で次が起きた:

- CRUD が不正確（`hotels` が `R` だけ）。原因は CRUD をルートのパス名照合ではなく usecase 経由でしか出していなかったこと（→ [ADR は別途、コードで修正済み: routes-by-path / entity_operations 連携]）。
- エンティティ取りこぼし（`rooms` が出ない）。原因は 221 モデルをターン内に読み切れないこと。
- これらは「もっと賢く解析する」では消えない。LLM の予算・非決定性の宿命。

reconciler は同じ問題（同一性判定は一回で確定しない）を **ADR-0007: 人の判断を registry に焼き込み、再実行では新規だけ聞く** で解決済み。structure 層にも同型の仕組みが要る。

## Decision

structure 層に **補正オーバーレイ**を置く。reconciler の burn-in と同じ思想:

```
auto extract ──apply(corrections)──▶ corrected extract ──▶ emit / reconcile
                     ▲
            data/structure.corrections.json  （永続・人が所有）
```

- 人は誤りを**一度** `correct` で指摘する（`set-crud` / `add-entity` / `remove-entity` /
  `rename-entity` / `set-attributes` / `add-attributes` / `set-depends-on` / `add-crud`）。
- 指摘は `data/structure.corrections.json` に追記され、**emit / analyze の度に再適用**される。
  だから **40分の再解析で土台が総入れ替えになっても、人の修正は消えない**（焼き込み）。
- 補正は純粋なオーバーレイ（`applyCorrections(extract, corrections)` は入力を変更しない）。
  CRUD は `crudOverrides` として extract に乗り、`entityCrud` で**人の上書きが自動判定に勝つ**。
- 補正が触れたエンティティは LayerNode に `corrected: true` が付き、viewer で「人が直した」と分かる。
- 未知エンティティ参照は黙って捨てず `skipped` として報告する。

さらに **調査(investigate)** をオプションで持つ: 「`rooms` がおかしい」と言われたら、全再解析せず
**そのエンティティだけ**を LLM に問い合わせ（属性・コード由来 CRUD・根拠）、補正案を生成して
`corrections.json` に記録する（`correct investigate <repo> <entity>`）。LLM 無しでも手動補正は機能する。

## Consequences

- structure が **状態を持つ**ようになる（reconciler と対称）。`corrections.json` が人の知識の蓄積。
- 「自動解析の精度」と「人の確定知識」が分離される。自動は何度でも作り直してよく、確定知識は不変。
- viewer は `corrected` フラグで自動値と人の修正を区別できる。
- 補正の適用順は逐次（後勝ち）。これで「まず investigate で案 → 後で手で微修正」が自然に効く。

## Alternatives considered

- **解析を作り込んで一発で正しくする**: 不可能（LLM 予算・非決定性）。退けた。
- **毎回 LLM で全部やり直す**: 高コスト・非再現。人の確定知識も保持されない。退けた。
- **抽出結果(JSON)を人が直接手編集**: 再解析で上書きされ消える（焼き込みにならない）。退けた。
