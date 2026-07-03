# Echo (Go)

## 検出条件
- go.mod に "github.com/labstack/echo" が含まれる

## プロジェクト構成
- main.go — エントリーポイント
- cmd/ — メインアプリケーション
- internal/ — 内部パッケージ
  - handler/ — HTTPハンドラー
  - service/ — ビジネスロジック
  - repository/ — データアクセス
  - model/ — データモデル（構造体）
  - middleware/ — ミドルウェア
- pkg/ — 外部公開パッケージ
- config/ — 設定

## ルーティング形式
```go
e := echo.New()

api := e.Group("/api/v1")
api.GET("/users", handler.ListUsers)
api.GET("/users/:id", handler.GetUser)
api.POST("/users", handler.CreateUser)
api.PUT("/users/:id", handler.UpdateUser)
api.DELETE("/users/:id", handler.DeleteUser)

admin := api.Group("/admin", middleware.Auth)
admin.GET("/stats", handler.GetStats)
```
- e.Group() でルートグループ化
- :id でパスパラメータ

## モデル形式（GORM / ent）
```go
// GORM
type User struct {
    ID        uint      `json:"id" gorm:"primaryKey"`
    Name      string    `json:"name"`
    Email     string    `json:"email" gorm:"uniqueIndex"`
    Posts     []Post    `json:"posts"`
    CompanyID uint      `json:"company_id"`
    Company   Company   `json:"company"`
}
```

## ハンドラー形式
```go
func (h *Handler) ListUsers(c echo.Context) error {
    users, err := h.service.ListUsers(c.Request().Context())
    if err != nil {
        return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
    }
    return c.JSON(http.StatusOK, users)
}
```

## CRUD操作パターン

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にCRUD操作パターンや
> データアクセス層の規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの一般的なパターンであり、フォールバックとして参照する。

### GORM 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `db.Create(&model)`, `db.CreateInBatches(&models, batchSize)` |
| Read | `db.First(&model, id)`, `db.Find(&models)`, `db.Where(...).Find(&models)`, `db.Take(&model)` |
| Update | `db.Save(&model)`, `db.Model(&model).Update(...)`, `db.Model(&model).Updates(...)` |
| Delete | `db.Delete(&model, id)`, `db.Where(...).Delete(&Model{})` |

### ent 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `client.User.Create().Set*(...).Save(ctx)` |
| Read | `client.User.Get(ctx, id)`, `client.User.Query().Where(...).All(ctx)` |
| Update | `client.User.UpdateOneID(id).Set*(...).Save(ctx)`, `client.User.Update().Where(...).Save(ctx)` |
| Delete | `client.User.DeleteOneID(id).Exec(ctx)`, `client.User.Delete().Where(...).Exec(ctx)` |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: Handler → Service → Repository
- Gin と同一パターン（Go の標準的なレイヤリング）
```go
func (h *OrderHandler) CreateOrder(c echo.Context) error {
    order, err := h.service.CreateOrder(c.Request().Context(), &input)
    // ...
}
```
コール階層の詳細は gin.md のパターンを参照。
