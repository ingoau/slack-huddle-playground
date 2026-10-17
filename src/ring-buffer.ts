/** Keeps the latest `capacity` items, overwriting the oldest in place. */
export class RingBuffer<T> {
  private items: (T | undefined)[];
  private start = 0;
  size = 0;

  constructor(readonly capacity: number) {
    this.items = new Array(capacity);
  }

  push(item: T) {
    const end = (this.start + this.size) % this.capacity;
    this.items[end] = item;
    if (this.size < this.capacity) this.size++;
    else this.start = (this.start + 1) % this.capacity;
  }

  clear() {
    this.items = new Array(this.capacity);
    this.start = 0;
    this.size = 0;
  }

  /** Oldest first. */
  *[Symbol.iterator]() {
    for (let i = 0; i < this.size; i++)
      yield this.items[(this.start + i) % this.capacity] as T;
  }
}
