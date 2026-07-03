# Flutter (Dart)

## 検出条件
- pubspec.yaml に "flutter" が含まれる

## プロジェクト構成
- lib/ — メインソースコード
  - main.dart — エントリーポイント
  - app.dart — アプリケーションルート（MaterialApp / Router）
  - router/ — ルーティング定義（GoRouter / auto_route 等）
  - screens/ または pages/ — 画面（ページ）
  - widgets/ — 共通ウィジェット
  - models/ — データモデル（Dart クラス / Freezed）
  - repositories/ — リポジトリ（API通信）
  - services/ — サービス層
  - providers/ — 状態管理（Riverpod / Provider）
  - blocs/ — 状態管理（BLoC パターン）
  - utils/ — ユーティリティ
- test/ — テスト
- pubspec.yaml — 依存パッケージ定義

## ルーティング形式（GoRouter）
```dart
final router = GoRouter(
  routes: [
    GoRoute(path: '/', builder: (context, state) => HomeScreen()),
    GoRoute(path: '/users', builder: (context, state) => UserListScreen()),
    GoRoute(path: '/users/:id', builder: (context, state) => UserDetailScreen(id: state.pathParameters['id']!)),
    GoRoute(path: '/users/new', builder: (context, state) => UserFormScreen()),
  ],
);
```

## モデル形式
```dart
class User {
  final int id;
  final String name;
  final String email;
  final Company? company;
  final List<Post> posts;

  User({required this.id, required this.name, required this.email, this.company, this.posts = const []});

  factory User.fromJson(Map<String, dynamic> json) => User(
    id: json['id'],
    name: json['name'],
    email: json['email'],
  );
}
```

## モデル形式（Freezed）
```dart
@freezed
class User with _$User {
  const factory User({
    required int id,
    required String name,
    required String email,
    Company? company,
    @Default([]) List<Post> posts,
  }) = _User;

  factory User.fromJson(Map<String, dynamic> json) => _$UserFromJson(json);
}
```

## API通信パターン
```dart
class UserRepository {
  final Dio _dio;
  Future<List<User>> getUsers() async {
    final response = await _dio.get('/api/users');
    return (response.data as List).map((e) => User.fromJson(e)).toList();
  }
}
```

## 特記事項
- Flutter はフロントエンド（モバイル/Web）のみ。バックエンドAPIは別リポジトリの場合が多い
- 画面遷移とAPI呼び出しパターンからユースケースを推定する

## CRUD操作パターン

> Flutter はモバイル/Web フロントエンドフレームワークのため、エンティティに対するCRUD操作は
> バックエンドAPI経由で行われる。Flutter 側にはサーバーサイドのCRUD操作パターンは存在しない。
> バックエンドのフレームワーク（Laravel, Spring Boot, FastAPI等）のknowledgeを参照すること。

### ローカルDB操作（sqflite / Drift）
- オフラインキャッシュやローカルストレージ用途で Flutter 内でDB操作を行う場合がある

| CRUD | sqflite | Drift |
|------|---------|-------|
| Create | `db.insert('table', data)` | `into(table).insert(companion)` |
| Read | `db.query('table')`, `db.rawQuery('SELECT ...')` | `select(table).get()`, `(select(table)..where(...)).get()` |
| Update | `db.update('table', data, where: ...)` | `(update(table)..where(...)).write(companion)` |
| Delete | `db.delete('table', where: ...)` | `(delete(table)..where(...)).go()` |

## コール階層

> Flutter のコール階層は主にAPIクライアント経由のためサーバーサイドのknowledgeを参照。
> ローカルDB操作がある場合は以下のパターンを参照する。

### パターン1: Screen → Repository → API
```dart
// API経由（サーバーサイドのCRUD）
class OrderRepository {
    Future<Order> createOrder(OrderInput input) async {
        final response = await dio.post('/api/orders', data: input.toJson());
        return Order.fromJson(response.data);
    }
}
```

### パターン2: Screen → Repository → Local DB
```dart
// ローカルDB操作
class CacheRepository {
    Future<void> cacheOrder(Order order) async {
        await db.insert('orders', order.toMap());          // Order: Create (local)
    }
}
```
