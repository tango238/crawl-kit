# Ruby on Rails (Ruby)

## 検出条件
- Gemfile に "rails" が含まれる

## プロジェクト構成
- config/routes.rb — ルーティング定義
- app/controllers/ — コントローラー
- app/models/ — ActiveRecordモデル
- app/views/ — ERBテンプレート（ビュー）
- db/migrate/ — マイグレーション
- db/schema.rb — データベーススキーマ
- app/serializers/ — JSONシリアライザー（API用）
- app/services/ — サービスオブジェクト
- app/jobs/ — バックグラウンドジョブ
- spec/ または test/ — テスト

## ルーティング形式
```ruby
Rails.application.routes.draw do
  resources :users                     # 7つのRESTfulルートを生成
  resources :posts, only: [:index, :show, :create]
  namespace :api do
    namespace :v1 do
      resources :articles
    end
  end
  get '/dashboard', to: 'dashboard#index'
  post '/login', to: 'sessions#create'
end
```
- resources は index/show/new/create/edit/update/destroy の7ルートを生成
- namespace でパスとコントローラーの名前空間をネスト

## モデル形式
```ruby
class User < ApplicationRecord
  has_many :posts
  has_one :profile
  belongs_to :company
  has_and_belongs_to_many :roles
  validates :name, presence: true
  validates :email, uniqueness: true
  scope :active, -> { where(active: true) }
end
```
- リレーション: has_many, has_one, belongs_to, has_and_belongs_to_many, has_many :through
- validates でバリデーション定義
- scope でクエリスコープ定義

## コントローラー形式
```ruby
class UsersController < ApplicationController
  before_action :authenticate_user!
  def index; end
  def show; end
  def create; end
  def update; end
  def destroy; end
end
```

## CRUD操作パターン

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にCRUD操作パターンや
> データアクセス層の規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの一般的なパターンであり、フォールバックとして参照する。

### ActiveRecord 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `Model.create(...)`, `Model.new(...).save`, `Model.create!(...)`, `Model.find_or_create_by(...)` |
| Read | `Model.find(id)`, `Model.find_by(...)`, `Model.where(...)`, `Model.all`, `Model.first`, `Model.last`, `Model.pluck(...)` |
| Update | `record.update(...)`, `record.update!(...)`, `record.save`, `Model.update_all(...)`, `record.increment!(...)`, `record.toggle!(...)` |
| Delete | `record.destroy`, `record.destroy!`, `Model.destroy_all(...)`, `record.delete`, `Model.delete_all(...)` |

### リレーション経由の操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `parent.children.create(...)`, `parent.children.build(...)`, `parent.children << child` |
| Read | `parent.children`, `parent.children.where(...)`, `parent.children.find(id)` |
| Update | `parent.children.update_all(...)` |
| Delete | `parent.children.destroy_all`, `parent.children.delete_all` |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: Controller → Model（直接操作）
```ruby
class OrdersController < ApplicationController
  def create
    @order = Order.create!(order_params)               # Order: Create
    @order.order_items.create!(item_params)             # OrderItem: Create
    Stock.where(product_id: pid).decrement!(:qty)       # Stock: Update
  end
end
```

### パターン2: Controller → Service → Model
```ruby
# Controller
def create
  OrderService.new.create_order(order_params)
end
# Service
class OrderService
  def create_order(params)
    order = Order.create!(params)                       # Order: Create
    StockService.new.decrement(params[:items])           # Stock: Update
    order
  end
end
```

### パターン3: Callback / Job 経由
```ruby
class Order < ApplicationRecord
  after_create :send_notification
  after_destroy :restore_stock
  private
  def send_notification
    Notification.create!(...)                            # Notification: Create
  end
  def restore_stock
    stock_items.each { |s| s.increment!(:qty) }         # Stock: Update
  end
end
```
```
