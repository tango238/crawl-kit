# Phoenix (Elixir)

## 検出条件
- mix.exs に "phoenix" が含まれる

## プロジェクト構成
- lib/<app>_web/ — Webレイヤー
  - router.ex — ルーティング定義
  - controllers/ — コントローラー
  - views/ または components/ — ビュー/LiveViewコンポーネント
  - live/ — LiveViewモジュール
  - templates/ — EExテンプレート
  - channels/ — WebSocketチャンネル
- lib/<app>/ — ビジネスロジック（コンテキスト）
  - accounts.ex — Accountsコンテキスト（例）
  - accounts/user.ex — Ectoスキーマ
- priv/repo/migrations/ — マイグレーション
- config/ — 設定ファイル

## ルーティング形式
```elixir
# router.ex
scope "/api", MyAppWeb do
  pipe_through :api

  resources "/users", UserController, except: [:new, :edit]
  resources "/posts", PostController, only: [:index, :show, :create]

  scope "/admin" do
    pipe_through :admin_auth
    resources "/stats", StatsController, only: [:index]
  end
end
```
- resources で RESTful ルートを自動生成（index, show, new, create, edit, update, delete）
- scope でパスプレフィックスとモジュールスコープを定義
- pipe_through でミドルウェア（パイプライン）を適用

## モデル形式（Ecto）
```elixir
defmodule MyApp.Accounts.User do
  use Ecto.Schema

  schema "users" do
    field :name, :string
    field :email, :string
    has_many :posts, MyApp.Blog.Post
    belongs_to :company, MyApp.Companies.Company
    many_to_many :roles, MyApp.Accounts.Role, join_through: "users_roles"
    timestamps()
  end

  def changeset(user, attrs) do
    user
    |> cast(attrs, [:name, :email])
    |> validate_required([:name, :email])
    |> unique_constraint(:email)
  end
end
```
- リレーション: has_many, belongs_to, has_one, many_to_many
- changeset でバリデーション定義

## コントローラー形式
```elixir
defmodule MyAppWeb.UserController do
  use MyAppWeb, :controller

  def index(conn, _params), do: ...
  def show(conn, %{"id" => id}), do: ...
  def create(conn, %{"user" => user_params}), do: ...
  def update(conn, %{"id" => id, "user" => user_params}), do: ...
  def delete(conn, %{"id" => id}), do: ...
end
```

## CRUD操作パターン

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にCRUD操作パターンや
> データアクセス層の規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの一般的なパターンであり、フォールバックとして参照する。

### Ecto 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `Repo.insert(changeset)`, `Repo.insert!(changeset)`, `Repo.insert_all(table, [...])` |
| Read | `Repo.get(Model, id)`, `Repo.get!(Model, id)`, `Repo.all(Model)`, `Repo.one(query)`, `from(...) |> Repo.all()` |
| Update | `Repo.update(changeset)`, `Repo.update!(changeset)`, `Repo.update_all(query, set: [...])` |
| Delete | `Repo.delete(record)`, `Repo.delete!(record)`, `Repo.delete_all(query)` |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: Controller → Context → Repo（Phoenix標準）
```elixir
# Controller
def create(conn, %{"order" => order_params}) do
  case Orders.create_order(order_params) do
    {:ok, order} -> ...
  end
end
# Context (lib/my_app/orders.ex)
def create_order(attrs) do
  %Order{}
  |> Order.changeset(attrs)
  |> Repo.insert()                                        # Order: Create
  |> case do
    {:ok, order} ->
      Stocks.decrement(order.product_id)                  # Stock: Update
      {:ok, order}
  end
end
```

### パターン2: Ecto.Multi（トランザクション）
```elixir
Ecto.Multi.new()
|> Ecto.Multi.insert(:order, Order.changeset(%Order{}, attrs))   # Order: Create
|> Ecto.Multi.update(:stock, fn %{order: order} ->
     Stock.decrement_changeset(order.product_id)                  # Stock: Update
   end)
|> Repo.transaction()
```
