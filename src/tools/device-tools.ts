import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeviceDiscovery } from "../device-discovery.js";
import { WebKitConnection } from "../webkit-connection.js";
import type { ProxyConfig } from "../types.js";
import { ProxyManager } from "../proxy-manager.js";
import { connectToPage, errorResult, textResult } from "./shared.js";

export interface BridgeState {
  discovery: DeviceDiscovery;
  connection: WebKitConnection | null;
  proxyManager: ProxyManager;
  config: ProxyConfig;
  connectedPageId: string | null;
}

export function registerDeviceTools(server: McpServer, state: BridgeState): void {
  server.tool(
    "list_devices",
    "List connected iOS devices with Web Inspector enabled",
    {},
    async () => {
      const devices = await state.discovery.listDevices();
      return textResult(devices.map(({ port, ...d }) => d));
    }
  );

  server.tool(
    "list_inspectable_pages",
    "Enumerate all inspectable WKWebViews across connected devices",
    { device_udid: z.string().optional().describe("Filter to a specific device") },
    async ({ device_udid }) => {
      const pages = await state.discovery.listInspectablePages(device_udid);
      return textResult(
        pages.map(({ websocket_url, ...p }) => p)
      );
    }
  );

  server.tool(
    "connect",
    "Attach to a specific inspectable page for observation and automation",
    { page_id: z.string().describe("Page ID from list_inspectable_pages") },
    async ({ page_id }) => {
      const pages = await state.discovery.listInspectablePages();
      const page = pages.find((p) => p.page_id === page_id);

      if (!page) {
        return errorResult(`Page ${page_id} not found. Use list_inspectable_pages to see available pages.`);
      }

      const { warnings } = await connectToPage(state, page);

      return textResult({
        connected: true,
        ...(warnings.length > 0 ? { warnings } : {}),
        page_id,
        url: page.url,
        title: page.title,
      });
    }
  );
}
