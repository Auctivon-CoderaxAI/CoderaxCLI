import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const tag = process.env.RELEASE_TAG;
const sha = process.env.RELEASE_SHA;
const requiredChecks = ["test", "changed-commits", "dependency audit"];

function fail(message) {
  console.error(`::error::Release authorization refused: ${message}`);
  process.exit(1);
}

if (!api || !repository || !token || !tag || !sha) {
  fail("missing GITHUB_API_URL, GITHUB_REPOSITORY, GH_TOKEN, RELEASE_TAG, or RELEASE_SHA");
}
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) fail(`invalid release tag ${tag}`);
if (!/^[0-9a-f]{40}$/.test(sha)) fail(`invalid release commit ${sha}`);

try {
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { stdio: "ignore" });
} catch {
  fail(`${sha} is not an ancestor of main`);
}

async function get(path) {
  const response = await fetch(`${api}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) fail(`GitHub API ${path} returned ${response.status}`);
  return response.json();
}

const associated = await get(`/repos/${repository}/commits/${sha}/pulls`);
if (!Array.isArray(associated)) fail("unexpected pull-request response");

const approvedPull = associated.find((pull) => {
  const base = pull.base?.ref;
  return pull.merged_at && pull.merge_commit_sha === sha && base === "main";
});
if (!approvedPull) {
  fail(`${sha} is not the merge commit of a pull request into main (direct push or unassociated tag)`);
}

const reviews = await get(`/repos/${repository}/pulls/${approvedPull.number}/reviews?per_page=100`);
if (!Array.isArray(reviews) || reviews.length >= 100) {
  fail(`cannot fully read reviews for pull request #${approvedPull.number}`);
}

const author = approvedPull.user?.login;
const headSha = approvedPull.head?.sha;
if (!author || !/^[0-9a-f]{40}$/.test(headSha || "")) {
  fail(`cannot identify the author or final head of pull request #${approvedPull.number}`);
}

const latest = new Map();
for (const review of reviews) {
  if (review.user?.type !== "User") continue;
  if (!review.user.login || review.user.login === author) continue;
  if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
  latest.set(review.user.login, review);
}
const approvals = [...latest.values()].filter(
  (review) => review.state === "APPROVED" && review.commit_id === headSha,
);
if (approvals.length < 1) {
  fail(`pull request #${approvedPull.number} has no independent human approval at ${headSha}`);
}
if ([...latest.values()].some((review) => review.state === "CHANGES_REQUESTED")) {
  fail(`pull request #${approvedPull.number} has an unresolved changes-requested review`);
}

const checks = await get(
  `/repos/${repository}/commits/${headSha}/check-runs?filter=latest&per_page=100`,
);
if (!Array.isArray(checks.check_runs)) fail("unexpected check-run response");
const acceptedChecks = {};
for (const name of requiredChecks) {
  const candidates = checks.check_runs
    .filter((check) => check.name === name && check.app?.slug === "github-actions")
    .sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
  const check = candidates[0];
  if (!check || check.status !== "completed" || check.conclusion !== "success") {
    fail(`required check ${name} did not succeed at ${headSha}`);
  }
  acceptedChecks[name] = {
    id: check.id,
    conclusion: check.conclusion,
    completed_at: check.completed_at,
  };
}

const record = {
  schema: 1,
  repository,
  tag,
  commit: sha,
  pull_request: approvedPull.number,
  pull_request_url: approvedPull.html_url,
  pull_request_head: headSha,
  independent_approval: approvals.map((review) => review.user.login).sort(),
  required_checks: acceptedChecks,
  authorized_at: new Date().toISOString(),
  limitation:
    "This proves the tag points at an approved pull-request merge with passing exact-head checks. It does not prevent a repository writer from changing the release workflow.",
};
writeFileSync("release-authorization.json", `${JSON.stringify(record, null, 2)}\n`);
console.log(`Authorized ${repository} ${tag} at ${sha} from pull request #${approvedPull.number}.`);
