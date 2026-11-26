import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalResource,
  PermissionBroker,
  permissionOptions,
  verifyPermissionRequest,
} from "../src/terminal/permissions.js";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");

function request(overrides = {}) {
  return {
    type: "permission_request",
    serverIssued: true,
    requestId: "srv_req_123456",
    executionId: "exec_123",
    action: "read_file",
    resource: "/tmp/file.txt",
    scope: "once",
    ...overrides,
  };
}

function broker(options = {}) {
  const calls = [];
  const instance = new PermissionBroker({
    capabilities: { permissions: true },
    channelVerified: true,
    now: () => NOW,
    platform: "linux",
    respond: async (payload) => {
      calls.push(payload);
    },
    ...options,
  });
  return { instance, calls };
}

test("a verified request becomes pending with exact-once and deny options", () => {
  const { instance } = broker();
  const verdict = instance.consider(request());
  assert.equal(verdict.status, "pending");
  assert.deepEqual(verdict.options.map((option) => option.decision), ["once", "deny"]);
  assert.equal(instance.pendingCount, 1);
});

test("approval echoes the exact request, execution and resource bindings", async () => {
  const { instance, calls } = broker();
  const verdict = instance.consider(request());
  const result = await instance.respond(verdict.entry.request.requestId, "once");
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], {
    requestId: "srv_req_123456",
    executionId: "exec_123",
    action: "read_file",
    resourceHash: verdict.entry.request.resourceHash,
    decision: "once",
    decidedAt: new Date(NOW).toISOString(),
  });
  assert.equal(instance.pendingCount, 0);
});

test("an unverified or model-generated request is denied without prompting", () => {
  const { instance } = broker();
  for (const invalid of [
    request({ serverIssued: false }),
    request({ serverIssued: undefined }),
    request({ requestId: "" }),
    request({ requestId: "short" }),
    request({ executionId: "" }),
    request({ action: "launch_missiles" }),
    request({ resource: "relative/path" }),
    request({ resource: "/tmp/\u001b[2Jfile" }),
  ]) {
    const verdict = instance.consider(invalid);
    assert.equal(verdict.status, "denied", JSON.stringify(invalid));
  }
  assert.equal(instance.pendingCount, 0);
});

test("no verified channel means fail closed", () => {
  const noChannel = broker({ channelVerified: false });
  assert.equal(noChannel.instance.consider(request()).reason, "CHANNEL_UNAVAILABLE");
  const noCapability = broker({ capabilities: { permissions: false } });
  assert.equal(noCapability.instance.consider(request()).reason, "CHANNEL_UNAVAILABLE");
});

test("an expired request is denied", () => {
  const { instance } = broker();
  const verdict = instance.consider(request({ expiresAt: "2026-11-26T11:59:00.000Z" }));
  assert.equal(verdict.status, "denied");
  assert.equal(verdict.reason, "EXPIRED");
});

test("a server resource hash must match the exact resource", () => {
  const { instance } = broker();
  const verdict = instance.consider(request({ resourceHash: "not-the-hash" }));
  assert.equal(verdict.status, "denied");
  assert.equal(verdict.reason, "RESOURCE_HASH_MISMATCH");
});

test("session grants are scoped to the exact action, resource and execution", async () => {
  const { instance } = broker();
  const first = instance.consider(request({ scope: "session" }));
  assert.deepEqual(first.options.map((option) => option.decision), ["once", "session", "deny"]);
  assert.equal((await instance.respond(first.entry.request.requestId, "session")).ok, true);

  const same = instance.consider(request({ requestId: "srv_req_654321", scope: "session" }));
  assert.equal(same.status, "session-granted");
  assert.equal((await instance.respond(same.entry.request.requestId, "once")).ok, true);

  const differentResource = instance.consider(
    request({ requestId: "srv_req_777777", resource: "/tmp/other.txt", scope: "session" }),
  );
  assert.equal(differentResource.status, "pending");

  const differentExecution = instance.consider(
    request({ requestId: "srv_req_888888", executionId: "exec_999", scope: "session" }),
  );
  assert.equal(differentExecution.status, "pending");
  assert.equal(instance.grants().length, 1);

  instance.endExecution("exec_123");
  assert.equal(instance.grants().length, 0);
  const afterEnd = instance.consider(request({ requestId: "srv_req_999999", scope: "session" }));
  assert.equal(afterEnd.status, "pending");
});

test("a session decision is refused when the server offered once only", async () => {
  const { instance } = broker();
  const verdict = instance.consider(request({ scope: "once" }));
  const result = await instance.respond(verdict.entry.request.requestId, "session");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SESSION_SCOPE_NOT_OFFERED");
});

test("replay, duplicate ids and unknown ids are rejected", async () => {
  const { instance } = broker();
  const verdict = instance.consider(request());
  assert.equal(instance.consider(request()).status, "denied");
  assert.equal((await instance.respond(verdict.entry.request.requestId, "once")).ok, true);
  const replay = await instance.respond(verdict.entry.request.requestId, "once");
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "UNKNOWN_REQUEST");
});

test("a failed approval delivery fails closed", async () => {
  const { instance } = broker({
    respond: async () => {
      throw new Error("gateway unreachable");
    },
  });
  const verdict = instance.consider(request());
  const result = await instance.respond(verdict.entry.request.requestId, "once");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CHANNEL_FAILED");
});

test("actions unsupported by the transport are denied", () => {
  const { instance } = broker({ capabilities: { permissions: ["read_file"] } });
  assert.equal(instance.consider(request()).status, "pending");
  const denied = instance.consider(
    request({ requestId: "srv_req_555555", action: "run_command", resource: "rm -rf /" }),
  );
  assert.equal(denied.status, "denied");
  assert.equal(denied.reason, "ACTION_UNSUPPORTED");
});

test("canonical resources normalise only where that is safe", () => {
  assert.equal(canonicalResource("read_file", "/tmp/a/../b", { platform: "linux" }).value, "/tmp/b");
  assert.equal(canonicalResource("run_command", "  ls   -la ", { platform: "linux" }).value, "ls   -la");
  assert.equal(canonicalResource("network", "https://user:pass@example.com/x", { platform: "linux" }).ok, false);
  assert.equal(canonicalResource("network", "https://example.com/x").value, "https://example.com/x");
  assert.equal(canonicalResource("send_files", JSON.stringify(["/b", "/a"])).value, JSON.stringify(["/a", "/b"]));
});

test("verifyPermissionRequest reports scopes and display values", () => {
  const verdict = verifyPermissionRequest(request(), {
    channelVerified: true,
    capabilities: { permissions: true },
    now: NOW,
    platform: "linux",
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.request.scope, "once");
  assert.equal(verdict.request.displayResource, "/tmp/file.txt");
  assert.equal(permissionOptions(verdict.entry ?? { request: verdict.request }).length >= 2, true);
});
