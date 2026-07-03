# Discovery

## ビジネス概要

crawl-kit は表面上「意図した／作った／動いているソフトウェアのずれ」を扱うが、**本質は検証**である。
intent（こう作りたい）と structure（こう作った＝コード）が決まれば、behavior（こう動く）は**自ずと決まる**。
よって crawl-kit の元々の用途は、**設計（intent＋structure）から決まるはずの挙動を、実際に走らせて
「想定通り動くか」を確かめる検証**にある（loop-e2e: AI 駆動クロール＋検証ループの出自）。
挙動は第三の対等な意見ではなく、設計を裏取りする**結果（オラクル）**。

## 非対称モデル（重要な気づき）

三層は対等な三角形ではない。「差分」という語は誤りで、**観点の違う三つのレンズを一箇所に集めること自体は差分ではない**。
正しくは非対称:

- **intent / structure = 宣言（設計）**。「決める」もの。両者の比較だけが本来の **差分（intent↔structure）**。
- **behavior = 結果**。設計から決まる。その役割は **検証（合否）**。

→ 「三辺の差分」ではなく **「1本の差分（intent↔structure）＋ それを実地で検証する behavior」** に畳まれる。
behavior は名寄せ・登録の対等な対象ではなく、**静的な『こう動くはず』を実行時の事実で裏取りし、
嘘（バグ・未実装・想定外）を捕まえる検証器**。

## Core Domain

- **名前**: 検証（Verification）— 挙動コンフォーマンス
- **理由**: 元々の用途であり、設計から決まる*はず*の挙動を実行して裏取りする部分が、
  人手でも既製品でも代替しにくい競争優位。コード上の中心は **packages/behavior**（クロール＋検証）。
- **差別化要因**: 静的解析の「こう動くはず」を、実行時の事実で裏取りする。設計と現実の食い違いを実地で炙り出す。

### なぜ D（intent↔structure の差分）はコアでないか

intent は **distill-ddd（外部ツール）が供給**し、crawl-kit は intent を所有しない。
intent↔structure の差分はその外部供給に依存するため、crawl-kit のコアにはなり得ない。
（distill-ddd が接続されれば「intent↔behavior 検証」という上位の検証に広がるが、それは拡張であって前提ではない。）

## Supporting Subdomains

- **structure 抽出（rdra-analyzer 由来 / packages/structure）**: 検証が照合する**期待（仕様）**を供給する。
- **正準レジストリ・名寄せ（packages/reconciler の一部）**: 期待（structure）と挙動（behavior）を
  「同じモノ」として突き合わせる土台。これが無いと「集めただけ」で検証にならない。
- **収束ループ（corrections / decisions の焼き込み）**: 期待がコードの進化に追従し続けるための運用。
- **取得鮮度（増分再取得 / Acquisition Freshness）**: structure / behavior の「広く全体取得」を鮮度判定で間引く。詳細は末尾の専用節。

## Generic / 範囲外

- **intent（distill-ddd）**: 外部ツール。任意の上流供給。crawl-kit は所有しない。
- **viewer 描画 / contract の I/O・検証**: 汎用。代替可能。

## SWOT（任意・暫定）

| Strengths | Weaknesses |
|---|---|
| 実行時検証の出自（loop-e2e）。三層を同じ ID で束ねる正準レジストリ | Core（検証）より周辺（reconciler intent 辺）を作り込んでしまった重心ズレ |

| Opportunities | Threats |
|---|---|
| distill-ddd 接続で intent↔behavior 検証へ拡張。CI で PR ごとに検証 | intent を外部依存にしたままだと「設計整合の差分」は弱いまま |

## 未解決の問い

- 既に作った reconciler の **intent 辺（8状態分類・ADR オーバーレイ）は、検証コアに対して Supporting か、範囲外か**。
  検証中心に据え直すと、何が中心で何が周辺に動くか（重心の再配置）。
- 検証が照合する**「期待」は structure だけで十分か**。intent が無いと弱くなるのはどの種類の検証か。
- 「検証」の単位は何か（ルート？シナリオ？ユースケース？）。次フェーズ（storming）の出発点。

## 取得鮮度（増分再取得 / Acquisition Freshness）— Supporting

structure / behavior を毎回フル取得するのは高い（特に LLM 解析）。そこで**鮮度判定で間引く**。
**取得単位（再取得が走る粒度）** と **変化シグナル（鮮度判定）** を分離する。

### 原則

- **変化シグナル = 全ファイルの内容ハッシュ**（route/view も含め一律ファイル単位）。
  ハッシュ計算はローカルで安く、LLM 取得は高い ── コストが非対称なので、安い側で精密に間引く。
  「ファイル名リストのみ」案の上位互換（内容編集も検知でき、既存ファイルへの route 追記も拾える＝矛盾なし）。
- **TTL は単一値**で structure / behavior 共通。

### structure

- **取得単位 = ディレクトリ**（設定したソースルート配下を再帰）。`lastAcquiredAt` は**ディレクトリ名を鍵**に保持。
- **再取得条件**: `now − lastAcquiredAt[dir] > TTL` **または** 配下ファイルの内容ハッシュ集合に差（追加/削除/編集/リネーム）。
- ファイルリスト不変（＝ハッシュ不変）なら構造は変わっていないとみなし**間引く（cull）**。

### behavior

- **取得単位 = ページ（route）**。`lastCrawledAt` をページ鍵で保持。
- **再取得条件**: `now − lastCrawledAt[page] > TTL` **または** ページの backing view/route ファイルのハッシュ変化
  **または** structure の route/page セット差分（増えたページは crawl、消えたページは drop）。

### 既存資産と新規

- **既存**: router 判定 = `ParsedRoute`、view/page 判定 = `ParsedPage`（`extractRoutesLlm` / `extractPagesLlm`）。→ view層・router 検知は作成不要。
- **新規**: ①鮮度ストア（`data/acquisition.json`）、②全ファイルのハッシュ走査、③route/page 集合の差分検知（前回スナップショット比較）→ behavior 増分。

### 鮮度ストア（`data/acquisition.json`）

```jsonc
{
  "ttlSeconds": 86400,                 // structure/behavior 共通
  "structure": { "<dir>": { "lastAcquiredAt": "ISO", "files": { "<path>": "<hash>" } } },
  "behavior":  { "<route>": { "lastCrawledAt": "ISO", "viewFiles": { "<path>": "<hash>" } } }
}
```

### 未解決の細目

- ソースルートの指定方法（CLAUDE.md / 設定ファイル / 既定 glob）。
- ハッシュ対象の拡張子・ignore（node_modules/dist 等は既存 ignore を流用）。
- 初回（スナップショット無し）は全取得。`--force` で鮮度無視の全再取得。
