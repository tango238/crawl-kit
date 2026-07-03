import { describe, expect, it } from "vitest";
import { enumerateUnits, groupIntoUnits, type RepoFile } from "./units.js";

const f = (path: string, content = "x"): RepoFile => ({ path, content });

describe("groupIntoUnits (laravel)", () => {
  const files: RepoFile[] = [
    f("routes/web.php", "Route::get('/', ...)"),
    f("routes/api.php", "Route::apiResource(...)"),
    f("app/Http/Controllers/HomeController.php"),
    f("app/Http/Controllers/Admin/UserController.php"),
    f("app/Http/Controllers/Admin/RoleController.php"),
    f("app/Models/User.php"),
    f("app/Models/Role.php"),
    f("resources/views/home.blade.php"),
  ];

  it("splits laravel routes per file", () => {
    const units = groupIntoUnits(files, ["laravel"]);
    const routeUnits = units.filter((u) => u.kind === "routes");
    expect(routeUnits.map((u) => u.id).sort()).toEqual([
      "laravel:routes/api",
      "laravel:routes/web",
    ]);
  });

  it("groups controllers by immediate subdirectory", () => {
    const units = groupIntoUnits(files, ["laravel"]);
    const ctrl = units.filter((u) => u.kind === "controllers");
    const ids = ctrl.map((u) => u.id).sort();
    expect(ids).toEqual(["laravel:controllers", "laravel:controllers/Admin"]);
    const admin = ctrl.find((u) => u.id === "laravel:controllers/Admin")!;
    expect(admin.files.sort()).toEqual([
      "app/Http/Controllers/Admin/RoleController.php",
      "app/Http/Controllers/Admin/UserController.php",
    ]);
  });

  it("collects models into a models unit", () => {
    const units = groupIntoUnits(files, ["laravel"]);
    const models = units.find((u) => u.kind === "models");
    expect(models?.files.sort()).toEqual(["app/Models/Role.php", "app/Models/User.php"]);
  });

  it("assigns every unit the laravel framework and a non-empty hash", () => {
    const units = groupIntoUnits(files, ["laravel"]);
    expect(units.length).toBeGreaterThan(0);
    for (const u of units) {
      expect(u.framework).toBe("laravel");
      expect(u.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(u.files.length).toBeGreaterThan(0);
    }
  });
});

describe("groupIntoUnits (hash stability)", () => {
  it("is stable across runs for identical input", () => {
    const files = [f("routes/web.php", "A"), f("app/Models/User.php", "B")];
    const a = groupIntoUnits(files, ["laravel"]);
    const b = groupIntoUnits([...files].reverse(), ["laravel"]);
    const byId = (us: ReturnType<typeof groupIntoUnits>) =>
      Object.fromEntries(us.map((u) => [u.id, u.hash]));
    expect(byId(a)).toEqual(byId(b));
  });

  it("changes the unit hash when a file's content changes", () => {
    const before = groupIntoUnits([f("routes/web.php", "A")], ["laravel"]);
    const after = groupIntoUnits([f("routes/web.php", "B")], ["laravel"]);
    expect(before[0].hash).not.toBe(after[0].hash);
  });

  it("changes the unit hash when a file is added to the unit", () => {
    const one = groupIntoUnits([f("app/Models/User.php", "A")], ["laravel"]);
    const two = groupIntoUnits(
      [f("app/Models/User.php", "A"), f("app/Models/Role.php", "B")],
      ["laravel"],
    );
    const m1 = one.find((u) => u.kind === "models")!;
    const m2 = two.find((u) => u.kind === "models")!;
    expect(m1.hash).not.toBe(m2.hash);
  });
});

describe("groupIntoUnits (generic fallback)", () => {
  it("groups by top-level directory when no framework rule matches", () => {
    const files = [
      f("src/a.ts"),
      f("src/b.ts"),
      f("lib/c.ts"),
      f("index.ts"),
    ];
    const units = groupIntoUnits(files, []);
    const ids = units.map((u) => u.id).sort();
    expect(ids).toEqual(["generic:.", "generic:lib", "generic:src"]);
    const src = units.find((u) => u.id === "generic:src")!;
    expect(src.files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("enumerateUnits (injected file lister)", () => {
  it("detects frameworks from manifests and enumerates units", () => {
    const files: RepoFile[] = [
      f("composer.json", '{ "require": { "laravel/framework": "^12.0" } }'),
      f("routes/web.php", "Route::get('/', ...)"),
      f("app/Models/User.php", "class User {}"),
    ];
    const units = enumerateUnits("/fake/repo", { listFiles: () => files });
    expect(units.some((u) => u.framework === "laravel" && u.kind === "routes")).toBe(true);
    expect(units.some((u) => u.kind === "models")).toBe(true);
  });

  it("honors an explicit frameworks override", () => {
    const files: RepoFile[] = [f("routes/web.php", "x")];
    const units = enumerateUnits("/fake/repo", {
      listFiles: () => files,
      frameworks: ["laravel"],
    });
    expect(units[0].framework).toBe("laravel");
  });
});
