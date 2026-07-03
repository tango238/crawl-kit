import { describe, expect, it } from "vitest";
import { extractEvents, extractStateTransitions, type SourceFile } from "./events.js";

const file = (path: string, content: string): SourceFile => ({ path, content });

describe("extractEvents", () => {
  it("finds past-tense event declarations and links the enclosing class", () => {
    const events = extractEvents([
      file(
        "src/order.ts",
        [
          "export class Order {",
          "  place() {",
          "    this.bus.emit(new OrderPlaced(this.id));",
          "  }",
          "}",
          "export interface OrderShipped { orderId: string }",
        ].join("\n"),
      ),
    ]);
    const names = events.map((e) => e.name).sort();
    expect(names).toEqual(["OrderPlaced", "OrderShipped"]);
    expect(events.find((e) => e.name === "OrderPlaced")?.aggregate).toBe("Order");
    expect(events.find((e) => e.name === "OrderPlaced")?.source).toBe("src/order.ts:3");
  });

  it("recognises an explicit *Event suffix and dedups across files", () => {
    const events = extractEvents([
      file("a.ts", "type PaymentEvent = { id: string }"),
      file("b.ts", "publish(PaymentEvent)"),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe("PaymentEvent");
  });

  it("ignores non-event PascalCase names", () => {
    const events = extractEvents([file("c.ts", "class OrderService {}\ninterface OrderDto {}")]);
    expect(events).toEqual([]);
  });
});

describe("extractStateTransitions", () => {
  it("captures a literal assigned to a status field; from is null (unknown)", () => {
    const trans = extractStateTransitions([
      file(
        "src/order.ts",
        ["class Order {", "  ship() {", "    this.status = 'shipped';", "  }", "}"].join("\n"),
      ),
    ]);
    expect(trans).toHaveLength(1);
    expect(trans[0]).toMatchObject({
      aggregate: "Order",
      from: null,
      to: "shipped",
      trigger: "ship",
      source: "src/order.ts:3",
    });
  });

  it("captures an object-literal status and dedups per (aggregate, to)", () => {
    const trans = extractStateTransitions([
      file("a.ts", "class Booking {\n  await db.update({ status: 'confirmed' });\n}"),
      file("b.ts", "class Booking {\n  x.status = 'confirmed';\n}"),
    ]);
    // same (Booking, confirmed) seen twice → one record
    expect(trans.filter((t) => t.to === "confirmed")).toHaveLength(1);
  });
});
