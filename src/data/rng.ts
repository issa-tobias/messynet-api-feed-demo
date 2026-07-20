// Small seeded PRNG so demo runs are reproducible (same client + run
// produces the same sample data), without pulling in a dependency.
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

export class Rng {
  private next: () => number;

  constructor(seed: string) {
    this.next = mulberry32(seedFromString(seed));
  }

  float(min = 0, max = 1): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  // Deterministic hex string (e.g. for mock post ids). Unlike
  // crypto.randomBytes, repeated generation from the same seed state
  // yields the same sequence - so paginated/repeated queries against the
  // mock return stable identifiers.
  hex(chars: number): string {
    let out = "";
    while (out.length < chars) {
      out += this.int(0, 15).toString(16);
    }
    return out;
  }
}
