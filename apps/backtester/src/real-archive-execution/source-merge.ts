export interface MonotonicSource<T> {
  readonly name: string;
  readonly records: AsyncIterable<T>;
  readonly tsExtractor: (record: T) => bigint;
  readonly tieBreakRank: number;
}

interface SourceHead<T> {
  readonly sourceIndex: number;
  readonly name: string;
  readonly iterator: AsyncIterator<T>;
  readonly record: T;
  readonly ts: bigint;
  readonly tieBreakRank: number;
  readonly sourceSequence: number;
}

interface SourceState<T> {
  readonly sourceIndex: number;
  readonly name: string;
  readonly iterator: AsyncIterator<T>;
  readonly tsExtractor: (record: T) => bigint;
  readonly tieBreakRank: number;
  sourceSequence: number;
}

export async function* mergeMonotonicSources<T>(
  sources: readonly MonotonicSource<T>[],
): AsyncIterable<T> {
  const heap = new MinHeap<SourceHead<T>>(compareHeads);
  const states = sources.map((source, sourceIndex): SourceState<T> => ({
    sourceIndex,
    name: source.name,
    iterator: source.records[Symbol.asyncIterator](),
    tsExtractor: source.tsExtractor,
    tieBreakRank: source.tieBreakRank,
    sourceSequence: 0,
  }));

  for (const state of states) {
    const head = await readHead(state);
    if (head !== null) {
      heap.push(head);
    }
  }

  while (heap.size > 0) {
    const head = heap.pop();
    yield head.record;
    const state = states[head.sourceIndex]!;
    const next = await readHead(state);
    if (next !== null) {
      heap.push(next);
    }
  }
}

async function readHead<T>(state: SourceState<T>): Promise<SourceHead<T> | null> {
  const next = await state.iterator.next();
  if (next.done === true) {
    return null;
  }
  const sourceSequence = state.sourceSequence;
  state.sourceSequence += 1;
  return {
    sourceIndex: state.sourceIndex,
    name: state.name,
    iterator: state.iterator,
    record: next.value,
    ts: state.tsExtractor(next.value),
    tieBreakRank: state.tieBreakRank,
    sourceSequence,
  };
}

function compareHeads<T>(left: SourceHead<T>, right: SourceHead<T>): number {
  if (left.ts < right.ts) return -1;
  if (left.ts > right.ts) return 1;
  const rankOrder = left.tieBreakRank - right.tieBreakRank;
  if (rankOrder !== 0) return rankOrder;
  const sourceOrder = left.sourceIndex - right.sourceIndex;
  if (sourceOrder !== 0) return sourceOrder;
  return left.sourceSequence - right.sourceSequence;
}

class MinHeap<T> {
  private readonly values: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get size(): number {
    return this.values.length;
  }

  push(value: T): void {
    this.values.push(value);
    this.bubbleUp(this.values.length - 1);
  }

  pop(): T {
    const head = this.values[0];
    if (head === undefined) {
      throw new Error('cannot pop from empty heap');
    }
    const tail = this.values.pop();
    if (this.values.length > 0 && tail !== undefined) {
      this.values[0] = tail;
      this.sinkDown(0);
    }
    return head;
  }

  private bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.compare(this.values[current]!, this.values[parent]!) >= 0) {
        return;
      }
      this.swap(current, parent);
      current = parent;
    }
  }

  private sinkDown(index: number): void {
    let current = index;
    while (true) {
      const left = current * 2 + 1;
      const right = left + 1;
      let smallest = current;
      if (
        left < this.values.length &&
        this.compare(this.values[left]!, this.values[smallest]!) < 0
      ) {
        smallest = left;
      }
      if (
        right < this.values.length &&
        this.compare(this.values[right]!, this.values[smallest]!) < 0
      ) {
        smallest = right;
      }
      if (smallest === current) {
        return;
      }
      this.swap(current, smallest);
      current = smallest;
    }
  }

  private swap(left: number, right: number): void {
    const value = this.values[left]!;
    this.values[left] = this.values[right]!;
    this.values[right] = value;
  }
}
