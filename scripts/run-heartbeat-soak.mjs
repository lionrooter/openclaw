import { loadConfig } from "../src/config/config.ts";
import { runHeartbeatOnce } from "../src/infra/heartbeat-runner.ts";

const agentId = process.argv[2];
const target = process.argv[3] ?? "none";
const cfg = loadConfig();
const base = (cfg.agents?.list ?? []).find((a) => a?.id === agentId)?.heartbeat ?? {};
const heartbeat = { ...base, target };
const result = await runHeartbeatOnce({ cfg, agentId, heartbeat, reason: "manual-soak" });
console.log(JSON.stringify({ result }, null, 2));
