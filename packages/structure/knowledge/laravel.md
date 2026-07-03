# Laravel (PHP)

## 検出条件
- composer.json に "laravel/framework" が含まれる

## プロジェクト構成
- routes/web.php — Webルーティング（Blade用）
- routes/api.php — APIルーティング（/api プレフィックス付き）
- routes/api_v*.php — バージョン別APIルーティング（カスタム）
- app/Http/Controllers/ — コントローラー
- app/Models/ — Eloquentモデル（データベースモデル）
- app/Http/Requests/ — フォームリクエスト（バリデーション）
- app/Http/Middleware/ — ミドルウェア
- resources/views/ — Bladeテンプレート（ビュー）
- database/migrations/ — マイグレーション
- database/seeders/ — シーダー

## ルーティング形式
```php
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
Route::apiResource('users', UserController::class);
Route::group(['prefix' => 'admin', 'middleware' => ['auth']], function () {
    Route::get('/dashboard', [DashboardController::class, 'index']);
});
```
- apiResource は index/store/show/update/destroy の5ルートを自動生成
- Route::group のネストでプレフィックスが累積する

## モデル形式
```php
class User extends Model {
    protected $table = 'users';
    protected $fillable = ['name', 'email', 'password'];
    protected $casts = ['email_verified_at' => 'datetime'];
    public function posts() { return $this->hasMany(Post::class); }
    public function profile() { return $this->hasOne(Profile::class); }
}
```
- リレーション: hasMany, hasOne, belongsTo, belongsToMany, hasManyThrough, morphMany, morphTo
- $fillable でマスアサインメント可能なカラムを定義
- $casts で型キャストを定義

## コントローラー形式
```php
class UserController extends Controller {
    public function index() { ... }      // GET /users
    public function store(Request $request) { ... }  // POST /users
    public function show(User $user) { ... }         // GET /users/{id}
    public function update(Request $request, User $user) { ... } // PUT /users/{id}
    public function destroy(User $user) { ... }      // DELETE /users/{id}
}
```

## CRUD操作パターン

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にCRUD操作パターンや
> データアクセス層の規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの一般的なパターンであり、フォールバックとして参照する。

### Eloquent Model 直接操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `Model::create([...])`, `new Model(); $model->save()`, `Model::insert([...])`, `Model::firstOrCreate([...])`, `Model::updateOrCreate([...])` |
| Read | `Model::find($id)`, `Model::where(...)->get()`, `Model::all()`, `Model::first()`, `Model::paginate()`, `Model::findOrFail($id)` |
| Update | `$model->update([...])`, `$model->save()` (既存レコード), `Model::where(...)->update([...])`, `$model->increment(...)`, `$model->decrement(...)` |
| Delete | `$model->delete()`, `Model::destroy($id)`, `Model::where(...)->delete()`, `$model->forceDelete()`, `$model->trash()` |

### Query Builder 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `DB::table('x')->insert([...])` |
| Read | `DB::table('x')->get()`, `DB::table('x')->find($id)`, `DB::table('x')->where(...)->first()` |
| Update | `DB::table('x')->where(...)->update([...])`, `DB::table('x')->increment(...)`, `DB::table('x')->decrement(...)` |
| Delete | `DB::table('x')->where(...)->delete()`, `DB::table('x')->truncate()` |

### リレーション経由の操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `$parent->children()->create([...])`, `$parent->children()->createMany([...])`, `$parent->children()->save($child)` |
| Read | `$parent->children()->get()`, `$parent->children` (動的プロパティ), `$parent->children()->where(...)->get()` |
| Update | `$parent->children()->update([...])` |
| Delete | `$parent->children()->delete()`, `$parent->children()->detach()` (多対多) |

### Facade・認証系の操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Update | `Password::sendResetLink([...])` (パスワードリセット系 facade → 内部で token を DB に保存) |
| Update | `Auth::user()->update([...])`, `auth()->user()->save()` (認証ユーザー直接更新) |
| Update | `$user->password = bcrypt(...); $user->save()` (パスワード変更の直接パターン) |
| Create | `Password::createToken($user)` (リセットトークン生成) |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: Controller → Model（直接操作）
- 小〜中規模プロジェクトに多い
- コントローラー内でEloquentモデルを直接操作
```php
public function store(StoreOrderRequest $request) {
    $order = Order::create($request->validated());       // Order: Create
    $order->items()->createMany($request->items);        // OrderItem: Create
    Stock::where('product_id', $pid)->decrement('qty');  // Stock: Update
}
```

### パターン2: Controller → Service → Model
- Service層でビジネスロジックを集約
```php
// Controller
public function store(StoreOrderRequest $request) {
    return $this->orderService->createOrder($request->validated());
}
// Service
public function createOrder(array $data): Order {
    $order = Order::create($data);                       // Order: Create
    $this->stockService->decrementStock($data['items']); // Stock: Update
    Payment::create([...]);                               // Payment: Create
    return $order;
}
```

### パターン3: Controller → Service → Repository → Model
- DDD / クリーンアーキテクチャ
```php
// Repository
class OrderRepository {
    public function create(array $data): Order {
        return Order::create($data);                     // Order: Create
    }
}
// Service
public function createOrder(array $data): Order {
    $order = $this->orderRepo->create($data);
    $this->stockRepo->decrement($data['items']);         // Stock: Update
    return $order;
}
```

### パターン4: Event / Job / Observer 経由
```php
// Observer
class OrderObserver {
    public function created(Order $order) {
        Notification::create([...]);                     // Notification: Create
    }
    public function deleted(Order $order) {
        $order->items()->delete();                       // OrderItem: Delete (cascade)
    }
}
// Job
class ProcessPaymentJob {
    public function handle() {
        Payment::create([...]);                           // Payment: Create
    }
}
```
```
