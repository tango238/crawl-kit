import { describe, expect, it } from "vitest";
import { parseLaravelRoutes } from "./laravel-routes.js";

/** Compact "METHOD path" view — the identity that matters for a route inventory. */
const keys = (src: string, filePrefix?: string): string[] =>
  parseLaravelRoutes(src, filePrefix).map((r) => `${r.method} ${r.path}`);

describe("parseLaravelRoutes — basic verbs", () => {
  it("parses each HTTP verb with a string handler", () => {
    const routes = parseLaravelRoutes(`<?php
      Route::get('/users', 'UserController@index');
      Route::post('/users', 'UserController@store');
      Route::put('/users/{id}', 'UserController@update');
      Route::patch('/users/{id}', 'UserController@patch');
      Route::delete('/users/{id}', 'UserController@destroy');
      Route::options('/users', 'UserController@options');
    `);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /users",
      "POST /users",
      "PUT /users/{id}",
      "PATCH /users/{id}",
      "DELETE /users/{id}",
      "OPTIONS /users",
    ]);
    expect(routes[0]).toMatchObject({ controller: "UserController", action: "index" });
  });

  it("keeps path params verbatim, including optional {id?}", () => {
    expect(keys(`<?php Route::get('/posts/{post}/comments/{comment?}', 'C@m');`)).toEqual([
      "GET /posts/{post}/comments/{comment?}",
    ]);
  });

  it("normalizes leading slashes and empty '/' paths", () => {
    expect(keys(`<?php Route::get('/', 'C@i'); Route::post('x', 'C@s');`)).toEqual(["GET /", "POST /x"]);
  });
});

describe("parseLaravelRoutes — any & match", () => {
  it("maps `any` to a single ANY route", () => {
    const routes = parseLaravelRoutes(`<?php Route::any('/auth', 'AuthController@authenticate');`);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: "ANY", path: "/auth" });
  });

  it("expands `match([...])` to one route per listed method", () => {
    expect(keys(`<?php Route::match(['get', 'post'], '/x', 'C@h');`)).toEqual(["GET /x", "POST /x"]);
  });
});

describe("parseLaravelRoutes — handler forms", () => {
  it("array handler [Ctrl::class, 'method']", () => {
    const [r] = parseLaravelRoutes(`<?php Route::post('/users', [App\\Http\\Controllers\\UserController::class, 'store']);`);
    expect(r).toMatchObject({ controller: "UserController", action: "store" });
  });

  it("single-action controller ::class → __invoke", () => {
    const [r] = parseLaravelRoutes(`<?php Route::get('/sync', \\App\\Http\\Controllers\\SyncController::class);`);
    expect(r).toMatchObject({ controller: "SyncController", action: "__invoke" });
  });

  it("single-action controller as a bare string → __invoke", () => {
    const [r] = parseLaravelRoutes(`<?php Route::get('/sync', 'SyncPmsController');`);
    expect(r).toMatchObject({ controller: "SyncPmsController", action: "__invoke" });
  });

  it("namespaced string handler keeps class basename", () => {
    const [r] = parseLaravelRoutes(`<?php Route::post('/login', 'App\\Http\\Controllers\\Auth\\LoginController@login');`);
    expect(r).toMatchObject({ controller: "LoginController", action: "login" });
  });

  it("closure handler → controller '' action 'closure'", () => {
    const [r] = parseLaravelRoutes(`<?php Route::get('/ping', function () { return 'pong'; });`);
    expect(r).toMatchObject({ controller: "", action: "closure" });
  });
});

describe("parseLaravelRoutes — group prefix stacking", () => {
  it("stacks prefixes across nested array-form groups", () => {
    expect(
      keys(`<?php
        Route::group(['prefix' => 'operator'], static function () {
          Route::group(['prefix' => 'room'], static function () {
            Route::group(['prefix' => 'support-call'], static function () {
              Route::post('/join', 'C@join');
            });
          });
        });
      `),
    ).toEqual(["POST /operator/room/support-call/join"]);
  });

  it("collapses redundant slashes from prefix and path segments", () => {
    expect(
      keys(`<?php Route::group(['prefix' => 'api/v2/spotly/'], static function () {
        Route::get('/', 'C@i');
        Route::get('/{id}', 'C@s');
      });`),
    ).toEqual(["GET /api/v2/spotly", "GET /api/v2/spotly/{id}"]);
  });

  it("closes a group at its matching brace (siblings do not inherit)", () => {
    expect(
      keys(`<?php
        Route::group(['prefix' => 'a'], static function () { Route::get('/x', 'C@x'); });
        Route::get('/y', 'C@y');
      `),
    ).toEqual(["GET /a/x", "GET /y"]);
  });
});

describe("parseLaravelRoutes — fluent group forms", () => {
  it("Route::prefix('x')->group(...)", () => {
    expect(keys(`<?php Route::prefix('admin')->group(function () { Route::get('/dash', 'C@d'); });`)).toEqual([
      "GET /admin/dash",
    ]);
  });

  it("Route::middleware([...])->group(...) merges middleware into routes", () => {
    const routes = parseLaravelRoutes(
      `<?php Route::middleware(['auth', 'verified'])->group(function () { Route::get('/me', 'C@m'); });`,
    );
    expect(routes[0].middleware).toEqual(["auth", "verified"]);
  });

  it("fluent modifier then verb: Route::middleware('x')->get(...)", () => {
    const routes = parseLaravelRoutes(`<?php Route::middleware('auth:sanctum')->get('/user', UserController::class);`);
    expect(routes[0]).toMatchObject({ method: "GET", path: "/user", middleware: ["auth:sanctum"] });
  });

  it("Route::name('x.')->prefix('p')->group(...) picks up the prefix", () => {
    expect(keys(`<?php Route::name('p.')->prefix('p')->group(function () { Route::get('/a', 'C@a'); });`)).toEqual([
      "GET /p/a",
    ]);
  });
});

describe("parseLaravelRoutes — middleware merging", () => {
  it("merges group-stack and per-route middleware, de-duplicated", () => {
    const routes = parseLaravelRoutes(`<?php
      Route::group(['middleware' => ['auth']], static function () {
        Route::group(['middleware' => 'throttle'], static function () {
          Route::get('/x', 'C@x')->middleware(['auth', 'can:view']);
        });
      });
    `);
    expect(routes[0].middleware).toEqual(["auth", "throttle", "can:view"]);
  });
});

describe("parseLaravelRoutes — resources", () => {
  it("expands Route::resource to the full 8-route set (update = PUT + PATCH)", () => {
    expect(keys(`<?php Route::resource('photos', 'PhotoController');`)).toEqual([
      "GET /photos",
      "GET /photos/create",
      "POST /photos",
      "GET /photos/{id}",
      "GET /photos/{id}/edit",
      "PUT /photos/{id}",
      "PATCH /photos/{id}",
      "DELETE /photos/{id}",
    ]);
  });

  it("expands Route::apiResource (no create/edit)", () => {
    expect(keys(`<?php Route::apiResource('photos', 'PhotoController');`)).toEqual([
      "GET /photos",
      "POST /photos",
      "GET /photos/{id}",
      "PUT /photos/{id}",
      "PATCH /photos/{id}",
      "DELETE /photos/{id}",
    ]);
  });

  it("honors ->only([...])", () => {
    expect(
      keys(`<?php Route::apiResource('payments', 'Payment\\ApiController')->only(['index', 'show', 'store', 'destroy']);`),
    ).toEqual(["GET /payments", "POST /payments", "GET /payments/{id}", "DELETE /payments/{id}"]);
  });

  it("honors ->except([...])", () => {
    expect(keys(`<?php Route::apiResource('photos', 'C')->except(['destroy', 'update']);`)).toEqual([
      "GET /photos",
      "POST /photos",
      "GET /photos/{id}",
    ]);
  });

  it("ignores a 3rd options argument before ->only", () => {
    expect(
      keys(`<?php Route::apiResource('bookings', 'Booking\\ApiController', ['middleware' => ['auth:user']])->only(['store']);`),
    ).toEqual(["POST /bookings"]);
  });

  it("respects the enclosing group prefix", () => {
    expect(keys(`<?php Route::group(['prefix' => 'api'], static function () {
      Route::apiResource('tags', 'TagController')->only(['index']);
    });`)).toEqual(["GET /api/tags"]);
  });
});

describe("parseLaravelRoutes — comments & robustness", () => {
  it("ignores // line comments, # comments and /* */ blocks", () => {
    expect(
      keys(`<?php
        // Route::get('/commented-out', 'C@x');
        # Route::get('/hashed-out', 'C@y');
        /* Route::get('/blocked', 'C@z'); */
        Route::get('/live', 'C@live');
      `),
    ).toEqual(["GET /live"]);
  });

  it("does not treat // inside a string path as a comment", () => {
    expect(keys(`<?php Route::get('/a//b', 'C@x');`)).toEqual(["GET /a/b"]);
  });

  it("skips an unparseable statement but keeps the rest of the file", () => {
    expect(
      keys(`<?php
        Route::get('/ok', 'C@ok');
        Route::pattern('id', '[0-9]+');
        Route::redirect('/here', '/there');
        Route::post('/also-ok', 'C@ok2');
      `),
    ).toEqual(["GET /ok", "POST /also-ok"]);
  });

  it("returns [] for a file with no routes (never throws)", () => {
    expect(parseLaravelRoutes(`<?php // nothing here\n`)).toEqual([]);
    expect(parseLaravelRoutes("")).toEqual([]);
  });
});

describe("parseLaravelRoutes — filePrefix (mount prefix)", () => {
  it("prepends the mount prefix to every path", () => {
    expect(
      keys(
        `<?php
          Route::get('/users', 'C@i');
          Route::group(['prefix' => 'admin'], static function () { Route::get('/x', 'C@x'); });
        `,
        "api/v1",
      ),
    ).toEqual(["GET /api/v1/users", "GET /api/v1/admin/x"]);
  });

  it("normalizes surrounding slashes on the mount prefix", () => {
    expect(keys(`<?php Route::get('/x', 'C@x');`, "/api/v2/")).toEqual(["GET /api/v2/x"]);
  });
});
