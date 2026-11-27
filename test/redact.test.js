import test from "node:test";
import assert from "node:assert/strict";
import { createRedactor, environmentSecrets, normalizeSecrets, StreamRedactor } from "../src/redact.js";

test("normalizes secrets longest-first and drops duplicates", () => {
  assert.deepEqual(normalizeSecrets(["abc", "abcdef", "abc", "", null]), ["abcdef", "abc"]);
});

test("redacts every occurrence of every secret", () => {
  const redactor = createRedactor(["secret-token", "SECRET-TOKEN"]);
  assert.equal(redactor.redact("a secret-token b SECRET-TOKEN"), `a ${redactor.marker} b ${redactor.marker}`);
  assert.equal(redactor.redact("nothing"), "nothing");
  assert.equal(redactor.active, true);
});

test("a secret containing the preferred marker still gets a disjoint marker", () => {
  const redactor = createRedactor(["[REDACTED]"]);
  assert.equal(redactor.marker.includes("["), false);
  assert.equal(redactor.redact("before [REDACTED] after").includes("[REDACTED]"), false);
});

test("redaction is idempotent for every marker", () => {
  for (const token of ["E", "]", "[REDACTED]", "2", "secret-token"]) {
    const redactor = createRedactor([token]);
    const once = redactor.redact(`x${token}y${token}`);
    assert.equal(once.includes(token), false, token);
    assert.equal(redactor.redact(once), once, token);
  }
});

test("redactValue preserves structure, own __proto__ keys and colliding keys", () => {
  const redactor = createRedactor(["tok"]);
  const input = JSON.parse('{"__proto__":{"x":1},"tok":1,"[REDACTED]":2,"nested":[{"tok":"v"}]}');
  const output = redactor.redactValue(input);
  assert.equal(Object.keys(output).length, Object.keys(input).length);
  assert.equal(Object.getOwnPropertyDescriptor(output, "__proto__").value.x, 1);
  assert.equal(output["[REDACTED]"], 1);
  assert.equal(output["[REDACTED]#2"], 2);
  assert.equal(output.nested[0]["[REDACTED]"], "v");
  assert.equal(JSON.stringify(output).includes("tok"), false);
  assert.deepEqual(redactor.redactValue(output), output);
});

test("a stream redactor holds a split token until it can be replaced whole", () => {
  const redactor = createRedactor(["secret-token"]);
  const stream = redactor.stream();
  assert.equal(stream.push("hello sec"), "hello ");
  assert.equal(stream.push("ret-tok"), "");
  assert.equal(stream.push("en world"), "[REDACTED] world");
  assert.equal(stream.flush(), "");
});

test("a stream redactor holds a secret that exactly fills the buffer", () => {
  const stream = new StreamRedactor(["abc"], createRedactor(["abc"]).redact);
  assert.equal(stream.push("ab"), "");
  assert.equal(stream.push("c"), "");
  assert.equal(stream.flush(), "[REDACTED]");
});

test("a stream redactor flushes an incomplete prefix", () => {
  const stream = createRedactor(["abcdef"]).stream();
  assert.equal(stream.push("hello abc"), "hello ");
  assert.equal(stream.flush(), "abc");
});

test("a held suffix cannot split a complete secret already in the buffer", () => {
  const secret = "abcdefghijklmnab";
  const redactor = createRedactor([secret]);
  for (const chunks of [[`${secret}c`], ["abcdef", "ghijklmnabc"]]) {
    const stream = redactor.stream();
    const output = chunks.map((chunk) => stream.push(chunk)).join("") + stream.flush();
    assert.equal(output, `${redactor.marker}c`);
  }
});

test("environment secrets are credential-shaped values only", () => {
  const secrets = environmentSecrets({
    CODERAX_TOKEN: "token-value-123456",
    OPENAI_API_KEY: "sk-1234567890",
    GITHUB_PAT: "github_pat_123456",
    HOME: "/home/me",
    SECRET_SHORT: "short",
  });
  assert.ok(secrets.includes("token-value-123456"));
  assert.ok(secrets.includes("sk-1234567890"));
  assert.ok(secrets.includes("github_pat_123456"));
  assert.equal(secrets.includes("/home/me"), false);
  assert.equal(secrets.includes("short"), false);
});

test("redaction never emits a secret through a marker or collision suffix", () => {
  for (const token of ["2", "E", "]", "a", "[REDACTED]"]) {
    const redactor = createRedactor([token]);
    const marker = redactor.marker;
    const values = [token, `${token}${marker}`, `${marker}${token}`, `${token}${token}`, `x${token}y`];
    for (const value of values) {
      const output = redactor.redactValue({ [value]: value, nested: [value] });
      for (const [key, entry] of Object.entries(output)) {
        assert.equal(key.includes(token), false, `${token} in key ${value}`);
        for (const text of [entry, ...entry]) {
          assert.equal(String(text).includes(token), false, `${token} in ${value}`);
        }
      }
    }
  }
});
