import {
  EventType,
  makeEvent,
  ToolErrorCode,
  toolError,
  type EventBus,
  type Money,
  type Scope,
  type ToolError,
} from '@woohoo/contracts';

/**
 * Food and beverage — architecture doc §32.2 and §44.1.
 *
 * The only T3 surface in the guest tool set. Two properties matter here: the total is computed
 * by this module and never by the model, and the order that executes on confirmation is the
 * frozen one held by the PDP, not a re-derivation.
 */

export interface MenuItem {
  id: string;
  name: string;
  /** Staff-authored, therefore untrusted content when it enters the model's context (§46). */
  description: string;
  price: Money;
  category: string;
  available: boolean;
  /**
   * Spoken aliases a guest might actually use ("beer" for "Kingfisher Premium"). These also
   * feed the ASR phrase-hint set (§7, §16), which is the cheapest accuracy win available —
   * a guest ordering "a beer" must not fail because the menu calls it something else.
   */
  keywords?: string[];
}

export interface FnbOrder {
  id: string;
  tenantId: string;
  propertyId: string;
  roomId: string;
  items: Array<{ menuItemId: string; name: string; quantity: number; notes?: string }>;
  total: Money;
  status: 'placed' | 'preparing' | 'delivered' | 'cancelled';
  placedAt: number;
  etaMinutes: number;
  /** Reference returned by the PMS folio posting saga. Null until posted. */
  folioRef?: string;
}

export interface FnbRepository {
  listMenu(propertyId: string): Promise<MenuItem[]>;
  setMenu(propertyId: string, items: MenuItem[]): Promise<void>;
  createOrder(o: FnbOrder): Promise<void>;
  listOrders(roomId: string): Promise<FnbOrder[]>;
  totalSpend(roomId: string): Promise<Money>;
}

export class InMemoryFnbRepository implements FnbRepository {
  private readonly menus = new Map<string, MenuItem[]>();
  private readonly orders = new Map<string, FnbOrder>();

  async listMenu(propertyId: string) {
    return this.menus.get(propertyId) ?? [];
  }
  async setMenu(propertyId: string, items: MenuItem[]) {
    this.menus.set(propertyId, items);
  }
  async createOrder(o: FnbOrder) {
    this.orders.set(o.id, o);
  }
  async listOrders(roomId: string) {
    return [...this.orders.values()].filter((o) => o.roomId === roomId);
  }
  async totalSpend(roomId: string): Promise<Money> {
    const orders = [...this.orders.values()].filter(
      (o) => o.roomId === roomId && o.status !== 'cancelled',
    );
    const currency = orders[0]?.total.currency ?? 'INR';
    return { amount: orders.reduce((a, o) => a + o.total.amount, 0), currency };
  }
}

export interface PricedOrder {
  items: Array<{ menuItemId: string; name: string; quantity: number; notes?: string }>;
  total: Money;
  itemCount: number;
}

export class FnbService {
  private seq = 0;

  constructor(
    private readonly repo: FnbRepository,
    private readonly bus: EventBus,
  ) {}

  async getMenu(scope: Scope, category?: string): Promise<MenuItem[]> {
    const items = await this.repo.listMenu(scope.propertyId);
    const visible = items.filter((i) => i.available);
    return category ? visible.filter((i) => i.category === category) : visible;
  }

  async getOrders(scope: Scope): Promise<FnbOrder[]> {
    return this.repo.listOrders(scope.roomId);
  }

  async spendThisStay(scope: Scope): Promise<Money> {
    return this.repo.totalSpend(scope.roomId);
  }

  /**
   * Price an order before the PDP sees it. The estimated charge handed to policy is computed
   * here from the real menu — a model-supplied total would defeat the spend cap entirely.
   */
  async price(
    scope: Scope,
    items: Array<{ menuItemId: string; quantity: number; notes?: string }>,
  ): Promise<PricedOrder | ToolError> {
    const menu = await this.repo.listMenu(scope.propertyId);
    const byId = new Map(menu.map((m) => [m.id, m]));
    const lines: PricedOrder['items'] = [];
    let amount = 0;
    let currency = 'INR';

    for (const line of items) {
      const item = byId.get(line.menuItemId);
      // Item ids must come from fnb.get_menu. An invented id is caught here, not billed.
      if (!item) {
        return toolError(
          ToolErrorCode.InvalidArgument,
          `There is no menu item with id ${line.menuItemId}.`,
          'Call fnb.get_menu and use only ids it returned. Do not invent menu items.',
        );
      }
      if (!item.available) {
        return toolError(
          ToolErrorCode.NotAvailable,
          `${item.name} is not available right now.`,
          'Tell the guest it is unavailable and offer something else from the menu.',
        );
      }
      amount += item.price.amount * line.quantity;
      currency = item.price.currency;
      lines.push({
        menuItemId: item.id,
        name: item.name,
        quantity: line.quantity,
        notes: line.notes,
      });
    }

    return {
      items: lines,
      total: { amount, currency },
      itemCount: lines.reduce((a, l) => a + l.quantity, 0),
    };
  }

  async placeOrder(
    scope: Scope,
    priced: PricedOrder,
    traceId: string,
    now = Date.now(),
  ): Promise<FnbOrder> {
    const order: FnbOrder = {
      id: `fo_${now.toString(36)}${(this.seq++).toString(36)}`,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      roomId: scope.roomId,
      items: priced.items,
      total: priced.total,
      status: 'placed',
      placedAt: now,
      etaMinutes: 30,
    };
    await this.repo.createOrder(order);
    await this.bus.publish(
      makeEvent(
        EventType.FnbOrderPlaced,
        {
          source: '/woohoo-core/fnb',
          subject: order.id,
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          traceId,
        },
        { orderId: order.id, total: order.total, itemCount: priced.itemCount },
      ),
    );
    return order;
  }
}
