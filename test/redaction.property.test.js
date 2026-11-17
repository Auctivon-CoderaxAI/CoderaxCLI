import test from "node:test";
import assert from "node:assert/strict";
import { redact, redactValue } from "../src/client.js";

// A fixed seed keeps every failure reproducible: the assertion message names
// the seed, iteration, token and input that broke the property.
const SEEDS = [0x5eed1234, 0x0badf00d, 0x1234abcd];
const TOKEN_ALPHABET = "abcXYZ[]{}*#~^|+=%0123456789_-./:@ \t\u00e9\u2588\ud83d\ude42";
const TEXT_ALPHABET = "abcXYZ[]{}*#~^|+=%0123456789 \t\n\u00e9\u2588\ud83d\ude42";
const LETTER_ALPHABET = "abcXYZ\u00e9\u2588\ud83d\ude42";
const FIXED_TOKENS = [
  "E",
  "]",
  "]A",
  "*",
  "#",
  "2",
  "[REDACTED]",
  "[REDACTED]*#~^|+=%0123456789",
  "\u00e9",
  "\u2588",
  "\ud83d\ude42",
  "token-that-must-never-leak",
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed) {
  const next = mulberry32(seed);
  const int = (maxExclusive) => Math.floor(next() * maxExclusive);
  const pick = (items) => items[int(items.length)];
  const string = (alphabet, minLength, maxLength) => {
    const length = minLength + int(maxLength - minLength + 1);
    let text = "";
    for (let index = 0; index < length; index += 1) {
      text += pick(alphabet);
    }
    return text;
  };
  return { next, int, pick, string };
}

function textContaining(gen, token) {
  let text = "";
  const occurrences = 1 + gen.int(4);
  for (let index = 0; index < occurrences; index += 1) {
    text += gen.string(TEXT_ALPHABET, 0, 8);
    text += token;
    text += gen.string(TEXT_ALPHABET, 0, 8);
  }
  return text;
}

function stringsIn(value, found = []) {
  if (typeof value === "string") {
    found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, found);
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      found.push(key);
      stringsIn(item, found);
    }
  }
  return found;
}

function context(seed, iteration, token, value) {
  return `seed=0x${seed.toString(16)} case=${iteration} token=${JSON.stringify(token)} value=${JSON.stringify(value)}`;
}

test("property: every redaction marker is disjoint from its token", () => {
  for (const seed of SEEDS) {
    const gen = generator(seed);
    const tokens = [
      ...FIXED_TOKENS,
      ...Array.from({ length: 120 }, () => gen.string(TOKEN_ALPHABET, 1, 8)),
    ];

    tokens.forEach((token, iteration) => {
      const marker = redact(token, token);
      const where = context(seed, iteration, token, marker);

      assert.ok(marker.length > 0, `empty marker; ${where}`);
      assert.equal(marker.includes(token), false, `marker contains token; ${where}`);
      for (const char of marker) {
        assert.equal(token.includes(char), false, `marker shares ${JSON.stringify(char)} with token; ${where}`);
      }
      // A safe marker must survive a second pass unchanged.
      assert.equal(redact(marker, token), marker, `marker was rewritten on a second pass; ${where}`);
    });
  }
});

test("property: redaction removes every occurrence and is idempotent", () => {
  for (const seed of SEEDS) {
    const gen = generator(seed);

    for (let iteration = 0; iteration < 120; iteration += 1) {
      const token = gen.string(TOKEN_ALPHABET, 1, 8);
      const input = textContaining(gen, token);
      const once = redact(input, token);
      const where = context(seed, iteration, token, input);

      assert.equal(once.includes(token), false, `token survived redaction; ${where}`);
      assert.equal(redact(once, token), once, `redaction is not idempotent; ${where}`);
    }
  }
});

test("property: colliding object keys keep every field and stay token-free", () => {
  for (const seed of SEEDS) {
    const gen = generator(seed);

    for (let iteration = 0; iteration < 80; iteration += 1) {
      const token = gen.string(TOKEN_ALPHABET, 1, 6);
      const marker = redact(token, token);
      const base = marker.repeat(1 + gen.int(2));
      const keys = new Set([
        base,
        `${base}#2`,
        `${base}#3`,
        token.repeat(2),
        `${token}${marker}`,
        `${marker}${token}`,
        `${gen.string(TEXT_ALPHABET, 0, 4)}${token}${gen.string(TEXT_ALPHABET, 0, 4)}`,
        `${token}${gen.string(TEXT_ALPHABET, 0, 4)}${token}`,
      ]);
      const input = Object.fromEntries(
        [...keys].map((key, index) => [key, `value-${index}-${token}`]),
      );
      const redacted = redactValue(input, token);
      const where = context(seed, iteration, token, input);

      assert.equal(
        Object.keys(redacted).length,
        Object.keys(input).length,
        `a colliding key or field was dropped; ${where}`,
      );
      for (const text of stringsIn(redacted)) {
        assert.equal(text.includes(token), false, `token survived in a key or value; ${where}`);
      }
      for (const value of Object.values(redacted)) {
        assert.equal(typeof value, "string", `a field value changed type; ${where}`);
      }
      assert.deepEqual(
        Object.values(redacted).sort(),
        Object.values(input).map((value) => redact(value, token)).sort(),
        `field values were not preserved; ${where}`,
      );
      assert.deepEqual(redactValue(redacted, token), redacted, `redacting twice changed the object; ${where}`);
    }
  }
});

test("property: collision suffixes skip occupied names", () => {
  for (const seed of SEEDS) {
    const gen = generator(seed);

    for (let iteration = 0; iteration < 80; iteration += 1) {
      // Keep "#" and digits out of the token so `${base}#2` is an occupied key
      // that survives redaction, which is the condition this property exercises.
      const token = gen.string(LETTER_ALPHABET, 1, 6);
      const marker = redact(token, token);
      const base = marker.repeat(2);
      const occupied = [2, 3, 4, 5];
      const input = Object.fromEntries([
        ...occupied.map((suffix) => [`${base}#${suffix}`, `occupied-${suffix}`]),
        [`${token}${token}`, "first"],
        [`${token}${marker}`, "second"],
        [`${marker}${token}`, "third"],
        [base, "fourth"],
      ]);
      const redacted = redactValue(input, token);
      const where = context(seed, iteration, token, input);

      assert.equal(Object.keys(redacted).length, Object.keys(input).length, `field count changed; ${where}`);
      for (const suffix of occupied) {
        assert.ok(
          Object.hasOwn(redacted, `${base}#${suffix}`),
          `occupied key ${base}#${suffix} was overwritten; ${where}`,
        );
      }
      assert.equal(Object.hasOwn(redacted, `${base}#6`), true, `first free suffix was not #6; ${where}`);
      assert.equal(Object.hasOwn(redacted, `${base}#7`), true, `next free suffix was not #7; ${where}`);
      assert.equal(Object.hasOwn(redacted, `${base}#8`), true, `next free suffix was not #8; ${where}`);
      for (const text of stringsIn(redacted)) {
        assert.equal(text.includes(token), false, `token survived the suffix search; ${where}`);
      }
    }
  }
});

test("property: a numeric token cannot return through a collision suffix", () => {
  for (const seed of SEEDS) {
    const gen = generator(seed);

    for (let iteration = 0; iteration < 80; iteration += 1) {
      const token = "2";
      const marker = redact(token, token);
      const base = marker.repeat(2);
      const input = {
        [`${base}#2`]: "occupied",
        [`${token}${token}`]: "first",
        [`${token}${marker}`]: "second",
        [`${marker}${token}`]: "third",
        [base]: "fourth",
        [`x${token}y`]: `prefix-${token}-suffix`,
      };
      const redacted = redactValue(input, token);
      const where = context(seed, iteration, token, input);

      assert.equal(Object.keys(redacted).length, Object.keys(input).length, `field count changed; ${where}`);
      for (const text of stringsIn(redacted)) {
        assert.equal(text.includes(token), false, `numeric token survived; ${where}`);
      }
      assert.deepEqual(redactValue(redacted, token), redacted, `redacting twice changed the object; ${where}`);
    }
  }
});
