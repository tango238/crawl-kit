// packages/structure/src/analyze/usecase-extractor.ts
//
// ← extraction/usecase_extractor.py. Turns parsed routes/controllers/models/pages into
// usecases via the LLM (prompts ported verbatim), with the deterministic dedup / id
// assignment / controller+page enrichment / fallback grouping preserved exactly so the
// no-LLM path produces the same result the Python tool's --skip-llm did.

import type { LlmProvider } from "./llm/provider.js";
import type { ParsedController, ParsedModel, ParsedPage, ParsedRoute } from "./source-parser.js";

export interface UseCase {
  id: string;
  name: string;
  actor: string;
  description: string;
  preconditions: string[];
  postconditions: string[];
  relatedRoutes: string[];
  relatedPages: string[];
  relatedEntities: string[];
  category: string;
  priority: string;
  relatedControllers: string[];
  relatedViews: string[];
}

const BATCH_SIZE = 30;

function apiPathSegments(routeOrCall: string): string[] {
  const parts = routeOrCall.split(" ");
  const path = parts.length >= 2 ? parts.slice(1).join(" ") : parts[0]!;
  return path.split("?")[0]!.trim().replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

function segEq(a: string, b: string): boolean {
  if (a.startsWith(":") || (a.startsWith("{") && a.endsWith("}"))) return true;
  if (b.startsWith(":") || (b.startsWith("{") && b.endsWith("}"))) return true;
  return a === b;
}

function apiPathsMatch(a: string[], b: string[]): boolean {
  const n = Math.min(a.length, b.length);
  if (n === 0) return false;
  if (n < 2 && a.length !== b.length) return false;
  const aTail = a.slice(a.length - n);
  const bTail = b.slice(b.length - n);
  return aTail.every((x, i) => segEq(x, bTail[i]!));
}

export class UseCaseExtractor {
  constructor(
    private readonly llm: LlmProvider | null,
    private readonly projectContext = "",
  ) {}

  async extract(
    routes: ParsedRoute[],
    controllers: ParsedController[],
    models: ParsedModel[],
    pages: ParsedPage[],
  ): Promise<UseCase[]> {
    const context = this.buildContext(models, pages);
    let usecases: UseCase[] = [];

    if (this.llm) {
      for (const batch of this.splitIntoBatches(routes, BATCH_SIZE)) {
        usecases.push(...(await this.extractBatch(batch, context)));
      }
    } else {
      usecases = this.fallbackExtraction(routes);
    }

    usecases = this.deduplicate(usecases);
    usecases = this.assignIds(usecases);
    this.enrichControllers(usecases, routes);
    this.enrichPages(usecases, pages);
    return usecases;
  }

  private buildContext(models: ParsedModel[], pages: ParsedPage[]): string {
    const parts: string[] = [];
    if (this.projectContext) {
      parts.push("# プロジェクトコンテキスト", this.projectContext, "");
    }
    const modelNames = models.slice(0, 50).map((m) => m.className);
    if (modelNames.length > 0) {
      parts.push("## エンティティ/モデル", modelNames.join(", "), "");
    }
    if (pages.length > 0) {
      const lines = pages.slice(0, 40).map((p) => {
        let line = `  ${p.routePath}`;
        if (p.importedHooks.length) line += ` [hooks: ${p.importedHooks.slice(0, 3).join(", ")}]`;
        if (p.formFields.length) line += ` [fields: ${p.formFields.slice(0, 5).join(", ")}]`;
        if (p.apiCalls.length) line += ` [api: ${p.apiCalls.slice(0, 2).join(", ")}]`;
        return line;
      });
      parts.push("## ページ/ビュー", lines.join("\n"), "");
    }
    return parts.join("\n");
  }

  private splitIntoBatches(routes: ParsedRoute[], size: number): ParsedRoute[][] {
    const batches: ParsedRoute[][] = [];
    for (let i = 0; i < routes.length; i += size) batches.push(routes.slice(i, i + size));
    return batches;
  }

  private async extractBatch(routes: ParsedRoute[], context: string): Promise<UseCase[]> {
    const routesText = routes
      .map((r) => `- ${r.method.padEnd(7)} ${r.path.padEnd(50)} [${r.controller}] middleware=${r.middleware.length ? r.middleware.join(", ") : "なし"}`)
      .join("\n");

    const system = `あなたはRDRA（Relationship-Driven Requirements Analysis）の専門家です。
APIルートとプロジェクト情報を分析して、ユースケースを抽出してください。

以下のJSON形式で回答してください（コードブロック不要）:
{
  "usecases": [
    {
      "name": "ユースケース名（日本語）",
      "actor": "アクター名",
      "description": "概要説明",
      "preconditions": ["事前条件1", "事前条件2"],
      "postconditions": ["事後条件1"],
      "related_routes": ["GET /users", "POST /users"],
      "related_entities": ["User", "Profile"],
      "category": "カテゴリ名",
      "priority": "high|medium|low"
    }
  ]
}

ルールと指示:
- 複数の関連ルートを1つのユースケースにまとめる（例: CRUD操作は1つの「管理」ユースケースに）
- アクター名はプロジェクトコンテキストから推定する（不明な場合は「ユーザー」「管理者」「システム」を使用）
- カテゴリは業務ドメインで分類する
- 日本語で出力する`;

    const user = `
${context}

## 解析対象APIルート

${routesText}

上記のAPIルートからユースケースを抽出してください。
`;
    try {
      return this.parseResponse(await this.llm!.completeSimple(user, system), routes);
    } catch {
      return this.fallbackExtraction(routes);
    }
  }

  private parseResponse(response: string, routes: ParsedRoute[]): UseCase[] {
    let cleaned = response.replace(/```(?:json)?\s*/g, "").trim();
    cleaned = cleaned.replace(/```\s*$/g, "").trim();
    try {
      const data = JSON.parse(cleaned) as { usecases?: Array<Record<string, unknown>> };
      return (data.usecases ?? []).map((i) => ({
        id: "",
        name: String(i.name ?? "不明なユースケース"),
        actor: String(i.actor ?? "ユーザー"),
        description: String(i.description ?? ""),
        preconditions: (i.preconditions as string[]) ?? [],
        postconditions: (i.postconditions as string[]) ?? [],
        relatedRoutes: (i.related_routes as string[]) ?? [],
        relatedPages: (i.related_pages as string[]) ?? [],
        relatedEntities: (i.related_entities as string[]) ?? [],
        category: String(i.category ?? "その他"),
        priority: String(i.priority ?? "medium"),
        relatedControllers: [],
        relatedViews: [],
      }));
    } catch {
      return this.fallbackExtraction(routes);
    }
  }

  fallbackExtraction(routes: ParsedRoute[]): UseCase[] {
    const groups = new Map<string, ParsedRoute[]>();
    for (const route of routes) {
      let entity = route.controller.replace(/(Controller|Handler|Service|Resource|View)$/, "");
      if (!entity) entity = route.controller || "Unknown";
      (groups.get(entity) ?? groups.set(entity, []).get(entity)!).push(route);
    }
    const usecases: UseCase[] = [];
    for (const [entity, entityRoutes] of groups) {
      const methods = [...new Set(entityRoutes.map((r) => r.method))];
      usecases.push({
        id: "",
        name: `${entity}管理`,
        actor: "ユーザー",
        description: `${entity}の管理操作（${methods.join(", ")}）`,
        preconditions: ["認証済みであること"],
        postconditions: [],
        relatedRoutes: entityRoutes.map((r) => `${r.method} ${r.path}`),
        relatedPages: [],
        relatedEntities: [entity],
        category: "管理",
        priority: "medium",
        relatedControllers: [],
        relatedViews: [],
      });
    }
    return usecases;
  }

  private deduplicate(usecases: UseCase[]): UseCase[] {
    const seen = new Set<string>();
    const result: UseCase[] = [];
    for (const uc of usecases) {
      if (!seen.has(uc.name)) {
        seen.add(uc.name);
        result.push(uc);
      }
    }
    return result;
  }

  private assignIds(usecases: UseCase[]): UseCase[] {
    usecases.forEach((uc, i) => {
      uc.id = `UC-${String(i + 1).padStart(3, "0")}`;
    });
    return usecases;
  }

  enrichControllers(usecases: UseCase[], routes: ParsedRoute[]): void {
    const pathToController = new Map<string, string>();
    for (const r of routes) {
      if (r.controller) pathToController.set(`${r.method} ${r.path}`, r.controller);
      pathToController.set(r.path, r.controller);
    }
    for (const uc of usecases) {
      const controllers = new Set<string>();
      for (const routeStr of uc.relatedRoutes) {
        let ctrl = pathToController.get(routeStr);
        if (!ctrl) {
          const parts = routeStr.split(" ");
          if (parts.length >= 2) ctrl = pathToController.get(parts.slice(1).join(" "));
        }
        if (ctrl) controllers.add(ctrl);
      }
      uc.relatedControllers = [...controllers].sort();
    }
  }

  enrichPages(usecases: UseCase[], pages: ParsedPage[]): void {
    if (pages.length === 0) return;
    for (const uc of usecases) {
      const views = new Set<string>(uc.relatedViews);
      const relatedPages = new Set<string>(uc.relatedPages);
      const ucKeys = uc.relatedRoutes.map(apiPathSegments);
      for (const page of pages) {
        for (const apiCall of page.apiCalls) {
          const callKey = apiPathSegments(apiCall);
          if (ucKeys.some((k) => apiPathsMatch(callKey, k))) {
            let label = page.componentName || page.routePath;
            if (page.routePath && page.routePath !== label) label = `${page.componentName} (${page.routePath})`;
            views.add(label);
            if (page.routePath) relatedPages.add(page.routePath);
            break;
          }
        }
      }
      uc.relatedViews = [...views].sort();
      uc.relatedPages = [...relatedPages].sort();
    }
  }
}
