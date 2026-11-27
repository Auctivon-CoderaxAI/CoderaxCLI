import { startHarness } from "../test/harness/workflow-engine.mjs";
import { evaluateContract, loadContractInputs } from "./lib/contract.mjs";

const root = process.cwd();
const harness = await startHarness();

try {
  const inputs = await loadContractInputs(root);
  const response = await fetch(`${harness.baseUrl}/openapi.json`, {
    headers: { authorization: `Bearer ${harness.ownerToken}` },
  });
  if (!response.ok) {
    console.error(`contract: GET /openapi.json returned HTTP ${response.status}`);
    process.exit(1);
  }
  const document = await response.json();
  const { violations, checked } = evaluateContract({ ...inputs, document });

  console.log(`contract: ${checked.requiredOperations} required operations, API ${checked.apiVersion}`);
  console.log(
    `contract: ${checked.supported} supported capabilities, ${checked.unsupported} explicitly unsupported`,
  );
  for (const capability of inputs.contract.capabilities) {
    console.log(`  ${capability.status === "supported" ? "supported  " : "unsupported"}  ${capability.id}`);
  }

  if (violations.length > 0) {
    for (const violation of violations) console.error(`contract: ${violation.code}: ${violation.message}`);
    console.error(`contract: FAILED with ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log("contract: OK");
} finally {
  await harness.close();
}
