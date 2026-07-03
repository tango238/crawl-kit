# FastAPI (Python)

## 検出条件
- requirements.txt, pyproject.toml, Pipfile に "fastapi" が含まれる

## プロジェクト構成
- main.py または app/main.py — アプリケーションエントリーポイント
- app/routers/ または app/api/ — ルーターモジュール
- app/models/ — SQLAlchemy / Tortoise ORM モデル
- app/schemas/ — Pydanticスキーマ（リクエスト/レスポンス定義）
- app/crud/ — CRUDユーティリティ
- app/db/ — データベース接続設定
- app/dependencies/ — 依存性注入
- alembic/ — マイグレーション（Alembic使用時）

## ルーティング形式
```python
from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter(prefix="/api/v1")

@router.get("/users")
async def list_users(): ...

@router.post("/users")
async def create_user(user: UserCreate): ...

@router.get("/users/{user_id}")
async def get_user(user_id: int): ...

@router.put("/users/{user_id}")
async def update_user(user_id: int, user: UserUpdate): ...

@router.delete("/users/{user_id}")
async def delete_user(user_id: int): ...

app.include_router(router)
```
- デコレーター（@app.get, @router.post 等）でルート定義
- APIRouter でルーターを分割、prefix でパスプレフィックスを設定
- Pydantic モデルで自動バリデーション＋OpenAPIドキュメント生成

## モデル形式（SQLAlchemy）
```python
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True)
    posts = relationship("Post", back_populates="author")
```
- relationship で ORM リレーション定義
- back_populates で双方向リレーション

## スキーマ形式（Pydantic）
```python
class UserCreate(BaseModel):
    name: str
    email: EmailStr

class UserResponse(BaseModel):
    id: int
    name: str
    email: str
    model_config = ConfigDict(from_attributes=True)
```

## CRUD操作パターン

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にCRUD操作パターンや
> データアクセス層の規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの一般的なパターンであり、フォールバックとして参照する。

### SQLAlchemy 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `db.add(Model(...))`, `db.add_all([...])`, `db.commit()` (add後) |
| Read | `db.query(Model).get(id)`, `db.query(Model).filter(...).all()`, `db.query(Model).first()`, `db.execute(select(Model))` |
| Update | `obj.field = value; db.commit()`, `db.query(Model).filter(...).update({...})`, `db.execute(update(Model).where(...))` |
| Delete | `db.delete(obj); db.commit()`, `db.query(Model).filter(...).delete()`, `db.execute(delete(Model).where(...))` |

### Tortoise ORM 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `await Model.create(...)`, `await Model.bulk_create([...])` |
| Read | `await Model.get(id=...)`, `await Model.filter(...)`, `await Model.all()` |
| Update | `obj.field = value; await obj.save()`, `await Model.filter(...).update(...)` |
| Delete | `await obj.delete()`, `await Model.filter(...).delete()` |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: Router → CRUD module → Model
```python
# routers/order.py
@router.post("/orders")
async def create_order(order: OrderCreate, db: Session = Depends(get_db)):
    return crud.order.create(db, order)
# crud/order.py
def create(db: Session, order: OrderCreate) -> Order:
    db_order = Order(**order.dict())
    db.add(db_order)                                     # Order: Create
    db.commit()
    stock = db.query(Stock).filter(...).first()
    stock.qty -= order.qty                               # Stock: Update
    db.commit()
    return db_order
```

### パターン2: Router → Service → Repository → Model
```python
# service
class OrderService:
    def __init__(self, order_repo: OrderRepository, stock_repo: StockRepository):
        self.order_repo = order_repo
        self.stock_repo = stock_repo
    async def create_order(self, data: OrderCreate) -> Order:
        order = await self.order_repo.create(data)       # Order: Create
        await self.stock_repo.decrement(data.product_id) # Stock: Update
        return order
```
