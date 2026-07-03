// packages/structure/src/analyze/source-parser.ts
//
// ← extraction/source_parser.py. LLM-driven, language/framework-agnostic source
// parsing. The project context (CLAUDE.md/AGENTS.md + manifests + framework knowledge)
// is injected into every prompt; the prompts themselves are ported verbatim from the
// original so behaviour is preserved. Two paths, same as the original:
//   - provider.analyzeCodebase present (Claude Code CLI) → autonomous exploration
//   - otherwise an API provider → context-only inference
//   - no provider → empty (the analyze CLI then falls back to the static fixture)

import { buildContext, formatContextForPrompt } from "./context/project-context.js";
import type { LlmProvider } from "./llm/provider.js";

const ENTITY_BATCH_SIZE = 20;

export interface ParsedRoute {
  method: string;
  path: string;
  controller: string;
  action: string;
  middleware: string[];
  prefix: string;
}

export interface ParsedController {
  classNameRef: string;
  filePath: string;
  namespace: string;
  methods: string[];
  docblocks: Record<string, string>;
  requestRules: Record<string, string[]>;
  entityOperations: Record<string, EntityOperation[]>;
}

export interface ParsedModel {
  className: string;
  tableName: string;
  fillable: string[];
  relationships: string[];
  casts: Record<string, string>;
  scopes: string[];
}

export interface ParsedPage {
  routePath: string;
  filePath: string;
  componentName: string;
  pageType: string;
  apiCalls: string[];
  importedHooks: string[];
  formFields: string[];
  featureComponent: string;
}

export interface EntityOperation {
  entityClass: string;
  operation: string; // "Create" | "Read" | "Update" | "Delete"
  methodSignature: string;
  sourceFile: string;
  sourceClass: string;
  sourceMethod: string;
  callChain: string[];
}

export interface RepoParseResult {
  routes: ParsedRoute[];
  controllers: ParsedController[];
  models: ParsedModel[];
  pages: ParsedPage[];
  entityOperations: EntityOperation[];
}

export class SourceParser {
  constructor(private readonly llm: LlmProvider | null = null) {}

  async parseRepo(
    repoPath: string,
    opts: { skipEntityOperations?: boolean } = {},
  ): Promise<RepoParseResult> {
    const context = formatContextForPrompt([buildContext(repoPath)]);

    if (this.llm && typeof this.llm.analyzeCodebase === "function") {
      const [routes, controllers, models, pages] = await Promise.all([
        this.extractRoutesLlm(repoPath, context),
        this.extractControllersLlm(repoPath, context),
        this.extractModelsLlm(repoPath, context),
        this.extractPagesLlm(repoPath, context),
      ]);
      // entity operations are the slowest pass (autonomous, batched over models) and
      // only matter once behavior is present to attach. Skippable for structure-only runs.
      const entityOperations = opts.skipEntityOperations
        ? []
        : await this.extractEntityOperationsLlm(repoPath, context, models);
      this.attachOperationsToControllers(controllers, entityOperations);
      return { routes, controllers, models, pages, entityOperations };
    }

    if (this.llm) {
      const routes = await this.extractRoutesApi(context);
      const models = await this.extractModelsApi(context);
      const entityOperations = await this.extractEntityOperationsApi(context, models, []);
      return { routes, controllers: [], models, pages: [], entityOperations };
    }

    return { routes: [], controllers: [], models: [], pages: [], entityOperations: [] };
  }

  // ---- LLM-driven extraction (analyzeCodebase) ----------------------------

  private async analyze(repoPath: string, prompt: string, label: string): Promise<string> {
    try {
      return await this.llm!.analyzeCodebase!(repoPath, prompt);
    } catch (e) {
      console.error(`  [warn] ${label}抽出に失敗: ${(e as Error).message}`);
      return "";
    }
  }

  private async extractRoutesLlm(repoPath: string, context: string): Promise<ParsedRoute[]> {
    const prompt = `${context}

上記のプロジェクト情報を参考に、このリポジトリのAPIルート/エンドポイント定義を探して抽出してください。

手順:
1. CLAUDE.md や AGENTS.md に記載されたプロジェクト構造を参考に、ルーティング定義ファイルを特定する
2. フレームワークに応じた方法でルートを抽出する:
   - Laravel: routes/*.php
   - Rails: config/routes.rb
   - Express/Fastify: ルーターファイル（app.get, router.post 等）
   - Django: urls.py
   - Spring Boot: @RequestMapping, @GetMapping 等のアノテーション
   - FastAPI: @app.get, @router.post 等のデコレーター
   - Go (Echo/Gin/Chi): e.GET, r.Get 等のルート登録
   - その他: フレームワークに応じて適切に判断
3. 最大200件のルートを抽出する

以下のJSON形式のみを返してください（説明不要）:
{
  "routes": [
    {
      "method": "GET",
      "path": "/api/users",
      "controller": "UserController",
      "action": "index",
      "middleware": ["auth"],
      "prefix": "/api"
    }
  ]
}`;
    return this.parseRoutesJson(await this.analyze(repoPath, prompt, "ルート"));
  }

  private async extractControllersLlm(repoPath: string, context: string): Promise<ParsedController[]> {
    const prompt = `${context}

上記のプロジェクト情報を参考に、このリポジトリの主要なコントローラー/ハンドラー/ルートハンドラーを抽出してください。

手順:
1. CLAUDE.md や AGENTS.md の情報をもとに、ビジネスロジックを含むハンドラー層を特定する
2. 各ハンドラーのクラス名（またはモジュール名）、公開メソッド、バリデーションルールを抽出
3. 最大50件を対象とする

以下のJSON形式のみを返してください（説明不要）:
{
  "controllers": [
    {
      "class_name": "UserController",
      "file_path": "app/Http/Controllers/UserController.php",
      "namespace": "App\\Http\\Controllers",
      "methods": ["index", "show", "store", "update", "destroy"],
      "docblocks": {"index": "ユーザー一覧を取得"},
      "request_rules": {"store": ["name", "email", "password"]}
    }
  ]
}`;
    return this.parseControllersJson(await this.analyze(repoPath, prompt, "コントローラー"));
  }

  private async extractModelsLlm(repoPath: string, context: string): Promise<ParsedModel[]> {
    const prompt = `${context}

上記のプロジェクト情報を参考に、このリポジトリのデータモデル/エンティティ定義を抽出してください。

手順:
1. CLAUDE.md や AGENTS.md の情報をもとに、モデル/エンティティ層を特定する
2. フレームワークに応じた方法でモデルを抽出する:
   - Laravel: app/Models/*.php（Eloquent）
   - Rails: app/models/*.rb（ActiveRecord）
   - Django: models.py（Django ORM）
   - Spring Boot: @Entity アノテーション（JPA）
   - SQLAlchemy: Model クラス
   - Prisma: schema.prisma
   - TypeORM: @Entity デコレーター
   - Go: 構造体（struct）+ DB タグ
   - その他: フレームワークに応じて適切に判断
3. 各モデルのクラス名、テーブル名、フィールド、リレーションを抽出
4. 最大100件を対象とする

以下のJSON形式のみを返してください（説明不要）:
{
  "models": [
    {
      "class_name": "User",
      "table_name": "users",
      "fillable": ["name", "email", "password"],
      "relationships": ["posts (hasMany)", "profile (hasOne)"],
      "casts": {"email_verified_at": "datetime"},
      "scopes": ["active", "admin"]
    }
  ]
}`;
    return this.parseModelsJson(await this.analyze(repoPath, prompt, "モデル"));
  }

  private async extractPagesLlm(repoPath: string, context: string): Promise<ParsedPage[]> {
    const prompt = `${context}

上記のプロジェクト情報を参考に、このリポジトリのビュー/ページ/画面定義を抽出してください。

手順:
1. CLAUDE.md や AGENTS.md の情報をもとに、UI層（ページ/ビュー/テンプレート）を特定する
2. フレームワークに応じた方法でページを抽出する:
   - Next.js: app/**/page.tsx または pages/**/*.tsx
   - Nuxt: pages/**/*.vue
   - React Router: ルート定義コンポーネント
   - Vue Router: router 定義
   - Rails: app/views/**/*.erb
   - Django: templates/**/*.html
   - Blade (Laravel): resources/views/**/*.blade.php
   - Svelte: src/routes/**/*.svelte
   - その他: フレームワークに応じて適切に判断
3. もしフロントエンドが存在しないAPI専用プロジェクトの場合は、空の配列を返す
4. 各ページのURLパス、ファイルパス、種別（一覧/詳細/フォーム等）、API呼び出しを抽出
5. 最大50件を対象とする

以下のJSON形式のみを返してください（説明不要）:
{
  "pages": [
    {
      "route_path": "/users",
      "file_path": "app/(dashboard)/users/page.tsx",
      "component_name": "UserList",
      "page_type": "list",
      "api_calls": ["GET /api/users"],
      "imported_hooks": ["useUsersIndex"],
      "form_fields": [],
      "feature_component": ""
    }
  ]
}`;
    return this.parsePagesJson(await this.analyze(repoPath, prompt, "ページ"));
  }

  private async extractEntityOperationsLlm(
    repoPath: string,
    context: string,
    models: ParsedModel[],
  ): Promise<EntityOperation[]> {
    if (models.length === 0) return [];
    const all: EntityOperation[] = [];
    for (let i = 0; i < models.length; i += ENTITY_BATCH_SIZE) {
      const batch = models.slice(i, i + ENTITY_BATCH_SIZE);
      all.push(...(await this.extractEntityOperationsBatch(repoPath, context, batch)));
    }
    return all;
  }

  private async extractEntityOperationsBatch(
    repoPath: string,
    context: string,
    models: ParsedModel[],
  ): Promise<EntityOperation[]> {
    const entityList = models.map((m) => `- ${m.className} (table: ${m.tableName})`).join("\n");
    const prompt = `${context}

## 対象エンティティ
${entityList}

## 指示

上記のエンティティに対するCRUD操作を、ソースコードから検出してください。

### 優先順位
1. CLAUDE.md / AGENTS.md に記載されたアーキテクチャ・規約（最優先）
2. プロジェクトの実際のソースコード
3. フレームワーク知識（上記が不明確な場合のフォールバック）

### 手順
1. 各エンティティのモデル/エンティティクラスのソースコードを確認する
2. そのエンティティに対してCreate/Read/Update/Deleteを行っているコードを
   プロジェクト全体から探す（Controller, Service, Repository, Job, EventListener等）
3. 各操作について、呼び出し元をControllerメソッドまで遡って追跡する
4. 1つのControllerメソッドが複数エンティティを操作している場合、すべて記録する

### 注意
- HTTPメソッドではなく、実際のコード上のCRUD操作で判断すること
- 間接的な操作も検出すること
  例: OrderController.store() → OrderService.createOrder() → Stock::decrement()
  この場合 Stock に対する Update 操作として記録
- Cascade削除やイベントリスナー経由の操作も可能な範囲で検出する

以下のJSON形式のみを返してください（説明不要）:
{
  "entity_operations": [
    {
      "entity_class": "Stock",
      "operation": "Update",
      "method_signature": "Stock::where(...)->decrement('qty')",
      "source_file": "app/Services/OrderService.php",
      "source_class": "OrderService",
      "source_method": "createOrder",
      "call_chain": ["OrderController.store", "OrderService.createOrder"]
    }
  ]
}`;
    return this.parseEntityOperationsJson(await this.analyze(repoPath, prompt, "エンティティ操作"));
  }

  /**
   * Trace each route's handler through the code to find which domain events it emits.
   * `eventNames` is the deterministically-scanned event set — the model name-matches
   * against it so we only link known events (no invented names). Returns a map keyed by
   * "METHOD path" → event names. Requires the autonomous (analyzeCodebase) backend; with
   * no such provider, or no routes/events, returns {} and the linkage stays empty.
   */
  async extractRouteEvents(
    repoPath: string,
    context: string,
    routes: ParsedRoute[],
    eventNames: string[],
  ): Promise<Record<string, string[]>> {
    if (!this.llm || typeof this.llm.analyzeCodebase !== "function") return {};
    if (routes.length === 0 || eventNames.length === 0) return {};

    const routeList = routes
      .map((r) => `- ${r.method.toUpperCase()} ${r.path}${r.controller || r.action ? ` (${r.controller}${r.action ? `.${r.action}` : ""})` : ""}`)
      .join("\n");
    const eventList = eventNames.map((e) => `- ${e}`).join("\n");
    const prompt = `${context}

## 対象ルート
${routeList}

## 既知のドメインイベント（コードから検出済み）
${eventList}

## 指示

各ルートのハンドラを起点にコードを辿り、そのリクエスト処理の中で発火する「既知のドメインイベント」を特定してください。

### 優先順位
1. CLAUDE.md / AGENTS.md に記載されたアーキテクチャ・規約（最優先）
2. プロジェクトの実際のソースコード
3. フレームワーク知識（上記が不明確な場合のフォールバック）

### 手順
1. ルートのハンドラ（Controller/handler のメソッド）のソースを特定する
2. そのメソッドから呼ばれる Service/Repository/Job/EventListener を遡って辿る
3. 処理の中で発火（new/emit/publish/dispatch/raise/fire/record 等）される event を検出する
4. 1ルートが複数 event を発火する場合はすべて記録する（1対多）

### 注意
- 必ず「既知のドメインイベント」リストにある名前だけを使うこと（リストに無い名前は出さない）
- 間接的な発火（Service 経由・リスナー経由）も可能な範囲で検出する
- どの event も発火しないルートは events を空配列にするか、省略してよい

以下のJSON形式のみを返してください（説明不要）:
{
  "route_events": [
    { "method": "POST", "path": "/reservations", "events": ["ReservationCreated", "RoomAssigned"] }
  ]
}`;
    return this.parseRouteEventsJson(await this.analyze(repoPath, prompt, "ルート→イベント"), eventNames);
  }

  // ---- API-only (context-based) extraction --------------------------------

  private async extractRoutesApi(context: string): Promise<ParsedRoute[]> {
    const system = "あなたはソフトウェアアーキテクチャの専門家です。プロジェクト情報からAPIルートを推定してください。";
    const user = `${context}

上記の情報から、このプロジェクトに存在すると推定されるAPIルートを抽出してください。
CLAUDE.md やディレクトリ構造から読み取れる範囲で推定してください。

以下のJSON形式のみで返してください:
{
  "routes": [
    {"method": "GET", "path": "/api/users", "controller": "UserController", "action": "index", "middleware": [], "prefix": ""}
  ]
}`;
    try {
      return this.parseRoutesJson(await this.llm!.completeSimple(user, system));
    } catch {
      return [];
    }
  }

  private async extractModelsApi(context: string): Promise<ParsedModel[]> {
    const system = "あなたはソフトウェアアーキテクチャの専門家です。プロジェクト情報からデータモデルを推定してください。";
    const user = `${context}

上記の情報から、このプロジェクトに存在すると推定されるデータモデル/エンティティを抽出してください。
CLAUDE.md やディレクトリ構造から読み取れる範囲で推定してください。

以下のJSON形式のみで返してください:
{
  "models": [
    {"class_name": "User", "table_name": "users", "fillable": ["name", "email"], "relationships": [], "casts": {}, "scopes": []}
  ]
}`;
    try {
      return this.parseModelsJson(await this.llm!.completeSimple(user, system));
    } catch {
      return [];
    }
  }

  private async extractEntityOperationsApi(
    context: string,
    models: ParsedModel[],
    controllers: ParsedController[],
  ): Promise<EntityOperation[]> {
    const entityList = models.map((m) => `- ${m.className} (table: ${m.tableName})`).join("\n");
    const controllerList = controllers.map((c) => `- ${c.classNameRef}: ${c.methods.join(", ")}`).join("\n");
    const system = "あなたはソフトウェアアーキテクチャの専門家です。プロジェクト情報からエンティティのCRUD操作を推定してください。";
    const user = `${context}

## 対象エンティティ
${entityList}

## コントローラー一覧
${controllerList}

上記の情報から、各エンティティに対するCRUD操作とその呼び出し元を推定してください。
CLAUDE.md / AGENTS.md の規約を最優先し、次にフレームワーク知識で推定してください。

以下のJSON形式のみで返してください:
{
  "entity_operations": [
    {
      "entity_class": "User",
      "operation": "Create",
      "method_signature": "",
      "source_file": "",
      "source_class": "UserController",
      "source_method": "store",
      "call_chain": ["UserController.store"]
    }
  ]
}`;
    try {
      return this.parseEntityOperationsJson(await this.llm!.completeSimple(user, system));
    } catch {
      return [];
    }
  }

  // ---- JSON parsing (← _extract_json + parsers) ---------------------------

  extractJson(text: string): Record<string, unknown> {
    let cleaned = text.replace(/```(?:json)?\s*/g, "").trim();
    cleaned = cleaned.replace(/```\s*$/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  parseRoutesJson(text: string): ParsedRoute[] {
    const data = this.extractJson(text);
    const items = (data.routes as Array<Record<string, unknown>>) ?? [];
    return items.map((i) => ({
      method: String(i.method ?? "GET"),
      path: String(i.path ?? ""),
      controller: String(i.controller ?? ""),
      action: String(i.action ?? ""),
      middleware: (i.middleware as string[]) ?? [],
      prefix: String(i.prefix ?? ""),
    }));
  }

  parseControllersJson(text: string): ParsedController[] {
    const data = this.extractJson(text);
    const items = (data.controllers as Array<Record<string, unknown>>) ?? [];
    return items.map((i) => ({
      classNameRef: String(i.class_name ?? ""),
      filePath: String(i.file_path ?? ""),
      namespace: String(i.namespace ?? ""),
      methods: (i.methods as string[]) ?? [],
      docblocks: (i.docblocks as Record<string, string>) ?? {},
      requestRules: (i.request_rules as Record<string, string[]>) ?? {},
      entityOperations: {},
    }));
  }

  parseModelsJson(text: string): ParsedModel[] {
    const data = this.extractJson(text);
    const items = (data.models as Array<Record<string, unknown>>) ?? [];
    return items.map((i) => ({
      className: String(i.class_name ?? ""),
      tableName: String(i.table_name ?? ""),
      fillable: (i.fillable as string[]) ?? [],
      relationships: (i.relationships as string[]) ?? [],
      casts: (i.casts as Record<string, string>) ?? {},
      scopes: (i.scopes as string[]) ?? [],
    }));
  }

  parsePagesJson(text: string): ParsedPage[] {
    const data = this.extractJson(text);
    const items = (data.pages as Array<Record<string, unknown>>) ?? [];
    return items.map((i) => ({
      routePath: String(i.route_path ?? ""),
      filePath: String(i.file_path ?? ""),
      componentName: String(i.component_name ?? ""),
      pageType: String(i.page_type ?? "list"),
      apiCalls: (i.api_calls as string[]) ?? [],
      importedHooks: (i.imported_hooks as string[]) ?? [],
      formFields: (i.form_fields as string[]) ?? [],
      featureComponent: String(i.feature_component ?? ""),
    }));
  }

  parseEntityOperationsJson(text: string): EntityOperation[] {
    const data = this.extractJson(text);
    const items = (data.entity_operations as Array<Record<string, unknown>>) ?? [];
    return items.map((i) => {
      const rawChain = i.call_chain;
      const callChain = Array.isArray(rawChain) ? (rawChain as string[]) : rawChain ? [String(rawChain)] : [];
      return {
        entityClass: String(i.entity_class ?? ""),
        operation: String(i.operation ?? ""),
        methodSignature: String(i.method_signature ?? ""),
        sourceFile: String(i.source_file ?? ""),
        sourceClass: String(i.source_class ?? ""),
        sourceMethod: String(i.source_method ?? ""),
        callChain,
      };
    });
  }

  /**
   * Parse the route→events JSON into a map keyed by "METHOD path". Events are filtered to
   * the known set (case-insensitive) so only real, scanned events survive — a model that
   * invents a name contributes nothing. Empty/duplicate event lists are dropped.
   */
  parseRouteEventsJson(text: string, knownEvents: string[]): Record<string, string[]> {
    const known = new Map(knownEvents.map((e) => [e.toLowerCase(), e]));
    const data = this.extractJson(text);
    const items = (data.route_events as Array<Record<string, unknown>>) ?? [];
    const out: Record<string, string[]> = {};
    for (const i of items) {
      const method = String(i.method ?? "").toUpperCase();
      const path = String(i.path ?? "");
      if (!method || !path) continue;
      const raw = Array.isArray(i.events) ? (i.events as unknown[]) : [];
      const events = [...new Set(raw.map((e) => known.get(String(e).toLowerCase())).filter((e): e is string => Boolean(e)))];
      if (events.length === 0) continue;
      const key = `${method} ${path}`;
      out[key] = [...new Set([...(out[key] ?? []), ...events])];
    }
    return out;
  }

  attachOperationsToControllers(controllers: ParsedController[], operations: EntityOperation[]): void {
    const index = new Map<string, ParsedController>();
    for (const c of controllers) index.set(c.classNameRef, c);
    for (const op of operations) {
      if (op.callChain.length === 0) continue;
      const first = op.callChain[0]!;
      if (!first.includes(".")) continue;
      const idx = first.lastIndexOf(".");
      const ctrlName = first.slice(0, idx);
      const methodName = first.slice(idx + 1);
      const ctrl = index.get(ctrlName);
      if (!ctrl) continue;
      (ctrl.entityOperations[methodName] ??= []).push(op);
    }
  }
}
