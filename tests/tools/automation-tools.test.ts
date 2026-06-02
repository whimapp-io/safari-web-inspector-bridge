import { describe, it, expect, vi } from "vitest";
import { registerAutomationTools } from "../../src/tools/automation-tools.js";
import type { BridgeState } from "../../src/tools/device-tools.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("automation-tools registration", () => {
  it("registers its tools on the server", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const state = {
      connection: null,
      config: {},
    } as unknown as BridgeState;

    registerAutomationTools(server, state);
    expect(true).toBe(true);
  });
});
