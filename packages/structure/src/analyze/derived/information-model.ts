// packages/structure/src/analyze/derived/information-model.ts
//
// ← extraction/derived/information_model.py. Derives entities + relationships from the
// parsed data models. LLM path: Japanese naming + exclude internal models + relation
// typing. Fallback (offline): class name as entity, parse "posts (hasMany)" relationship
// strings and infer the relation type from ORM keywords — ported verbatim so the no-LLM
// result matches the original.

import type { LlmProvider } from "../llm/provider.js";
import type { ParsedModel } from "../source-parser.js";

export interface Entity {
  name: string;
  className: string;
  tableName: string;
  attributes: string[];
  primaryKey: string;
  description: string;
}

export interface Relationship {
  fromEntity: string;
  toEntity: string;
  relationType: string; // "1-1" | "1-N" | "N-1" | "N-N"
  label: string;
  ormType: string;
}

export class InformationModelGenerator {
  constructor(
    private readonly llm: LlmProvider | null,
    private readonly projectContext = "",
  ) {}

  async generate(models: ParsedModel[]): Promise<{ entities: Entity[]; relationships: Relationship[] }> {
    if (this.llm && models.length > 0) {
      return this.generateWithLlm(models);
    }
    const entities = this.createEntitiesFallback(models);
    return { entities, relationships: this.extractRelationshipsFallback(models, entities) };
  }

  private async generateWithLlm(models: ParsedModel[]): Promise<{ entities: Entity[]; relationships: Relationship[] }> {
    const modelsInfo = models.slice(0, 100).map((m) => ({
      class_name: m.className,
      table_name: m.tableName,
      fields: m.fillable.slice(0, 15),
      relationships: m.relationships.slice(0, 10),
    }));
    const contextPart = this.projectContext ? `\n## プロジェクトコンテキスト\n${this.projectContext}\n` : "";
    const system = "あなたはRDRA（Relationship-Driven Requirements Analysis）の専門家です。";
    const user = `${contextPart}

## データモデル一覧
\`\`\`json
${JSON.stringify(modelsInfo, null, 2)}
\`\`\`

上記のデータモデルについて、以下を行ってください:
1. 各モデルに適切な日本語名をつける（プロジェクトのドメインに合わせて）
2. システム内部用のモデル（認証トークン、ログ、マイグレーション等）を除外する
3. リレーション定義から、エンティティ間の関係を「1-1」「1-N」「N-N」で分類する

以下のJSON形式のみで返してください:
{
  "entities": [
    {
      "class_name": "User",
      "japanese_name": "ユーザー",
      "description": "システムを利用するユーザー",
      "exclude": false
    }
  ],
  "relationships": [
    {
      "from": "User",
      "to": "Post",
      "type": "1-N",
      "label": "投稿する"
    }
  ]
}`;
    try {
      return this.parseLlmResult(await this.llm!.completeSimple(user, system), models);
    } catch {
      const entities = this.createEntitiesFallback(models);
      return { entities, relationships: this.extractRelationshipsFallback(models, entities) };
    }
  }

  private parseLlmResult(response: string, models: ParsedModel[]): { entities: Entity[]; relationships: Relationship[] } {
    let cleaned = response.replace(/```(?:json)?\s*/g, "").trim();
    cleaned = cleaned.replace(/```\s*$/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      const entities = this.createEntitiesFallback(models);
      return { entities, relationships: this.extractRelationshipsFallback(models, entities) };
    }
    const data = JSON.parse(match[0]) as {
      entities?: Array<Record<string, unknown>>;
      relationships?: Array<Record<string, unknown>>;
    };

    const nameMap = new Map<string, string>();
    const excluded = new Set<string>();
    const descMap = new Map<string, string>();
    for (const item of data.entities ?? []) {
      const cn = String(item.class_name ?? "");
      if (item.exclude) excluded.add(cn);
      else {
        nameMap.set(cn, String(item.japanese_name ?? cn));
        descMap.set(cn, String(item.description ?? ""));
      }
    }

    const modelMap = new Map(models.map((m) => [m.className, m]));
    const entities: Entity[] = [];
    for (const [className, japaneseName] of nameMap) {
      const model = modelMap.get(className);
      entities.push({
        name: japaneseName,
        className,
        tableName: model?.tableName ?? "",
        attributes: model?.fillable.slice(0, 15) ?? [],
        primaryKey: "id",
        description: descMap.get(className) ?? "",
      });
    }

    const relationships: Relationship[] = [];
    for (const rel of data.relationships ?? []) {
      const fromClass = String(rel.from ?? "");
      const toClass = String(rel.to ?? "");
      if (excluded.has(fromClass) || excluded.has(toClass)) continue;
      relationships.push({
        fromEntity: nameMap.get(fromClass) ?? fromClass,
        toEntity: nameMap.get(toClass) ?? toClass,
        relationType: String(rel.type ?? "1-N"),
        label: String(rel.label ?? "関連する"),
        ormType: "",
      });
    }
    return { entities, relationships };
  }

  createEntitiesFallback(models: ParsedModel[]): Entity[] {
    return models.map((model) => {
      let attributes = [...model.fillable];
      if (attributes.length === 0) attributes = Object.keys(model.casts);
      return {
        name: model.className,
        className: model.className,
        tableName: model.tableName,
        attributes: attributes.slice(0, 15),
        primaryKey: "id",
        description: "",
      };
    });
  }

  extractRelationshipsFallback(models: ParsedModel[], entities: Entity[]): Relationship[] {
    const relationships: Relationship[] = [];
    const classToEntity = new Map(entities.map((e) => [e.className, e.name]));
    for (const model of models) {
      const fromEntity = classToEntity.get(model.className) ?? model.className;
      for (const relStr of model.relationships) {
        const m = relStr.match(/(\w+)\s+\((\w+)\)/);
        if (!m) continue;
        const relMethod = m[1]!;
        const ormType = m[2]!;
        const toClass = this.methodToClass(relMethod);
        const toEntity = classToEntity.get(toClass) ?? toClass;
        const [relationType, label] = this.inferRelationType(ormType);
        if (fromEntity === toEntity || !toEntity) continue;
        if (!relationships.some((r) => r.fromEntity === fromEntity && r.toEntity === toEntity)) {
          relationships.push({ fromEntity, toEntity, relationType, label, ormType });
        }
      }
    }
    return relationships;
  }

  private methodToClass(methodName: string): string {
    const words = methodName.match(/[A-Z][a-z]*|[a-z]+/g);
    if (!words) return methodName;
    let className = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
    if (className.endsWith("s") && className.length > 1) className = className.slice(0, -1);
    return className;
  }

  private inferRelationType(ormType: string): [string, string] {
    const t = ormType.toLowerCase();
    if (["manytomany", "belongstomany", "has_and_belongs_to_many", "n-n"].some((k) => t.includes(k))) return ["N-N", "関連する"];
    if (["hasone", "has_one", "onetoone", "1-1"].some((k) => t.includes(k))) return ["1-1", "持つ"];
    if (["belongsto", "belongs_to", "manytoone"].some((k) => t.includes(k))) return ["N-1", "属する"];
    if (["hasmany", "has_many", "onetomany", "morphmany"].some((k) => t.includes(k))) return ["1-N", "持つ"];
    if (t.includes("morph")) return ["1-N", "ポリモーフィック"];
    return ["1-N", "関連する"];
  }
}
