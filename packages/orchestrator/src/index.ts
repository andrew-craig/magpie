// Entrypoint for the magpie orchestrator.
//
// This is currently a placeholder. Later milestones will turn this into a
// webhook server (fastify + @octokit/webhooks) that receives GitHub PR
// events, queues review jobs, runs the reviewer, and publishes results back
// to the pull request. See PLAN.md for the full design.

function main(): void {
  console.log("magpie orchestrator starting");
}

main();
