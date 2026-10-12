// Decision hook for tool permissions.
//
// Called before a tool request is shown to the person. Return a PermissionResult
// ({ behavior: 'allow', updatedInput } or { behavior: 'deny', message }) to decide
// it automatically, or null to ask the person in the browser.
//
// It runs first, before the decisions model (decisions/, Laya by default, set up with
// "decisions" in .claude/workbench.json). Return a decision here only for a project
// rule the standards file cannot express; otherwise leave it to the model and the
// standards in .claude/workbench-standards.json.
export async function autoDecide({ featureId, toolName, input }) {
  return null
}
