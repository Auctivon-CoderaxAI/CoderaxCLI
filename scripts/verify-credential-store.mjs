#!/usr/bin/env node
/**
 * Exercise the real operating-system credential store on a test machine.
 *
 * This script deliberately does not use a mock: a failure means the platform
 * store is missing, locked or unable to round-trip the item. It never prints the
 * secret, and deletes the unique item it creates. CI runs it on the free
 * standard Windows, macOS and Ubuntu runners.
 */
import { randomUUID } from "node:crypto";
import {
  createCredentialStore,
  credentialAccount,
} from "../src/credentials.js";

const store = createCredentialStore({ env: process.env });
const description = await store.describe();
if (!store.available) {
  console.error(`credential store unavailable: ${description.name} (${description.detail})`);
  process.exit(1);
}

const id = randomUUID();
const account = credentialAccount(`https://credential-verification.invalid/${id}`);
const secret = `coderax-store-verification-${id}`;
let created = false;

try {
  await store.set(account, secret);
  created = true;
  const readBack = await store.get(account);
  if (readBack !== secret) {
    throw new Error("the credential store returned a different value");
  }
  const removed = await store.delete(account);
  created = false;
  if (!removed) throw new Error("the credential store did not delete the test item");
  if ((await store.get(account)) !== null) {
    throw new Error("the deleted credential store item is still readable");
  }
  console.log(`verified ${description.name} (${description.detail})`);
} catch (error) {
  console.error(`credential store verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await store.delete(account);
    } catch {
      // Best-effort cleanup; the item is unique to this verification run.
    }
  }
}
