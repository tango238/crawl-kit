# Actix Web (Rust)

## 検出条件
- Cargo.toml に "actix-web" が含まれる

## プロジェクト構成
- src/main.rs — エントリーポイント
- src/routes/ または src/handlers/ — ルートハンドラー
- src/models/ — データモデル（構造体）
- src/db/ — データベース接続・クエリ
- src/schema.rs — Dieselスキーマ（Diesel使用時）
- src/errors/ — エラー型
- src/middleware/ — ミドルウェア
- src/config.rs — 設定
- migrations/ — マイグレーション

## ルーティング形式
```rust
// main.rs
HttpServer::new(|| {
    App::new()
        .service(
            web::scope("/api/v1")
                .route("/users", web::get().to(handlers::list_users))
                .route("/users", web::post().to(handlers::create_user))
                .route("/users/{id}", web::get().to(handlers::get_user))
                .route("/users/{id}", web::put().to(handlers::update_user))
                .route("/users/{id}", web::delete().to(handlers::delete_user))
        )
})

// マクロベース
#[get("/users")]
async fn list_users(db: web::Data<Pool>) -> impl Responder { ... }

#[post("/users")]
async fn create_user(body: web::Json<CreateUser>) -> impl Responder { ... }
```
- web::scope() でルートグループ化
- {id} でパスパラメータ
- #[get], #[post] 等のマクロでもルート定義可能

## モデル形式（Diesel）
```rust
#[derive(Queryable, Identifiable, Associations)]
#[diesel(table_name = users)]
#[diesel(belongs_to(Company))]
pub struct User {
    pub id: i32,
    pub name: String,
    pub email: String,
    pub company_id: i32,
}

#[derive(Insertable)]
#[diesel(table_name = users)]
pub struct NewUser {
    pub name: String,
    pub email: String,
}
```

## モデル形式（SeaORM）
```rust
#[derive(Clone, Debug, DeriveEntityModel)]
#[sea_orm(table_name = "users")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub name: String,
    pub email: String,
}

impl Related<super::post::Entity> for Entity {
    fn to() -> RelationDef { ... }
}
```

## CRUD操作パターン

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にCRUD操作パターンや
> データアクセス層の規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの一般的なパターンであり、フォールバックとして参照する。

### Diesel 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `diesel::insert_into(table).values(&new_record).execute(&mut conn)`, `diesel::insert_into(table).values(&new_record).get_result(&mut conn)` |
| Read | `table.find(id).first(&mut conn)`, `table.filter(...).load(&mut conn)`, `table.select(...).load(&mut conn)` |
| Update | `diesel::update(table.find(id)).set(...).execute(&mut conn)`, `diesel::update(table.filter(...)).set(...)` |
| Delete | `diesel::delete(table.find(id)).execute(&mut conn)`, `diesel::delete(table.filter(...)).execute(&mut conn)` |

### SeaORM 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `Entity::insert(active_model).exec(&db).await`, `Entity::insert_many([...]).exec(&db).await` |
| Read | `Entity::find_by_id(id).one(&db).await`, `Entity::find().filter(...).all(&db).await` |
| Update | `active_model.update(&db).await`, `Entity::update_many().set(...).filter(...).exec(&db).await` |
| Delete | `active_model.delete(&db).await`, `Entity::delete_by_id(id).exec(&db).await` |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: Handler → Service → Repository
```rust
// handler
async fn create_order(data: web::Json<OrderInput>, svc: web::Data<OrderService>) -> impl Responder {
    let order = svc.create_order(data.into_inner()).await?;
    HttpResponse::Created().json(order)
}
// service
impl OrderService {
    async fn create_order(&self, input: OrderInput) -> Result<Order> {
        let order = self.order_repo.create(&input).await?;   // Order: Create
        self.stock_repo.decrement(input.product_id).await?;  // Stock: Update
        Ok(order)
    }
}
```
