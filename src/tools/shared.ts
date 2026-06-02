import { WebKitConnection } from "../webkit-connection.js";
import type { BridgeState } from "./device-tools.js";
import type { InspectablePage } from "../types.js";

export function textResult(data: any) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

// Open a fresh WebKit connection to a page and make it the active connection,
// restoring whatever capture the config asks for. Shared by the `connect` tool and
// the auto-reconnect path so they cannot drift.
export async function connectToPage(
  state: BridgeState,
  page: InspectablePage,
): Promise<{ connection: WebKitConnection; warnings: string[] }> {
  if (state.connection) {
    try {
      await state.connection.disconnect();
    } catch {
      // A dead socket may already be closed; ignore.
    }
  }

  const conn = new WebKitConnection();
  await conn.connect(page.websocket_url);
  // Set immediately so the connection is usable even if the capture enables fail.
  state.connection = conn;
  state.connectedPageId = page.page_id;

  const warnings: string[] = [];
  if (state.config.networkCapture) {
    try {
      await conn.enableNetworkCapture();
    } catch (e: any) {
      warnings.push(`Network capture unavailable: ${e.message}`);
    }
  }
  if (state.config.consoleCapture) {
    try {
      await conn.enableConsoleCapture();
    } catch (e: any) {
      warnings.push(`Console capture unavailable: ${e.message}`);
    }
  }

  return { connection: conn, warnings };
}

// Return a live connection, transparently reconnecting if the iOS Web Inspector
// socket has dropped. iOS closes that socket on navigation and after idle periods,
// so without this every tool call after a page navigation failed with "Not
// connected" and required a manual `connect`. We reconnect to the same page_id
// (the WebKit page id is stable across in-page navigations) so callers don't have
// to. Capture buffers (network/console) reset on reconnect — a deliberate tradeoff
// for the connection staying usable.
export async function ensureConnection(state: BridgeState): Promise<WebKitConnection> {
  if (state.connection && state.connection.isConnected) {
    return state.connection;
  }
  if (!state.connectedPageId) {
    throw new Error("Not connected to a page. Use the connect tool first.");
  }

  const pages = await state.discovery.listInspectablePages();
  const page = pages.find((p) => p.page_id === state.connectedPageId);
  if (!page) {
    throw new Error(
      `Connection dropped and page ${state.connectedPageId} is no longer inspectable ` +
        `(the app may have closed or relaunched). Use list_inspectable_pages + connect.`,
    );
  }

  const { connection } = await connectToPage(state, page);
  return connection;
}
