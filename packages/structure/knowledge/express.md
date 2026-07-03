# Express.js (Node.js / TypeScript)

## 検出条件
- package.json に "express" が含まれる

## プロジェクト構成
- src/app.ts または app.js — アプリケーションエントリーポイント
- src/routes/ — ルーター定義
- src/controllers/ — コントローラー
- src/models/ — モデル（Sequelize / TypeORM / Prisma）
- src/middleware/ — ミドルウェア
- src/services/ — サービス層
- prisma/schema.prisma — Prismaスキーマ（Prisma使用時）
- src/entities/ — TypeORMエンティティ（TypeORM使用時）

## ルーティング形式
```typescript
import { Router } from 'express';
const router = Router();

router.get('/users', userController.list);
router.get('/users/:id', userController.show);
router.post('/users', userController.create);
router.put('/users/:id', userController.update);
router.delete('/users/:id', userController.destroy);

// app.ts
app.use('/api/v1', router);
```
- Router() でルーターを作成、app.use() でマウント
- :id でパスパラメータ

## モデル形式（Prisma）
```prisma
model User {
  id        Int      @id @default(autoincrement())
  name      String
  email     String   @unique
  posts     Post[]
  company   Company  @relation(fields: [companyId], references: [id])
  companyId Int
}
```

## モデル形式（TypeORM）
```typescript
@Entity()
export class User {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    name: string;

    @OneToMany(() => Post, post => post.user)
    posts: Post[];

    @ManyToOne(() => Company)
    company: Company;
}
```

## モデル形式（Sequelize）
```typescript
class User extends Model {
    declare id: number;
    declare name: string;
    static associate(models) {
        User.hasMany(models.Post);
        User.belongsTo(models.Company);
    }
}
```

## CRUD操作パターン

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にCRUD操作パターンや
> データアクセス層の規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの一般的なパターンであり、フォールバックとして参照する。

### Prisma 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `prisma.model.create({ data: ... })`, `prisma.model.createMany({ data: [...] })` |
| Read | `prisma.model.findUnique({ where: ... })`, `prisma.model.findMany(...)`, `prisma.model.findFirst(...)`, `prisma.model.count(...)` |
| Update | `prisma.model.update({ where: ..., data: ... })`, `prisma.model.updateMany(...)`, `prisma.model.upsert(...)` |
| Delete | `prisma.model.delete({ where: ... })`, `prisma.model.deleteMany(...)` |

### TypeORM 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `repository.save(new Entity())`, `repository.create(...)`, `repository.insert(...)` |
| Read | `repository.findOne(...)`, `repository.find(...)`, `repository.findOneBy(...)`, `repository.createQueryBuilder(...)` |
| Update | `repository.save(existing)`, `repository.update(id, ...)` |
| Delete | `repository.delete(id)`, `repository.remove(entity)`, `repository.softDelete(id)` |

### Sequelize 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `Model.create(...)`, `Model.bulkCreate([...])` |
| Read | `Model.findByPk(id)`, `Model.findAll(...)`, `Model.findOne(...)`, `Model.count(...)` |
| Update | `instance.update(...)`, `instance.save()`, `Model.update(..., { where: ... })` |
| Delete | `instance.destroy()`, `Model.destroy({ where: ... })` |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: Controller → Model（直接操作）
```typescript
export const createOrder = async (req: Request, res: Response) => {
    const order = await prisma.order.create({ data: req.body });   // Order: Create
    await prisma.stock.update({ where: { id: pid }, data: { qty: { decrement: 1 } } }); // Stock: Update
    res.json(order);
};
```

### パターン2: Controller → Service → Model
```typescript
// controller
export const createOrder = async (req: Request, res: Response) => {
    const order = await orderService.createOrder(req.body);
    res.json(order);
};
// service
export class OrderService {
    async createOrder(data: OrderInput) {
        const order = await prisma.order.create({ data });         // Order: Create
        await this.stockService.decrement(data.productId);         // Stock: Update
        await prisma.payment.create({ data: { orderId: order.id } }); // Payment: Create
        return order;
    }
}
```
