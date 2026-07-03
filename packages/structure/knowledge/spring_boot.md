# Spring Boot (Java / Kotlin)

## 検出条件
- pom.xml に "spring-boot" が含まれる
- build.gradle / build.gradle.kts に "spring-boot" が含まれる

## プロジェクト構成
- src/main/java/<package>/
  - Application.java — エントリーポイント（@SpringBootApplication）
  - controller/ — RESTコントローラー
  - service/ — サービス層
  - repository/ — リポジトリ（データアクセス）
  - model/ または entity/ — JPAエンティティ
  - dto/ — DTOクラス
  - config/ — 設定クラス
- src/main/resources/
  - application.yml / application.properties — 設定ファイル
- src/test/java/ — テスト

## ルーティング形式
```java
@RestController
@RequestMapping("/api/v1/users")
public class UserController {
    @GetMapping
    public List<UserDto> listUsers() { ... }

    @GetMapping("/{id}")
    public UserDto getUser(@PathVariable Long id) { ... }

    @PostMapping
    public UserDto createUser(@RequestBody @Valid UserCreateDto dto) { ... }

    @PutMapping("/{id}")
    public UserDto updateUser(@PathVariable Long id, @RequestBody UserUpdateDto dto) { ... }

    @DeleteMapping("/{id}")
    public void deleteUser(@PathVariable Long id) { ... }
}
```
- @RequestMapping でベースパスを定義
- @GetMapping, @PostMapping, @PutMapping, @DeleteMapping でHTTPメソッド別にマッピング
- @PathVariable でURLパスパラメータ、@RequestBody でリクエストボディをバインド

## モデル形式（JPA）
```java
@Entity
@Table(name = "users")
public class User {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    @OneToMany(mappedBy = "user", cascade = CascadeType.ALL)
    private List<Post> posts;

    @ManyToOne
    @JoinColumn(name = "company_id")
    private Company company;
}
```
- リレーション: @OneToMany, @ManyToOne, @OneToOne, @ManyToMany
- @Table でテーブル名指定、@Column でカラム制約

## リポジトリ形式
```java
public interface UserRepository extends JpaRepository<User, Long> {
    List<User> findByNameContaining(String name);
    Optional<User> findByEmail(String email);
}
```

## CRUD操作パターン

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にCRUD操作パターンや
> データアクセス層の規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの一般的なパターンであり、フォールバックとして参照する。

### JPA Repository (Spring Data)
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `repository.save(new Entity(...))`, `repository.saveAll(list)`, `repository.saveAndFlush(entity)` |
| Read | `repository.findById(id)`, `repository.findAll()`, `repository.findBy*()`, `repository.existsById(id)`, `repository.count()` |
| Update | `repository.save(existingEntity)` (IDあり), `@Modifying @Query("UPDATE ...")` |
| Delete | `repository.delete(entity)`, `repository.deleteById(id)`, `repository.deleteAll(...)`, `repository.deleteAllInBatch()` |

### EntityManager 直接操作
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `em.persist(entity)` |
| Read | `em.find(Entity.class, id)`, `em.createQuery(...)`, `em.createNamedQuery(...)` |
| Update | `em.merge(entity)` |
| Delete | `em.remove(entity)` |

### JdbcTemplate / NamedParameterJdbcTemplate
| CRUD | メソッド/パターン |
|------|-----------------|
| Create | `jdbcTemplate.update("INSERT INTO ...")` |
| Read | `jdbcTemplate.query(...)`, `jdbcTemplate.queryForObject(...)` |
| Update | `jdbcTemplate.update("UPDATE ...")` |
| Delete | `jdbcTemplate.update("DELETE FROM ...")` |

## コール階層

> **注意**: 対象プロジェクトの CLAUDE.md または AGENTS.md にアーキテクチャ構成や
> レイヤー間の呼び出し規約が記載されている場合は、そちらを優先すること。
> 以下はフレームワークの典型的なパターンであり、フォールバックとして参照する。

### パターン1: Controller → Service → Repository（標準）
```java
// Controller
@PostMapping
public OrderDto createOrder(@RequestBody @Valid OrderCreateDto dto) {
    return orderService.createOrder(dto);
}
// Service
@Transactional
public OrderDto createOrder(OrderCreateDto dto) {
    Order order = orderRepository.save(new Order(...));     // Order: Create
    stockRepository.decrementByProductId(dto.productId());  // Stock: Update
    paymentRepository.save(new Payment(...));                // Payment: Create
    return OrderDto.from(order);
}
```

### パターン2: EventListener / ApplicationEvent 経由
```java
@TransactionalEventListener
public void onOrderCreated(OrderCreatedEvent event) {
    notificationRepository.save(new Notification(...));     // Notification: Create
}

@EventListener
public void onOrderDeleted(OrderDeletedEvent event) {
    orderItemRepository.deleteAllByOrderId(event.orderId()); // OrderItem: Delete
}
```

### パターン3: @Scheduled / Async 経由
```java
@Scheduled(cron = "0 0 * * * *")
public void cleanupExpiredOrders() {
    orderRepository.deleteAllByStatusAndCreatedBefore(...);  // Order: Delete
}
```
