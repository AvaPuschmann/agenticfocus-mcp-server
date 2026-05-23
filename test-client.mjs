// Test client autonome pour POC MCP server (Story 23-7 AC1 validation locale)
// Spawn le server via stdio, liste les outils, invoque les 3 outils, print résultats.
// Run: node test-client.mjs  (avec env vars SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_USER_JWT, USER_ID)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_USER_JWT", "USER_ID"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[test-client] Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("[test-client] Spawning MCP server via stdio…");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_USER_JWT: process.env.SUPABASE_USER_JWT,
    USER_ID: process.env.USER_ID,
  },
});

const client = new Client(
  { name: "agenticfocus-test-client", version: "1.0.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  console.log("[test-client] ✅ Connected to MCP server\n");

  // List tools
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("STEP 1 — list available tools");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const { tools } = await client.listTools();
  console.log(`Found ${tools.length} tools:`);
  tools.forEach((t) => console.log(`  - ${t.name}: ${t.description?.slice(0, 80)}…`));

  // Test 1
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("TEST 1 — list_today_tasks");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const r1 = await client.callTool({ name: "list_today_tasks", arguments: {} });
  console.log(JSON.stringify(r1, null, 2));

  // Test 2
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("TEST 2 — list_projects (kanban_status=doing, no archived)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const r2 = await client.callTool({
    name: "list_projects",
    arguments: { include_archived: false, kanban_status: "doing" },
  });
  console.log(JSON.stringify(r2, null, 2));

  // Test 3 — write op
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("TEST 3 — create_day_task (LE moment AC1 — agent écrit dans la DB)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const r3 = await client.callTool({
    name: "create_day_task",
    arguments: {
      name: "Test démo MCP Sprint 21 closure (auto by test-client.mjs)",
      planned_pomodoros: 1,
    },
  });
  console.log(JSON.stringify(r3, null, 2));

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ All 3 tools tested. Check mobile/desktop Day Planner for the new task!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await client.close();
  process.exit(0);
} catch (err) {
  console.error("\n❌ Test failed:", err.message);
  console.error(err.stack);
  await client.close().catch(() => {});
  process.exit(1);
}
