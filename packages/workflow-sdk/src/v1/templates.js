/**
 * Work objectives for common engineering requests.
 *
 * A template is an objective, not an engine and not a local workflow: every one
 * asks the authoritative WorkflowEngine to perform the work in its authorised
 * cloud workspace and to report the evidence an owner needs to review it.
 *
 * `requiresTools` is declared so the terminal can refuse a template explicitly
 * when the selected agent publishes `tools: false` instead of starting a task
 * that cannot succeed.
 */
export const WORK_TEMPLATES = Object.freeze({
  inspect: Object.freeze({
    label: "Repository inspection",
    requiresTools: true,
    summary: "Inspect the cloud workspace and report structure, risks and test entry points.",
    objective: (input) =>
      [
        "Inspect the repository in your cloud workspace. Do not modify files.",
        "Report: the top-level structure, the languages and package managers, the build and test commands,",
        "the CI configuration, and the three highest-risk areas you found. Cite paths you actually read.",
        input ? `Owner focus: ${input}` : "",
      ]
        .filter(Boolean)
        .join(" "),
  }),
  implement: Object.freeze({
    label: "Implement a change",
    requiresTools: true,
    summary: "Make a scoped code change in the cloud workspace and verify it.",
    objective: (input) =>
      [
        "Implement the requested change in the repository in your cloud workspace.",
        "Keep the change minimal and consistent with the existing conventions.",
        "Run the focused tests or typecheck that covers the change.",
        "Do not commit, push, open a pull request or deploy unless the owner explicitly asks.",
        "Finish with: the files changed, the commands you ran and their real results, and any remaining risk.",
        input ? `Request: ${input}` : "Request: (none supplied; ask the owner for the change).",
      ].join(" "),
  }),
  test: Object.freeze({
    label: "Run the test suite",
    requiresTools: true,
    summary: "Execute the repository's tests and report exact results.",
    objective: (input) =>
      [
        "Run the repository's test suite in your cloud workspace using the project's own command.",
        "Report the exact command, the number of passing and failing tests, the first useful failure output,",
        "and whether the failure is caused by the change under review or by the environment.",
        input ? `Scope: ${input}` : "",
      ]
        .filter(Boolean)
        .join(" "),
  }),
  diff: Object.freeze({
    label: "Produce a reviewable diff",
    requiresTools: true,
    summary: "Show the working-tree diff with an explanation.",
    objective: (input) =>
      [
        "Inspect the working tree in your cloud workspace and produce a reviewable summary of the diff.",
        "Include the unified diff for every changed file, or the exact command output if the diff is too large.",
        "Call out generated files, secrets, lockfile churn and unrelated edits.",
        input ? `Focus: ${input}` : "",
      ]
        .filter(Boolean)
        .join(" "),
  }),
  pr: Object.freeze({
    label: "Prepare a pull request",
    requiresTools: true,
    summary: "Prepare a branch, commit message and PR body without publishing.",
    objective: (input) =>
      [
        "Prepare a pull request from the current change in your cloud workspace.",
        "Do not push, open the pull request or publish anything. Produce: a concise branch name,",
        "a commit message, and a PR body with Summary, Testing (exact commands and results),",
        "and Risks sections. List the files the PR would contain.",
        input ? `Context: ${input}` : "",
      ]
        .filter(Boolean)
        .join(" "),
  }),
  review: Object.freeze({
    label: "Remediate review findings",
    requiresTools: true,
    summary: "Address review comments and verify each fix.",
    objective: (input) =>
      [
        "Address the review findings below in the repository in your cloud workspace.",
        "For each finding: state whether it is valid, make the smallest correct fix, and run the focused check.",
        "Do not dismiss a finding without a concrete reason. Do not commit or push.",
        input ? `Findings:\n${input}` : "Findings: (paste the review comments).",
      ].join("\n"),
  }),
  ci: Object.freeze({
    label: "Cloud verification run",
    requiresTools: true,
    summary: "Reproduce the CI checks in the cloud workspace and monitor them.",
    objective: (input) =>
      [
        "Reproduce the repository's continuous-integration checks in your cloud workspace:",
        "install from the lockfile, build, typecheck and test, in the same order CI uses.",
        "Monitor and report each step as it completes, including exact commands, exit codes and durations.",
        "If a check needs a credential or a paid service, report it as blocked instead of faking a pass.",
        input ? `Scope: ${input}` : "",
      ].join(" "),
  }),
});

export function getTemplate(name) {
  return WORK_TEMPLATES[String(name ?? "").toLowerCase()] ?? null;
}

export function templateNames() {
  return Object.keys(WORK_TEMPLATES);
}

export function buildTemplateObjective(name, input) {
  const template = getTemplate(name);
  if (template === null) return null;
  return template.objective(input ?? "");
}
