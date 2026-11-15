/**
 * Building a `PageImageLayout` (`Bridge.layoutPageImage`) for the two common ways a page image is cut
 * up: a grid of tiles, or horizontal strips. Plain geometry; a layout of any other shape is just its
 * own list of copies.
 */
import type { ImageRect, PageImageLayout, PageImageOp } from "@comical/contract";

function assertPermutation(order: readonly number[], n: number): void {
  const seen = new Set<number>();
  if (order.length !== n || order.some((i) => !Number.isInteger(i) || i < 0 || i >= n || seen.has(i) || !seen.add(i))) {
    throw new RangeError(`order must be a permutation of 0…${n - 1}`);
  }
}

const copy = (src: ImageRect, dst: ImageRect): PageImageOp => ({ op: "copy", src, dst });

/**
 * Put back an image cut into a `cols × rows` grid of `floor(width/cols) × floor(height/rows)` tiles,
 * numbered row-major from the top left, where destination tile `d` holds source tile `order[d]`.
 * The output is the input's size. Pixels past the grid (the division's remainder) are copied
 * through in place unless `keepEdges` is false, which leaves them blank.
 */
export function tileLayout(
  width: number,
  height: number,
  cols: number,
  rows: number,
  order: readonly number[],
  opts: { keepEdges?: boolean } = {},
): PageImageLayout {
  assertPermutation(order, cols * rows);
  const w = Math.floor(width / cols);
  const h = Math.floor(height / rows);
  if (w < 1 || h < 1) return { width, height, ops: [] };
  const ops: PageImageOp[] = [];
  if (opts.keepEdges !== false) {
    if (width > w * cols) ops.push(copy({ x: w * cols, y: 0, w: width - w * cols, h: height }, { x: w * cols, y: 0, w: width - w * cols, h: height }));
    if (height > h * rows) ops.push(copy({ x: 0, y: h * rows, w: w * cols, h: height - h * rows }, { x: 0, y: h * rows, w: w * cols, h: height - h * rows }));
  }
  order.forEach((src, dst) => {
    ops.push(
      copy(
        { x: (src % cols) * w, y: Math.floor(src / cols) * h, w, h },
        { x: (dst % cols) * w, y: Math.floor(dst / cols) * h, w, h },
      ),
    );
  });
  return { width, height, ops };
}

/**
 * Put back an image cut into `order.length` horizontal strips, each `floor(height/n)` tall except the
 * last source strip, which also takes the remainder. `order[k]` is the source strip drawn k-th from
 * the top; strips keep their heights, so the output is the input's size.
 */
export function stripLayout(width: number, height: number, order: readonly number[]): PageImageLayout {
  const n = order.length;
  assertPermutation(order, n);
  const base = Math.floor(height / n);
  if (base < 1) return { width, height, ops: [] };
  const tall = (i: number) => (i === n - 1 ? height - base * (n - 1) : base);
  const ops: PageImageOp[] = [];
  let y = 0;
  for (const src of order) {
    const h = tall(src);
    ops.push(copy({ x: 0, y: src * base, w: width, h }, { x: 0, y, w: width, h }));
    y += h;
  }
  return { width, height, ops };
}
