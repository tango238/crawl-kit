# Nuxt.js (Vue.js / TypeScript)

## 検出条件
- package.json に "nuxt" が含まれる

## プロジェクト構成
- pages/ — ファイルベースルーティング
  - index.vue — / ページ
  - users/index.vue — /users ページ
  - users/[id].vue — /users/:id ページ
- server/api/ — サーバーAPIルート（Nitro）
  - users.get.ts — GET /api/users
  - users.post.ts — POST /api/users
  - users/[id].get.ts — GET /api/users/:id
  - users/[id].put.ts — PUT /api/users/:id
  - users/[id].delete.ts — DELETE /api/users/:id
- components/ — Vueコンポーネント
- composables/ — Composition API ユーティリティ（useXxx 形式）
- stores/ — Pinia ストア（状態管理）
- middleware/ — ルートミドルウェア
- layouts/ — レイアウト
- plugins/ — プラグイン
- nuxt.config.ts — Nuxt設定ファイル

## ルーティング形式
- ファイルシステムベース: pages/ のディレクトリ構造がそのままURLパスになる
- [id] — 動的ルートパラメータ
- [...slug] — キャッチオールルート

## サーバーAPI形式（Nitro）
```typescript
// server/api/users.get.ts
export default defineEventHandler(async (event) => {
    return await User.findAll();
});

// server/api/users/[id].put.ts
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id');
    const body = await readBody(event);
    return await User.update(id, body);
});
```
- ファイル名の `.get.ts`, `.post.ts` 等でHTTPメソッドを指定

## データ取得パターン
```vue
<script setup>
const { data: users } = await useFetch('/api/users')
const { data: user } = await useAsyncData('user', () => $fetch(`/api/users/${id}`))
</script>
```

## CRUD操作パターン

> Nuxt.js はフロントエンドフレームワークだが、Nitro サーバーエンジンにより
> server/api/ 内でDB操作を直接行うBFFパターンが一般的。
> この場合のCRUD操作パターンは以下を参照。

### Nitro Server Route でのDB操作
- Prisma, Drizzle, Knex 等のORMをNuxtサーバー内で使用するケースがある
- Express.js のknowledge（Prisma/TypeORM/Sequelize）のCRUD操作パターンを参照すること

## コール階層

> Nuxt.js の server/api/ ルートでは、以下の経路でCRUD操作が行われる。
> CLAUDE.md / AGENTS.md に記載がある場合はそちらを優先する。

### パターン1: Server Route → Model（直接操作）
```typescript
// server/api/orders.post.ts
export default defineEventHandler(async (event) => {
    const body = await readBody(event);
    const order = await prisma.order.create({ data: body });  // Order: Create
    return order;
});
```

### パターン2: Server Route → Service → Model
```typescript
// server/api/orders.post.ts
export default defineEventHandler(async (event) => {
    const body = await readBody(event);
    return await orderService.createOrder(body);
});
```
