import test from "node:test";
import assert from "node:assert/strict";
import {
  WORK_TEMPLATES,
  buildTemplateObjective,
  templateNames,
} from "../packages/workflow-sdk/src/v1/templates.js";

test("every template is an engine objective that declares its tool requirement", () => {
  const names = templateNames();
  assert.equal(names.length >= 9, true);
  for (const name of names) {
    const template = WORK_TEMPLATES[name];
    assert.equal(typeof template.label, "string");
    assert.equal(template.requiresTools, true);
    assert.equal(typeof template.summary, "string");
    const objective = buildTemplateObjective(name, "example");
    assert.equal(typeof objective, "string");
    assert.equal(objective.length > 40, true);
    assert.equal(objective.includes("example"), true);
  }
});

test("project and deployment templates never authorize publishing or deployment", () => {
  const project = buildTemplateObjective("project", "a Node service");
  assert.match(project, /cloud workspace/);
  assert.match(project, /Do not create a remote repository, push/);
  assert.match(project, /deploy anything unless the owner explicitly authorizes/);

  const deploy = buildTemplateObjective("deploy", "staging");
  assert.match(deploy, /do not deploy, push or change production/);
  assert.match(deploy, /approval it requires/);
});
