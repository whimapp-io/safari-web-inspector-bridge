import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeState } from "./device-tools.js";
import { ensureConnection, errorResult, textResult } from "./shared.js";

export function registerObservationTools(server: McpServer, state: BridgeState): void {
  server.tool(
    "get_url",
    "Get the current URL of the connected page",
    {},
    async () => {
      try {
        const conn = await ensureConnection(state);
        const result = await conn.send("Runtime.evaluate", {
          expression: "window.location.href",
          returnByValue: true,
        });
        return textResult({ url: result.result?.value ?? result.value });
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "get_dom",
    "Read the page's DOM as HTML",
    {
      selector: z.string().optional().describe("CSS selector to scope output; defaults to document.documentElement"),
      outer_html: z.boolean().optional().default(true).describe("Return outerHTML (true) vs textContent (false)"),
    },
    async ({ selector, outer_html }) => {
      try {
        const conn = await ensureConnection(state);
        const prop = outer_html ? "outerHTML" : "textContent";

        const expression = selector
          ? `document.querySelector(${JSON.stringify(selector)})?.${prop} || null`
          : `document.documentElement.${prop}`;

        const result = await conn.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        });

        const value = result.result?.value ?? result.value;
        if (value === null || value === undefined) {
          return errorResult(`No element found for selector: ${selector}`);
        }

        return outer_html ? textResult({ html: value }) : textResult({ text: value });
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "get_network_log",
    "Retrieve captured network requests since connection or last clear",
    {
      clear: z.boolean().optional().default(false).describe("Clear the log after reading"),
      filter_url: z.string().optional().describe("Regex to filter by request URL"),
      filter_status: z.string().optional().describe("Filter by HTTP status (e.g., 302, 4xx)"),
    },
    async ({ clear, filter_url, filter_status }) => {
      try {
        const conn = await ensureConnection(state);
        const entries = (filter_url || filter_status)
          ? conn.networkBuffer.getFiltered({ filterUrl: filter_url, filterStatus: filter_status })
          : conn.networkBuffer.getAll();

        if (clear) {
          conn.networkBuffer.clear();
        }

        return textResult(entries);
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "get_console_log",
    "Retrieve JavaScript console messages since connection or last clear",
    {
      clear: z.boolean().optional().default(false).describe("Clear after reading"),
      level: z.enum(["log", "warn", "error", "info"]).optional().describe("Filter by log level"),
    },
    async ({ clear, level }) => {
      try {
        const conn = await ensureConnection(state);
        let entries = conn.consoleLog;

        if (level) {
          entries = entries.filter((e) => e.level === level);
        }

        const result = [...entries];

        if (clear) {
          conn.clearConsoleLog();
        }

        return textResult(result);
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "screenshot",
    "Capture a screenshot of the webview content",
    {},
    async () => {
      try {
        const conn = await ensureConnection(state);

        const dimResult = await conn.send("Runtime.evaluate", {
          expression: "JSON.stringify({ width: window.innerWidth, height: window.innerHeight })",
          returnByValue: true,
        });
        const dims = JSON.parse((dimResult.result?.value ?? dimResult.value) || '{"width":375,"height":812}');

        const result = await conn.send("Page.snapshotRect", {
          x: 0,
          y: 0,
          width: dims.width,
          height: dims.height,
          coordinateSystem: "Viewport",
        });

        return {
          content: [
            {
              type: "image" as const,
              data: result.dataURL?.replace(/^data:image\/\w+;base64,/, "") || result.data || "",
              mimeType: "image/png",
            },
          ],
        };
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "debug_protocol",
    "Dump the raw WebKit Inspector Protocol messages exchanged (for debugging)",
    {
      clear: z.boolean().optional().default(false).describe("Clear the debug log after reading"),
    },
    async ({ clear }) => {
      try {
        const conn = await ensureConnection(state);
        const log = [...conn.debugLog];
        if (clear) {
          conn.debugLog.length = 0;
        }
        return textResult({ message_count: log.length, messages: log });
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );
}
