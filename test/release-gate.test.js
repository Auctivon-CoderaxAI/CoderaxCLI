import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const gate = fileURLToPath(new URL("../scripts/release-gate.mjs", import.meta.url));
const exec = promisify(execFile);
const repo = "/repos/owner/repo";
const head = "1".repeat(40);

async function authorize(t, alter = () => {}) {
  const cwd = mkdtempSync(join(tmpdir(), "release-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "merge");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  const success = { status: "completed", conclusion: "success" };
  const pull = { number: 8, merged_at: "2026-01-01", merge_commit_sha: sha,
    base: { ref: "main" }, head: { sha: head }, user: { login: "author" } };
  const review = { state: "APPROVED", commit_id: head, user: { type: "User", login: "reviewer" } };
  const checks = ["test", "changed-commits", "dependency audit"].map((name, id) =>
    ({ id, name, ...success, app: { slug: "github-actions" } }));
  const runs = ["ci.yml", "secret-scan.yml"].map((workflow, id) =>
    ({ id: id + 10, run_attempt: 2, path: `.github/workflows/${workflow}`, head_sha: sha,
      head_branch: "main", event: "push", ...success }));
  const jobs = ["dependency audit", "changed-commits"].map((name, id) =>
    ({ id: id + 20, name, head_sha: sha, ...success }));
  const paths = new Map([
    [`${repo}/commits/${sha}/pulls`, [pull]],
    [`${repo}/pulls/8/reviews?per_page=100`, [review]],
    [`${repo}/collaborators/reviewer/permission`, { permission: "write" }],
    [`${repo}/commits/${head}/check-runs?filter=latest&per_page=100`, { check_runs: checks }],
    ...["ci.yml", "secret-scan.yml"].map((workflow, i) => [
      `${repo}/actions/workflows/${workflow}/runs?branch=main&event=push&head_sha=${sha}&per_page=1`,
      { workflow_runs: [runs[i]] },
    ]),
    ...jobs.map((job, i) => [
      `${repo}/actions/runs/${runs[i].id}/attempts/2/jobs?per_page=100`,
      { total_count: 1, jobs: [job] },
    ]),
  ]);
  alter({ review, checks, runs, jobs, paths });
  const server = createServer((request, response) => {
    const body = paths.get(request.url);
    response.writeHead(body === undefined ? 404 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const output = join(cwd, "release-authorization.json");
  try {
    await exec(process.execPath, [gate], { cwd, timeout: 10_000, env: {
      ...process.env, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_REPOSITORY: "owner/repo", GH_TOKEN: "fixture", RELEASE_TAG: "v1.2.3",
      RELEASE_SHA: sha,
    } });
  } catch (error) {
    assert.throws(() => readFileSync(output), { code: "ENOENT" });
    throw error;
  }
  return { sha, record: JSON.parse(readFileSync(output, "utf8")) };
}

test("records successful PR head and main push evidence separately", async (t) => {
  const { sha, record } = await authorize(t);
  assert.equal(record.commit, sha);
  assert.equal(record.pull_request_head, head);
  assert.deepEqual(record.independent_approval, ["reviewer"]);
  assert.deepEqual(Object.keys(record.required_checks), ["test", "changed-commits", "dependency audit"]);
  assert.equal(record.release_commit_checks["dependency audit"].job_id, 20);
  assert.equal(record.release_commit_checks["changed-commits"].run_attempt, 2);
});

for (const [description, alter, message] of [
  ["approval from a stale PR revision", ({ review }) => { review.commit_id = "2".repeat(40); },
    /no independent human approval/],
  ["a missing PR check", ({ checks }) => { checks.pop(); }, /required check dependency audit did not succeed/],
  ["a manual run on that SHA", ({ runs }) => { runs[0].event = "workflow_dispatch"; }, /no completed main push run of ci.yml/],
  ["a secret scan from a different workflow", ({ runs }) => { runs[1].path = ".github/workflows/other.yml"; },
    /no completed main push run of secret-scan.yml/],
  ["a dependency audit on another commit", ({ jobs }) => { jobs[0].head_sha = head; },
    /required main push job dependency audit did not succeed/],
  ["a cancelled secret scan", ({ jobs }) => { jobs[1].conclusion = "cancelled"; },
    /required main push job changed-commits did not succeed/],
]) {
  test(`refuses ${description}`, async (t) => {
    await assert.rejects(authorize(t, alter), { stderr: message });
  });
}
