import { expect, test } from "bun:test";
import { RingBuffer } from "./ring-buffer.ts";

test("keeps the latest items, oldest first", () => {
  const ring = new RingBuffer<number>(3);
  for (const n of [1, 2, 3, 4, 5]) ring.push(n);
  expect([...ring]).toEqual([3, 4, 5]);
  ring.clear();
  ring.push(9);
  expect([...ring]).toEqual([9]);
});
