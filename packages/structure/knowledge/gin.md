# Gin (Go)

## 検出条件
- go.mod に "github.com/gin-gonic/gin" が含まれる

## プロジェクト構成
- main.go — エントリーポイント
- cmd/ — メインアプリケーション
- internal/ — 内部パッケージ
  - handler/ または controller/ — HTTPハンドラー
  - service/ — ビジネスロジック
  - repository/ — データアクセス
  - model/ — データモデル（構造体）
  - middleware/ — ミドルウェア
  - router/ — ルーター設定
- pkg/ — 外部公開パッケージ
- config/ — 設定
- migrations/ — マイグレーション

## ルーティング形式
```go
r := gin.Default()

api := r.Group("/api/v1")
{
    api.GET("/users", handler.ListUsers)
    api.GET("/users/:id", handler.GetUser)
    api.POST("/users", handler.CreateUser)
    api.PUT("/users/:id", handler.UpdateUser)
    api.DELETE("/users/:id", handler.DeleteUser)
}

admin := api.Group("/admin")
admin.Use(middleware.AuthRequired())
{
    admin.GET("/stats", handler.GetStats)
}
```
- r.Group() でルートグループ化（プレフィックス累積）
- :id でパスパラメータ

## モデル形式（GORM）
```go
type User struct {
    gorm.Model
    Name      string    `json:"name" gorm:"not null"`
    Email     string    `json:"email" gorm:"uniqueIndex"`
    Posts     []Post    `json:"posts" gorm:"foreignKey:UserID"`
    CompanyID uint      `json:"company_id"`
    Company   Company   `json:"company" gorm:"constraint:OnDelete:CASCADE"`
}
```
- gorm struct タグでDB制約を定義
- json タグでJSONシリアライズ名を定義
- リレーション: foreignKey, many2many, belongsTo（GORM規約ベース）

## ハンドラー形式
```go
func (h *Handler) ListUsers(c *gin.Context) {
    users, err := h.service.ListUsers(c.Request.Context())
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    c.JSON(http.StatusOK, users)
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
| Update | `db.Save(&model)`, `db.Model(&model).Update(...)`, `db.Model(&model).Updates(...)`, `db.Where(...).Update(...)` |
| Delete | `db.Delete(&model, id)`, `db.Where(...).Delete(&Model{})`, `db.Unscoped().Delete(&model)` (hard delete) |

### database/sql 直接操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `db.Exec("INSERT INTO ...")`, `db.ExecContext(ctx, "INSERT INTO ...")` |
| Read | `db.Query("SELECT ...")`, `db.QueryRow("SELECT ...")`, `db.QueryContext(...)` |
| Update | `db.Exec("UPDATE ...")` |
| Delete | `db.Exec("DELETE FROM ...")` |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: Handler → Service → Repository
```go
// handler
func (h *OrderHandler) CreateOrder(c *gin.Context) {
    order, err := h.service.CreateOrder(c.Request.Context(), &input)
    // ...
}
// service
func (s *OrderService) CreateOrder(ctx context.Context, input *OrderInput) (*Order, error) {
    order, err := s.orderRepo.Create(ctx, input)            // Order: Create
    err = s.stockRepo.Decrement(ctx, input.ProductID, qty)  // Stock: Update
    return order, err
}
// repository
func (r *OrderRepository) Create(ctx context.Context, input *OrderInput) (*Order, error) {
    order := &Order{...}
    return order, r.db.WithContext(ctx).Create(order).Error  // Order: Create
}
```

### パターン2: Handler → Model（直接操作、小規模）
```go
func CreateOrder(c *gin.Context) {
    var order Order
    db.Create(&order)                                        // Order: Create
    db.Model(&Stock{}).Where("product_id = ?", pid).
        Update("qty", gorm.Expr("qty - ?", 1))              // Stock: Update
}
```
