import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFrameworks } from "./context/knowledge.js";
import { buildContext } from "./context/project-context.js";
import { InformationModelGenerator } from "./derived/information-model.js";
import { SourceParser } from "./source-parser.js";
import { toStructureExtract } from "./to-extract.js";
import { analyzeRepo } from "./index.js";
import type { LlmProvider } from "./llm/provider.js";
import { emitStructureNodes } from "../emit.js";

// A deterministic stand-in for the LLM: routes/models/etc are keyed off the prompt,
// exactly the shapes the real prompts ask for. Lets us exercise the full LLM-driven
// path offline.
const fakeLlm: LlmProvider = {
  providerName: "fake",
  modelName: "fake",
  async analyzeCodebase(_path, prompt) {
    if (prompt.includes("APIルート/エンドポイント定義")) {
      return '{"routes":[{"method":"GET","path":"/orders","controller":"OrderController","action":"index","middleware":["auth"],"prefix":""},{"method":"POST","path":"/orders","controller":"OrderController","action":"store","middleware":[],"prefix":""}]}';
    }
    if (prompt.includes("コントローラー/ハンドラー")) {
      return '{"controllers":[{"class_name":"OrderController","file_path":"app/Http/Controllers/OrderController.php","namespace":"App","methods":["index","store"],"docblocks":{},"request_rules":{}}]}';
    }
    if (prompt.includes("データモデル/エンティティ定義")) {
      return '{"models":[{"class_name":"Order","table_name":"orders","fillable":["id","customer_id","total"],"relationships":["customer (belongsTo)"],"casts":{},"scopes":[]},{"class_name":"Customer","table_name":"customers","fillable":["id","name","email"],"relationships":[],"casts":{},"scopes":[]}]}';
    }
    if (prompt.includes("ビュー/ページ/画面定義")) {
      return '{"pages":[{"route_path":"/orders","file_path":"app/orders/page.tsx","component_name":"OrderList","page_type":"list","api_calls":["GET /orders"],"imported_hooks":[],"form_fields":[],"feature_component":""}]}';
    }
    if (prompt.includes("CRUD操作を、ソースコードから検出")) {
      return '{"entity_operations":[{"entity_class":"Order","operation":"Create","method_signature":"Order::create","source_file":"x","source_class":"OrderController","source_method":"store","call_chain":["OrderController.store"]}]}';
    }
    return "{}";
  },
  async completeSimple(userMessage) {
    if (userMessage.includes("ユースケースを抽出")) {
      return '{"usecases":[{"name":"注文管理","actor":"ユーザー","description":"注文のCRUD","preconditions":[],"postconditions":[],"related_routes":["GET /orders","POST /orders"],"related_entities":["Order"],"category":"注文","priority":"high"}]}';
    }
    if (userMessage.includes("データモデルについて")) {
      return '{"entities":[{"class_name":"Order","japanese_name":"注文","description":"注文","exclude":false},{"class_name":"Customer","japanese_name":"顧客","description":"顧客","exclude":false}],"relationships":[{"from":"Order","to":"Customer","type":"N-1","label":"属する"}]}';
    }
    return "{}";
  },
};

describe("detectFrameworks", () => {
  it("detects frameworks from manifest contents (ported rules)", () => {
    expect(detectFrameworks({ "package.json": '{"dependencies":{"next":"14"}}' })).toContain("nextjs");
    expect(detectFrameworks({ "composer.json": '{"require":{"laravel/framework":"11"}}' })).toContain("laravel");
    expect(detectFrameworks({ "go.mod": "require github.com/labstack/echo/v4 v4" })).toContain("echo");
  });
});

describe("SourceParser JSON parsing", () => {
  const parser = new SourceParser(null);
  it("strips code fences and parses routes", () => {
    const routes = parser.parseRoutesJson('```json\n{"routes":[{"method":"get","path":"/a","controller":"C","action":"i"}]}\n```');
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/a");
  });
  it("attaches entity operations to controllers via call chain", () => {
    const controllers = parser.parseControllersJson('{"controllers":[{"class_name":"OrderController","methods":["store"]}]}');
    const ops = parser.parseEntityOperationsJson('{"entity_operations":[{"entity_class":"Stock","operation":"Update","call_chain":["OrderController.store"]}]}');
    parser.attachOperationsToControllers(controllers, ops);
    expect(controllers[0]?.entityOperations.store).toHaveLength(1);
  });
});

describe("SourceParser route→event linkage", () => {
  const parser = new SourceParser(null);

  it("parseRouteEventsJson keeps only known events (case-insensitive), dedups, keys by METHOD path", () => {
    const map = parser.parseRouteEventsJson(
      '{"route_events":[{"method":"post","path":"/reservations","events":["ReservationCreated","reservationcreated","Unknown","RoomAssigned"]}]}',
      ["ReservationCreated", "RoomAssigned"],
    );
    expect(map).toEqual({ "POST /reservations": ["ReservationCreated", "RoomAssigned"] });
  });

  it("parseRouteEventsJson drops rows whose events are all unknown/empty", () => {
    const map = parser.parseRouteEventsJson(
      '{"route_events":[{"method":"GET","path":"/x","events":["Nope"]},{"method":"GET","path":"/y","events":[]}]}',
      ["ReservationCreated"],
    );
    expect(map).toEqual({});
  });

  it("extractRouteEvents returns {} with no autonomous backend", async () => {
    expect(await parser.extractRouteEvents("/repo", "ctx", [{ method: "POST", path: "/r", controller: "C", action: "store", middleware: [], prefix: "" }], ["E"])).toEqual({});
  });

  it("extractRouteEvents returns {} when there are no known events", async () => {
    const llm: LlmProvider = { providerName: "f", modelName: "f", async analyzeCodebase() { return '{"route_events":[{"method":"POST","path":"/r","events":["E"]}]}'; }, async completeSimple() { return "{}"; } };
    const p = new SourceParser(llm);
    expect(await p.extractRouteEvents("/repo", "ctx", [{ method: "POST", path: "/r", controller: "C", action: "store", middleware: [], prefix: "" }], [])).toEqual({});
  });

  it("extractRouteEvents traces and name-matches against known events", async () => {
    const llm: LlmProvider = { providerName: "f", modelName: "f", async analyzeCodebase() { return '{"route_events":[{"method":"POST","path":"/reservations","events":["ReservationCreated"]}]}'; }, async completeSimple() { return "{}"; } };
    const p = new SourceParser(llm);
    const map = await p.extractRouteEvents("/repo", "ctx", [{ method: "POST", path: "/reservations", controller: "ResController", action: "store", middleware: [], prefix: "" }], ["ReservationCreated", "RoomAssigned"]);
    expect(map).toEqual({ "POST /reservations": ["ReservationCreated"] });
  });
});

describe("toStructureExtract route→event attach", () => {
  it("attaches events to the matching route (METHOD path) and carries them through emit raw", () => {
    const extract = toStructureExtract({
      routes: [{ method: "POST", path: "/reservations", controller: "ResController", action: "store", middleware: [], prefix: "" }],
      models: [],
      entities: [{ name: "予約", className: "Reservation", tableName: "reservations", attributes: ["id"], primaryKey: "id", description: "" }],
      relationships: [],
      usecases: [],
      routeEvents: { "POST /reservations": ["ReservationCreated", "RoomAssigned"] },
    });
    expect(extract.routes[0]?.events).toEqual(["ReservationCreated", "RoomAssigned"]);
    const nodes = emitStructureNodes(extract);
    const route = nodes.find((n) => n.route === "POST /reservations");
    expect((route?.raw as { events?: string[] }).events).toEqual(["ReservationCreated", "RoomAssigned"]);
  });
});

describe("InformationModelGenerator fallback", () => {
  it("parses relationship strings and infers the relation type offline", async () => {
    const gen = new InformationModelGenerator(null);
    const { entities, relationships } = await gen.generate([
      { className: "Order", tableName: "orders", fillable: ["id"], relationships: ["customer (belongsTo)"], casts: {}, scopes: [] },
      { className: "Customer", tableName: "customers", fillable: ["id"], relationships: [], casts: {}, scopes: [] },
    ]);
    expect(entities.map((e) => e.className)).toEqual(["Order", "Customer"]);
    expect(relationships[0]).toMatchObject({ fromEntity: "Order", toEntity: "Customer", relationType: "N-1" });
  });
});

describe("toStructureExtract", () => {
  it("projects parsed analysis onto the StructureExtract contract", () => {
    const extract = toStructureExtract({
      routes: [{ method: "GET", path: "/orders", controller: "OrderController", action: "index", middleware: [], prefix: "" }],
      models: [],
      entities: [
        { name: "注文", className: "Order", tableName: "orders", attributes: ["id", "total"], primaryKey: "id", description: "" },
        { name: "顧客", className: "Customer", tableName: "customers", attributes: ["id"], primaryKey: "id", description: "" },
      ],
      relationships: [{ fromEntity: "注文", toEntity: "顧客", relationType: "N-1", label: "属する", ormType: "" }],
      usecases: [
        { id: "UC-001", name: "注文管理", actor: "u", description: "", preconditions: [], postconditions: [], relatedRoutes: ["GET /orders"], relatedPages: [], relatedEntities: ["Order"], category: "c", priority: "high", relatedControllers: [], relatedViews: [] },
      ],
    });
    expect(extract.entities.map((e) => e.name)).toEqual(["orders", "customers"]);
    expect(extract.entities.find((e) => e.name === "orders")?.dependsOn).toEqual(["customers"]);
    expect(extract.usecases[0]).toMatchObject({ entity: "orders", route: { method: "GET", path: "/orders" }, crud: ["R"] });
  });
});

describe("analyzeRepo (LLM-driven path, fake provider)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ck-analyze-"));
    await writeFile(join(repo, "CLAUDE.md"), "# Sample app\nLaravel e-commerce", "utf8");
    await writeFile(join(repo, "composer.json"), '{"require":{"laravel/framework":"11"}}', "utf8");
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("builds project context with framework detection", () => {
    const ctx = buildContext(repo);
    expect(ctx.contextDocs["CLAUDE.md"]).toContain("Sample app");
    expect(ctx.detectedFrameworks).toContain("laravel");
  });

  it("runs the full pipeline and yields a valid StructureExtract", async () => {
    const { extract, parsed, usecases } = await analyzeRepo(repo, { llm: fakeLlm });
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.models).toHaveLength(2);
    expect(usecases).toHaveLength(1);

    expect(extract.entities.map((e) => e.name).sort()).toEqual(["customers", "orders"]);
    expect(extract.entities.find((e) => e.name === "orders")?.dependsOn).toEqual(["customers"]);

    // the result must flow through emit unchanged (same contract as the fixture path)
    const nodes = emitStructureNodes(extract);
    const orderRoute = nodes.find((n) => n.route === "GET /orders");
    expect((orderRoute?.raw as { entity?: string }).entity).toBe("orders");
  });

  it("falls back to empty parse with no provider (offline)", async () => {
    const { extract, provider } = await analyzeRepo(repo, { llm: null });
    expect(provider).toContain("fallback");
    expect(extract.routes).toHaveLength(0);
  });
});
