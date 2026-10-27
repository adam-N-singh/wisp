// Minimal external store for useSyncExternalStore.
import { useSyncExternalStore } from "react";

export class Store<T> {
  private listeners = new Set<() => void>();

  constructor(private state: T) {}

  get(): T {
    return this.state;
  }

  set(next: T | ((previous: T) => T)): void {
    const value = typeof next === "function" ? (next as (previous: T) => T)(this.state) : next;
    if (Object.is(value, this.state)) return;
    this.state = value;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useStore<T, S = T>(store: Store<T>, select: (state: T) => S = (state) => state as unknown as S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
