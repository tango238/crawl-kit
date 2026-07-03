# Next.js (React / TypeScript)

## 検出条件
- package.json に "next" が含まれる

## プロジェクト構成（App Router — Next.js 13+）
- app/ — App Router ルートディレクトリ
  - layout.tsx — 共通レイアウト
  - page.tsx — ルートページ（/ に対応）
  - (dashboard)/ — ルートグループ（URLに影響しない）
  - users/page.tsx — /users ページ
  - users/[id]/page.tsx — /users/:id ページ
  - users/new/page.tsx — /users/new ページ
  - api/ — APIルート（Route Handlers）
    - users/route.ts — GET/POST /api/users
    - users/[id]/route.ts — GET/PUT/DELETE /api/users/:id
- components/ — 共通コンポーネント
- features/ — 機能別コンポーネント（ビジネスロジック）
- lib/ または utils/ — ユーティリティ
- hooks/ — カスタムフック

## プロジェクト構成（Pages Router — レガシー）
- pages/ — ファイルベースルーティング
  - index.tsx — / ページ
  - users/index.tsx — /users ページ
  - users/[id].tsx — /users/:id ページ
  - api/ — APIルート
    - users.ts — /api/users
    - users/[id].ts — /api/users/:id

## ルーティング形式
- ファイルシステムベース: ディレクトリ構造がそのままURLパスになる
- [id] — 動的ルートパラメータ
- [...slug] — キャッチオールルート
- (group) — ルートグループ（URLに含まれない）

## API Route Handler 形式（App Router）
```typescript
// app/api/users/route.ts
export async function GET(request: Request) { ... }
export async function POST(request: Request) { ... }

// app/api/users/[id]/route.ts
export async function GET(request: Request, { params }: { params: { id: string } }) { ... }
export async function PUT(request: Request, { params }: { params: { id: string } }) { ... }
export async function DELETE(request: Request, { params }: { params: { id: string } }) { ... }
```

## データ取得パターン
- SWR: `useSWR('/api/users', fetcher)` — クライアントサイド
- React Query / TanStack Query: `useQuery({ queryKey: ['users'] })`
- Server Components: `async function Page() { const data = await fetch(...) }`
- Orval 等の自動生成フック: `useUsersIndex()`, `useUsersStore()` 等

## 特記事項
- page.tsx は薄いラッパーで、実際のビジネスロジックは features/ のコンポーネントにあることが多い
- @/api/ からインポートされるフック名からAPIエンドポイントを推定できる

## CRUD操作パターン

> Next.js はフロントエンドフレームワークのため、エンティティに対する直接的なCRUD操作は
> サーバーサイド（バックエンドAPI）で行われる。ただし、API Route (Route Handlers) や
> Server Actions を使ったBFFパターンでは、Next.js 内でDB操作を行う場合がある。

### API Route / Server Actions でのDB操作（BFFパターン）
- Prisma, Drizzle 等のORMをNext.js内で直接使用するケースがある
- この場合は Express.js のknowledge（Prisma/TypeORM/Sequelize）のCRUD操作パターンを参照すること

### Server Actions
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `'use server'` 関数内で `prisma.model.create(...)` |
| Update | `'use server'` 関数内で `prisma.model.update(...)` |
| Delete | `'use server'` 関数内で `prisma.model.delete(...)` |

## コール階層

> Next.js の BFF パターンでは、以下の経路でCRUD操作が行われる。
> CLAUDE.md / AGENTS.md に記載がある場合はそちらを優先する。

### パターン1: API Route → Service → Model
```typescript
// app/api/orders/route.ts
export async function POST(req: Request) {
    const data = await req.json();
    return Response.json(await orderService.createOrder(data));
}
```

### パターン2: Server Action → Service → Model
```typescript
// app/actions/order.ts
'use server'
export async function createOrder(data: FormData) {
    const order = await prisma.order.create({ data: ... });  // Order: Create
}
```
