import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifact, checksumText, sha256 } from "./lib/release.mjs";

const root = process.cwd();
const isWindows = process.platform === "win32";
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
    console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function run(file, args, options = {}) {
  return spawnSync(file, args, { encoding: "utf8", ...options });
}

// cmd.exe /s strips the outer pair, leaving each path quoted. Verbatim
// arguments keep Node from applying the unrelated Windows C argv escaping.
function runCmd(file, args, options) {
  const quote = (value) => {
    if (/["%\r\n]/.test(value)) throw new Error("Unsupported character in cmd.exe argument");
    return `"${value}"`;
  };
  const command = `"${[file, ...args].map(quote).join(" ")}"`;
  return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/v:off", "/c", command], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) {
    return run(process.execPath, [npmCli, ...args], options);
  }
  if (isWindows) {
    return runCmd("npm", args, options);
  }
  return run("npm", args, options);
}

const workDir = await mkdtemp(join(tmpdir(), "coderax package é-"));
const installDir = join(workDir, "install");

console.log(`package: platform ${process.platform}, node ${process.versions.node}`);
console.log("package: building the release artifact");
const artifact = await buildArtifact(root);
const tarballPath = join(workDir, artifact.filename);
await import("node:fs/promises").then(({ writeFile }) => writeFile(tarballPath, artifact.tarball));

check("tarball checksum matches its manifest", sha256(await readFile(tarballPath)) === artifact.sha256);
check(
  "SHA256SUMS line is standard",
  /^[0-9a-f]{64} {2}\S+\.tar\.gz\n$/.test(checksumText(artifact)),
);

console.log("package: installing into a clean prefix");
const install = runNpm(
  ["install", "--prefix", installDir, "--no-audit", "--no-fund", "--ignore-scripts", tarballPath],
  { cwd: workDir, env: { ...process.env, npm_config_cache: join(workDir, "npm-cache") } },
);
check("npm install exits 0", install.status === 0, `${install.stdout ?? ""}${install.stderr ?? ""}`);

const installedPackageDir = join(installDir, "node_modules", artifact.name);
check("package is installed", existsSync(join(installedPackageDir, "package.json")));

if (existsSync(installedPackageDir)) {
  const installed = JSON.parse(await readFile(join(installedPackageDir, "package.json"), "utf8"));
  check("installed version matches the artifact", installed.version === artifact.version);
  check(
    "installed package has no runtime dependencies",
    Object.keys(installed.dependencies ?? {}).length === 0,
    JSON.stringify(installed.dependencies ?? {}),
  );
  // `.bin` and npm's own `.package-lock.json` are metadata, not packages.
  const modules = (await readdir(join(installDir, "node_modules"))).filter((name) => !name.startsWith("."));
  check(
    "clean install adds no other packages",
    modules.length === 1 && modules[0] === artifact.name,
    modules.join(", "),
  );
}

const shim = join(installDir, "node_modules", ".bin", isWindows ? "coderax.cmd" : "coderax");
check("bin shim exists", existsSync(shim), shim);

function runShim(args, options = {}) {
  // POSIX runs the shim itself, proving the shebang and executable bit.
  // Windows .cmd shims need a shell.
  if (!isWindows) return run(shim, args, options);
  return runCmd(shim, args, options);
}

const version = runShim(["--version"]);
check("installed entrypoint runs from its shebang", version.status === 0, version.stderr);
check(
  "installed entrypoint prints the version",
  new RegExp(`^coderax-cli ${artifact.version.replace(/\./g, "\\.")}\\s*$`).test(version.stdout ?? ""),
  JSON.stringify(version.stdout),
);

const help = runShim(["--help"]);
check("installed entrypoint serves --help", help.status === 0 && /coderax config set/.test(help.stdout ?? ""));

const products = runShim(["products", "--json"]);
check("installed entrypoint dispatches a command", products.status === 0, products.stderr);
if (products.status === 0) {
  try {
    const parsed = JSON.parse(products.stdout);
    check("installed command returns machine-readable output", Array.isArray(parsed.products) && parsed.products.length === 5);
  } catch {
    check("installed command returns machine-readable output", false, products.stdout);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    const message = failure.replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
    console.log(`::error title=Package check failed::${message.slice(0, 2000)}`);
  }
  console.error(`package: FAILED with ${failures.length} problem(s)`);
  process.exit(1);
}
console.log(`package: OK - ${artifact.filename} installs cleanly and its entrypoint runs`);
