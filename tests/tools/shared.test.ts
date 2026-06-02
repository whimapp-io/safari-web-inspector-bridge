import { describe, it, expect, afterEach } from "vitest";
import { ensureConnection } from "../../src/tools/shared.js";
import { WebKitConnection } from "../../src/webkit-connection.js";
import type { BridgeState } from "../../src/tools/device-tools.js";
import type { InspectablePage } from "../../src/types.js";
import { MockWebKitServer } from "../helpers/mock-ws-server.js";

function makeState(partial: Partial<BridgeState>): BridgeState {
  return {
    discovery: { listInspectablePages: async () => [] } as any,
    connection: null,
    proxyManager: {} as any,
    config: {} as any,
    connectedPageId: null,
    ...partial,
  } as BridgeState;
}

function page(port: number): InspectablePage {
  return {
    page_id: "1",
    title: "t",
    url: "u",
    app_bundle_id: "",
    device_udid: "d",
    websocket_url: `ws://localhost:${port}/page/1`,
  };
}

describe("ensureConnection", () => {
  let servers: MockWebKitServer[] = [];
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers = [];
  });

  it("returns the existing connection without rediscovering when still connected", async () => {
    const server = new MockWebKitServer();
    servers.push(server);
    const conn = new WebKitConnection();
    await conn.connect(`ws://localhost:${server.port}`);

    let discoveryCalled = false;
    const state = makeState({
      connection: conn,
      connectedPageId: "1",
      discovery: {
        listInspectablePages: async () => {
          discoveryCalled = true;
          return [];
        },
      } as any,
    });

    const got = await ensureConnection(state);
    expect(got).toBe(conn);
    expect(discoveryCalled).toBe(false);
    await conn.disconnect();
  });

  it("throws when never connected", async () => {
    const state = makeState({ connection: null, connectedPageId: null });
    await expect(ensureConnection(state)).rejects.toThrow(/Use the connect tool/);
  });

  it("reconnects to the last page when the socket has dropped", async () => {
    const server = new MockWebKitServer();
    servers.push(server);
    const state = makeState({
      connection: null,
      connectedPageId: "1",
      discovery: { listInspectablePages: async () => [page(server.port)] } as any,
    });

    const got = await ensureConnection(state);
    expect(got.isConnected).toBe(true);
    expect(state.connection).toBe(got);
    await got.disconnect();
  });

  it("throws a helpful error when the last page is no longer inspectable", async () => {
    const state = makeState({
      connection: null,
      connectedPageId: "9",
      discovery: { listInspectablePages: async () => [] } as any,
    });
    await expect(ensureConnection(state)).rejects.toThrow(/no longer inspectable/);
  });
});
