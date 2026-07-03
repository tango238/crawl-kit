# ARCHITECTURE

設計の全体像と、その判断理由。新しく入る人がまず読む一枚。

## ひとつの仕事

このスイートの仕事は一文に畳める:

> **意図したソフトウェア・作ったソフトウェア・動いているソフトウェアが、同じものかどうかを教える。**

どのプロジェクトも自分自身の三つの版を抱えていて、それらは静かにずれていく。誰も設計と違うものを
出そうとはしない。妥当なコミットを一つずつ積むうちにそうなる。

## 三つのスタンス

| 層 | 何か | 出どころ | 性質 | 担当ツール |
|---|---|---|---|---|
| **intent** | こう作りたい | ドメインモデリング / glossary | should-be・規範的 | distill-ddd |
| **structure** | こう作った | ソースコードの静的解析 | as-built・記述的 | rdra-analyzer |
| **behavior** | こう動いている | 実機のクロール/検証 | as-run・経験的 | loop-e2e |

同じ「ドメイン」という語を使っていても、三つは別々の問いに答えている。

## ダッシュボードではなく差分

価値は三つを並べて見ることではない。三枚の図を別々の名前のままめくっても、頭の中で突き合わせる
労力が増えるだけ——可視化を増やしても理解は増えない。

価値は **三つの角の "辺"(差分)** にある:

```
                 INTENT  (distill-ddd)
                 /                  \
   「意図どおり作れたか」      「ビジネスが欲しかった通りか」
              /                          \
 STRUCTURE ───────────────────────────── BEHAVIOR
 (rdra-analyzer)   「作った通りに動くか」   (loop-e2e)
```

`Order` を一つ選べば、その intent・テーブル群・実行時 findings が並び、食い違う辺が色づく。

## 背骨：正準レジストリと契約

辺を引くには、三層が **同じモノを同じ名前で指す** 必要がある。それを担うのが正準レジストリ。

- 各ドメイン概念に **一つの ID と一つの正準名**。
- 正準名は **glossary(intent)** が発行する。
- structure と behavior は自分の出力に同じ ID を付ける。

全部が同じ ID で串刺しになって初めて、「一箇所」はただの JOIN になる。型の単一の真実は
`packages/contract`(`contract.ts`)。詳細は [docs/DATA-MODEL.md](./DATA-MODEL.md)。

> これが loop-e2e の `rdra-export`(点と点の縫合)を置き換える。縫合ではなく「全員が
> レジストリを参照する」。

## reconciler のパイプライン

```
ingest → match(証拠) → (direction, threshold) → classify → adr → emit
```

設計上の要点:

- **同一性の判定が本体**。差分の解決ではなく、その前の「これとこれは同じか」が難所。
- **証拠は単一スコアにしない**。`name / attributes / topology / behavior / llm` の証拠ベクトル。
  人は「0.82 似てる」では直せないが「同じ属性・違う名前」なら直せる。
- **決定的(構造)を先に、LLM は残りだけ**。LLM には構造証拠を入力として渡し接地させる。
- **自動 or 手動は別機能ではない**。`direction`(intent優先/code優先)と `threshold` の二つの
  ツマミに畳む。閾値以上は自動で寄せ、未満は手作業キューへ。
- **reconciler は状態を持つ**。人の判断を `registry.json` に焼き込む。初回は手作業多め、
  2回目以降は新規・変更だけを聞く(loop-e2e の feedback→known-findings の同一性版)。
- **1:1 を仮定しない**。集約1 ↔ テーブル複数。多対多の `Relation` で持つ。
- **「孤児」と言う前に境界内を見る**。`part-of`(マッチ済み集約の内側)を先に判定すると、
  怖い未マッチの大半が穏やかな aggregate-internal に変わる。

## 色の凡例(ConceptState)

概念は二値の「一致/不一致」ではない。「コードにあるが意図に無い」を一律に欠陥とすると偽陽性で
信頼が死ぬ。だから状態は八つ:`aligned / intent-only / code-only / aggregate-internal /
implementation-detail / adjudicated / violates-decision / unmatched`。

最重要は **violates-decision** —— ADR が「Payment は Shipping に依存しない」と決めたのに
コードがその依存を生やした、を *計算で* 検出する。詳細は [docs/DATA-MODEL.md](./DATA-MODEL.md)。

## ADR は辺の上に乗る裁定者

DDD モデルは意図のスナップショットで「なぜ・いつ」を持たない。ADR がその時間・因果の層。
ADR が無ければ「intent ≠ structure」を、欠陥なのか・意図が進んでモデルが古いだけなのか
区別できない。ADR は概念単位・日付つきの局所的な reconciliation 方針でもある。

スキーマ上は **独立レコード**(`affects: ConceptId[]`)。空配列から育つ。

## データの流れ

```
distill-ddd ─(glossary.json)─┐  intent nodes + 正準ID発行
rdra(structure) ─────────────┤  structure nodes + route key
loop-e2e(behavior) ──────────┘  findings/scenarios + route key
                              ▼
                         reconciler ──読/書──> data/registry.json（永続）
                              └─────書─────> data/unified.json（派生）
                              ▼
                            viewer（描くだけ・状態なし）
```

## ツールの関わり方(三者三様)

- **loop-e2e = 吸収**(すでに TS)。behavior パッケージへ。
- **rdra-analyzer = port**(Python→TS)。**静的抽出コアのみ**。クロール/シナリオ/E2E は持たない。
- **distill-ddd = 参照のみ**。CLI エージェントのホームに住むスキルなのでコード統合しない。
  契約(glossary)だけつながり、正準 ID の発生源になる。

## 検討した代替案

主要な判断は [docs/adr/](./adr/) に記録。要点:

- **monorepo(B)を採用**(ADR-0001)。契約スキーマが初期に揺れるため原子的更新の価値が高い。
- **共有クロールパッケージは作らない**(ADR-0004)。rdra が構造専任になりクロールの共有相手が消えた。
- **verify は reconciler へ**(ADR-0005)。シナリオ×画面は層またぎ照合だから。
- **ADR 層を初日から契約に**(ADR-0006)。空でも在る形にして後付け移行をゼロに。
