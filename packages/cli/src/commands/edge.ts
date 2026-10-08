import { Command } from "commander";
import { DaemonClient, DaemonResponseError, type DaemonResponse } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface EdgeEnd {
  logicalId: string;
  nodeId: string;
}

type EdgeOpResult =
  | {
    ok: true;
    rigId: string;
    outcome: "would_add" | "added" | "present" | "would_remove" | "removed";
    edge: { id?: string; kind: string; from: EdgeEnd; to: EdgeEnd };
    rollback?: string;
  }
  | { ok: false; code: string; message: string };

const NO_EDGE_ROUTE = "This daemon has no edge route. Upgrade it to a version with `rig edge`, then retry.";

export function edgeCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("edge").description("Add or remove one typed edge between two seats of an existing rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  const run = async (opts: { json?: boolean }, send: (client: DaemonClient) => Promise<DaemonResponse<EdgeOpResult>>) => {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return;
    let result: EdgeOpResult;
    try {
      result = (await send(deps.clientFactory(getDaemonUrl(status)))).data;
    } catch (err) {
      // A daemon from before this route answers its plain 404 page, which isn't JSON.
      if (!(err instanceof DaemonResponseError) || err.status !== 404) throw err;
      result = { ok: false, code: "edge_route_missing", message: NO_EDGE_ROUTE };
    }
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.ok) console.error(`${result.code}: ${result.message}`);
    else {
      const { edge } = result;
      const line = `${edge.kind} ${edge.from.logicalId} -> ${edge.to.logicalId}`;
      const id = edge.id ? `  edge ${edge.id}` : "";
      switch (result.outcome) {
        case "would_add":
          console.log(`plan     add ${line} in rig ${result.rigId}`);
          console.log(`         from node ${edge.from.nodeId}, to node ${edge.to.nodeId}`);
          console.log("         nothing written (--plan)");
          break;
        case "added":
          console.log(`added    ${line}${id}`);
          console.log(`         restore orders seats from the latest snapshot: run \`rig snapshot ${result.rigId}\` to include this edge`);
          console.log(`         rollback: ${result.rollback}`);
          break;
        case "present":
          console.log(`present  ${line}${id} (already there; nothing written)`);
          break;
        case "would_remove":
          console.log(`plan     remove ${line}${id} from rig ${result.rigId}`);
          console.log("         nothing written (--plan)");
          break;
        case "removed":
          console.log(`removed  ${line}${id}`);
          break;
      }
    }
    if (!result.ok) process.exitCode = 1;
  };

  cmd
    .command("add")
    .description("Add one edge; adding an edge that already exists changes nothing")
    .argument("<rig-id>", "Target rig ID")
    .argument("<from>", "Source seat logical ID, such as orch.lead")
    .argument("<to>", "Target seat logical ID, such as dev.qa")
    .requiredOption("--kind <kind>", "delegates_to, spawned_by, can_observe, collaborates_with or escalates_to")
    .option("--plan", "Show what would change and write nothing")
    .option("--json", "JSON output for agents")
    .action((rigId: string, from: string, to: string, opts: { kind: string; plan?: boolean; json?: boolean }) =>
      run(opts, (client) => client.post<EdgeOpResult>(
        `/api/rigs/${encodeURIComponent(rigId)}/edges`,
        { from, to, kind: opts.kind, plan: opts.plan === true },
      )));

  cmd
    .command("remove")
    .description("Remove exactly one edge, by the ID that `rig edge add` returned")
    .argument("<rig-id>", "Target rig ID")
    .argument("<edge-id>", "Edge ID")
    .option("--plan", "Show what would change and write nothing")
    .option("--json", "JSON output for agents")
    .action((rigId: string, edgeId: string, opts: { plan?: boolean; json?: boolean }) =>
      run(opts, (client) => client.delete<EdgeOpResult>(
        `/api/rigs/${encodeURIComponent(rigId)}/edges/${encodeURIComponent(edgeId)}${opts.plan ? "?plan=1" : ""}`,
      )));

  return cmd;
}
