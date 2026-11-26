import { PRODUCTS, STATUS_LABELS, getOrderedProducts } from "./product-registry.js";
import { CoderaxError, request } from "./client.js";
import { VERSION } from "./version.js";

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  UNAUTHENTICATED: 3,
  NETWORK: 4,
  NOT_FOUND: 5,
  UNAVAILABLE: 6,
  CANCELLED: 130,
});

export function table(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) => String(cell).padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((width) => "\u2500".repeat(width))), ...rows.map(line)];
}

const HEALTH_CANDIDATES = ["/health", "/api/health", "/healthz"];

export async function probeHealth({ baseUrl, token, timeoutMs, fetchImpl } = {}) {
  const attempts = [];
  for (const path of HEALTH_CANDIDATES) {
    try {
      const response = await request({ baseUrl, token, path, timeoutMs, fetchImpl });
      return { path, response };
    } catch (error) {
      attempts.push(`${path} (${error.code ?? "ERROR"})`);
      if (error.code === "HTTP_404" || error.code === "HTTP_405") continue;
      throw error;
    }
  }
  throw new CoderaxError(
    "HEALTH_UNAVAILABLE",
    `no health endpoint responded. Tried ${attempts.join(", ")}`,
  );
}

export async function products(runtime) {
  const list = getOrderedProducts();
  runtime.emit("products", { products: list }, () => {
    const rows = list.map((product) => [
      product.name,
      STATUS_LABELS[product.status],
      product.status === "live" ? product.tagline : product.availabilityNote,
    ]);
    runtime.write(table(rows, ["PRODUCT", "STATUS", "DETAIL"]).join("\n"));
    runtime.write("");
    runtime.write("Launch states are verified, not aspirational. See `coderax doctor`.");
  });
  return EXIT.OK;
}

export async function cloud(runtime) {
  const product = PRODUCTS.find((entry) => entry.id === "cloud");
  const message = `Coderax Cloud is ${STATUS_LABELS[product.status].toLowerCase()}: ${product.availabilityNote}`;
  runtime.emit("cloud", { status: product.status, message, roadmap: product.roadmap }, () => {
    runtime.write(message);
    runtime.write("");
    runtime.write("Roadmap:");
    for (const item of product.roadmap) runtime.write(`  \u2022 ${item}`);
    runtime.err("Nothing was executed and nothing was billed.");
  });
  return EXIT.UNAVAILABLE;
}

export async function projects(runtime) {
  runtime.emit("projects", {
    projects: [],
    unavailable: true,
    reason: "Cloud workspaces are not implemented in this deployment surface yet.",
  }, () => {
    runtime.err("Cloud workspaces are not implemented yet, so there are no projects to list.");
  });
  return EXIT.UNAVAILABLE;
}

export function update(runtime) {
  const message =
    "Updates are delivered as GitHub release archives for Windows, macOS and Linux; "
    + "the CLI publishes nothing to an external registry. Reinstall from the latest release.";
  runtime.emit("update", { version: VERSION, message }, () => runtime.write(message));
  return EXIT.OK;
}
