import { discoverAgents } from "../src/connectors/discover.js";

const { agents, problems } = await discoverAgents();

for (const agent of agents) {
  const executable = agent.executable ?? "-";
  const args = agent.args.length > 0 ? agent.args.join(" ") : "-";
  console.log(
    [
      agent.id,
      agent.name,
      agent.origin,
      `available=${agent.available}`,
      `enabled=${agent.enabled}`,
      `executable=${executable}`,
      `args=${args}`,
      agent.lastError ? `lastError=${agent.lastError}` : "",
    ]
      .filter(Boolean)
      .join("\t"),
  );
}

for (const problem of problems) {
  console.log(`PROBLEM\t${problem.file}\t${problem.reason}`);
}
