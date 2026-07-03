# ROADMAP

作る順番。原則は前から決まっている通り **「まず収束層」**、そして **「最初に差分が色づくまで」** を
最優先のマイルストーンに置く(それが他人への展開に効く動くデモだから)。

各マイルストーンに「完了の定義(Done)」を付ける。

---

## M0 — contract（背骨）✅ 着手済み

型の単一の真実を確定する。

- `packages/contract`: `model.ts`(= `contract.ts`)、`validate.ts`(参照整合性)、`io.ts`(atomic R/W)。
- **Done**: registry.json / unified.json を型安全に読み書きでき、dangling ID で検証が落ちる。

## M1 — route 辺を一本通す（最重要・動くデモ）✅ 実装済み

structure↔behavior を、route キーだけで結んで差分を色づける。三辺のうち機械的・高信頼な辺。

- `structure/emit.ts`: route key 付き structure ノードを出力。
- `behavior/emit.ts`: route key 付き behavior ノード(findings/scenarios)を出力。
  → loop-e2e の `rdra-export` はここに置き換わる。
- `reconciler/match`: route マッチングのみ(rdra の `normalizeRoute` 相当を移植)。
- `reconciler/classify`: `aligned / code-only / unmatched` の最小分類。
- `reconciler/pipeline`: → `data/unified.json`。
- `viewer`: 素朴でよい。概念を選ぶ → structure/behavior が並ぶ → 食い違いが赤。
- **Done**: 実プロジェクトで `unified.json` が出て、viewer で structure↔behavior の差分が
  色づく。**ここがデモの核**。

## M2 — structure を本格化（rdra port）✅ 実装済み

route だけでなく情報モデル・ユースケースまで structure を厚くする。

- `structure/analyze/*`: source-parser / screen-analyzer / usecase-extractor / information-model
  を Python から TS へ移植([CONTRIBUTING](../CONTRIBUTING.md) の port 指針)。
- `structure/rdra/diagrams.ts`: Mermaid 出力。
- `structure/gap/crud.ts`: CRUD ギャップ。
- **Done**: structure ノードがエンティティ/属性/UC を持ち、後段のマッチで attributes/topology が使える。

## M3 — intent 辺（glossary を入れる）✅ 実装済み

distill-ddd の glossary を intent 層として接続し、正準 ID の発生源にする。

- glossary.json の供給方法を決める(発生源 emit か reconciler パーサか。[STRUCTURE](../STRUCTURE.md) 参照)。
- `reconciler/match`: name / attributes / topology / behavior / llm の証拠ベクトルを実装。
  決定的を先に、LLM は残りだけ。
- `classify`: `intent-only / aggregate-internal / implementation-detail` を追加。
  「孤児」と言う前に `part-of` を見る。
- **Done**: intent↔structure の差分が出て、必要だが意図に無いコードが赤ではなく
  aggregate-internal / implementation-detail に落ちる。

## M4 — ADR オーバーレイ ✅ 実装済み

裁定者を有効化する。

- `reconciler/adr.ts`: ADR の `constraints` を structure トポロジーに照合。
- `classify`: `adjudicated / violates-decision` を追加。
- **Done**: 「Payment ↛ Shipping」のような制約違反が計算で `violates-decision` として出る。
  決定後にモデル未更新なものが `adjudicated` になる。

## M5 — 手作業キュー & 焼き込み（運用で効く簡素化）✅ 実装済み

reconciler を状態を持つものにする。

- `reconciler/queue.ts`: threshold 未満を手作業キューへ。判断を `registry.json` に焼き込む。
- 2回目以降は新規・変更だけを聞く(feedback→known-findings の同一性版)。
- **Done**: 同じプロジェクトを再実行すると、人が見るのは前回から変わった概念だけ。

---

## 後回しでよいもの（v2 候補）

- `packages/llm` への LLM クライアント一本化(実在する重複だが急がない)。
- viewer の作り込み(ズーム/パン、クロスリファレンス等。rdra viewer 相当)。
- monorepo の CI/リリース整備(TS/Python 混在が無くなった後でよい)。
