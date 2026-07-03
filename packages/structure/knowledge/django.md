# Django (Python)

## 検出条件
- requirements.txt, pyproject.toml, Pipfile に "django" が含まれる
- manage.py が存在する

## プロジェクト構成
- manage.py — Django管理コマンド
- <project>/settings.py — 設定
- <project>/urls.py — プロジェクトレベルURLルーティング
- <app>/urls.py — アプリレベルURLルーティング
- <app>/views.py — ビュー（コントローラー相当）
- <app>/models.py — モデル定義
- <app>/serializers.py — DRFシリアライザー（API用）
- <app>/admin.py — 管理画面設定
- <app>/forms.py — フォーム定義
- <app>/templates/ — HTMLテンプレート
- <app>/migrations/ — マイグレーション

## ルーティング形式
```python
# urls.py
from django.urls import path, include
from rest_framework.routers import DefaultRouter

urlpatterns = [
    path('api/users/', views.UserListView.as_view()),
    path('api/users/<int:pk>/', views.UserDetailView.as_view()),
    path('api/', include(router.urls)),
]

router = DefaultRouter()
router.register('articles', ArticleViewSet)
```
- Django REST Framework (DRF) の ViewSet + Router で RESTful API を自動生成
- path() で個別ルート定義、include() でアプリのURLをインクルード

## モデル形式
```python
class User(models.Model):
    name = models.CharField(max_length=100)
    email = models.EmailField(unique=True)
    company = models.ForeignKey(Company, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'users'
        ordering = ['-created_at']
```
- リレーション: ForeignKey, OneToOneField, ManyToManyField
- on_delete で削除時の動作を指定（CASCADE, SET_NULL, PROTECT等）

## ビュー形式
```python
# Class-based views (DRF)
class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.all()
    serializer_class = UserSerializer

# Function-based views
@api_view(['GET', 'POST'])
def user_list(request):
    ...
```

## CRUD操作パターン

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にCRUD操作パターンや
> データアクセス層の規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの一般的なパターンであり、フォールバックとして参照する。

### Django ORM 操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `Model.objects.create(...)`, `Model(...).save()`, `Model.objects.get_or_create(...)`, `Model.objects.bulk_create([...])` |
| Read | `Model.objects.get(pk=id)`, `Model.objects.filter(...)`, `Model.objects.all()`, `Model.objects.first()`, `Model.objects.values(...)` |
| Update | `obj.save()` (既存), `Model.objects.filter(...).update(...)`, `obj.field = value; obj.save()`, `Model.objects.bulk_update([...])` |
| Delete | `obj.delete()`, `Model.objects.filter(...).delete()` |

### リレーション経由の操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `parent.children.create(...)`, `parent.children.add(child)` |
| Read | `parent.children.all()`, `parent.children.filter(...)` |
| Update | `parent.children.update(...)` |
| Delete | `parent.children.remove(child)`, `parent.children.clear()` |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: View → Model（直接操作）
```python
class OrderViewSet(viewsets.ModelViewSet):
    def perform_create(self, serializer):
        order = serializer.save()                        # Order: Create
        Stock.objects.filter(product=pid).update(qty=F('qty') - 1)  # Stock: Update
```

### パターン2: View → Service → Model
```python
# views.py
class OrderCreateView(APIView):
    def post(self, request):
        return OrderService().create_order(request.data)
# services.py
class OrderService:
    def create_order(self, data):
        order = Order.objects.create(**data)              # Order: Create
        StockService().decrement(data['items'])           # Stock: Update
        Payment.objects.create(order=order, ...)          # Payment: Create
        return order
```

### パターン3: Signal 経由
```python
@receiver(post_save, sender=Order)
def on_order_created(sender, instance, created, **kwargs):
    if created:
        Notification.objects.create(...)                  # Notification: Create
@receiver(post_delete, sender=Order)
def on_order_deleted(sender, instance, **kwargs):
    instance.items.all().delete()                         # OrderItem: Delete
```
