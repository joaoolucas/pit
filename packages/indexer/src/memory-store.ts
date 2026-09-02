/**
 * An in-memory implementation of the slice of Envio's handler context that
 * folds.ts uses.
 *
 * Two callers: the fold tests, and the local dev harness in
 * packages/contracts/scripts/local-indexer.ts. Both run the same fold code that
 * ships to Envio — this file only replaces where the rows are kept.
 */
import type { Store } from "./folds.ts";

export type MemoryStore = {
  store: Store;
  table: (name: string) => Map<string, Record<string, unknown>>;
  rows: <T>(name: string) => T[];
  row: <T>(name: string, id: string) => T | undefined;
};

export function createMemoryStore(): MemoryStore {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();

  const table = (name: string) => {
    let existing = tables.get(name);
    if (!existing) {
      existing = new Map();
      tables.set(name, existing);
    }
    return existing;
  };

  const entity = (name: string) => ({
    get: async (id: string) => table(name).get(id) as never,
    getWhere: async (filter: Record<string, { _eq?: unknown }>) =>
      [...table(name).values()].filter((row) =>
        Object.entries(filter).every(([field, condition]) => row[field] === condition._eq),
      ) as never,
    set: (row: { id: string }) => {
      table(name).set(row.id, row as Record<string, unknown>);
    },
  });

  const store = {
    Order: entity("Order"),
    BookLevel: entity("BookLevel"),
    MarketMaker: entity("MarketMaker"),
    CellState: entity("CellState"),
    WindowCvd: entity("WindowCvd"),
    Fill: entity("Fill"),
    Account: entity("Account"),
    Window: entity("Window"),
    Market: entity("Market"),
  } as unknown as Store;

  return {
    store,
    table,
    rows: <T>(name: string) => [...table(name).values()] as T[],
    row: <T>(name: string, id: string) => table(name).get(id) as T | undefined,
  };
}
