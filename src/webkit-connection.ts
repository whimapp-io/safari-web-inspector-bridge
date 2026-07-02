import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { ConsoleEntry } from "./types.js";
import { NetworkBuffer } from "./network-buffer.js";

type EventHandler = (params: any) => void;

export class WebKitConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private commandId = 0;
  private pendingCommands = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private eventHandlers = new Map<string, EventHandler[]>();

  public networkBuffer = new NetworkBuffer(1000);
  public consoleLog: ConsoleEntry[] = [];
  private maxConsoleEntries = 1000;
  public debugLog: string[] = [];
  private maxDebugEntries = 2000;

  // Every frame in and out lands here; without a cap a long device session
  // grows the array without bound (network/console buffers are already capped).
  private pushDebugLog(entry: string): void {
    if (this.debugLog.length >= this.maxDebugEntries) {
      this.debugLog.shift();
    }
    this.debugLog.push(entry);
  }

  // Target-based multiplexing (iOS 26+)
  private targetId: string | null = null;
  private useTargetMultiplexing = false;

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(url: string): Promise<void> {
    await this.connectWebSocket(url);
    await this.discoverTarget();
    await this.enableCoreDomains();
  }

  private connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => resolve());
      this.ws.on("error", (err) => reject(err));

      this.ws.on("message", (data) => {
        const raw = data.toString();
        this.pushDebugLog(`<< ${raw.slice(0, 500)}`);
        // A malformed frame must not throw here: an uncaught exception in the
        // 'message' handler takes down the whole MCP server process.
        try {
          this.handleMessage(JSON.parse(raw));
        } catch (err: any) {
          this.pushDebugLog(`[message error] ${err.message}`);
        }
      });

      this.ws.on("close", () => {
        this.emit("disconnected");
        for (const [, pending] of this.pendingCommands) {
          pending.reject(new Error("WebSocket connection closed"));
        }
        this.pendingCommands.clear();
      });
    });
  }

  private handleMessage(msg: any): void {
    // Handle target-multiplexed responses
    if (msg.method === "Target.dispatchMessageFromTarget") {
      const innerRaw = msg.params?.message;
      if (innerRaw) {
        const inner = typeof innerRaw === "string" ? JSON.parse(innerRaw) : innerRaw;
        this.pushDebugLog(`<< [target] ${JSON.stringify(inner).slice(0, 500)}`);
        this.handleMessage(inner);
      }
      return;
    }

    // Handle target discovery
    if (msg.method === "Target.targetCreated") {
      const info = msg.params?.targetInfo;
      if (info?.targetId && info?.type === "page") {
        this.targetId = info.targetId;
        this.pushDebugLog(`[target discovered] ${this.targetId}`);
      }
      return;
    }

    // Standard command response
    if (msg.id !== undefined) {
      const pending = this.pendingCommands.get(msg.id);
      if (pending) {
        this.pendingCommands.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Event notification
    if (msg.method) {
      this.dispatchEvent(msg.method, msg.params);
    }
  }

  private async discoverTarget(): Promise<void> {
    // Try direct domain enable first — if it works, no target multiplexing needed
    try {
      await this.sendDirect("Runtime.enable");
      this.useTargetMultiplexing = false;
      this.pushDebugLog("[mode] direct (no target multiplexing)");
      return;
    } catch {
      // Direct failed — try target-based approach (iOS 26+)
    }

    this.pushDebugLog("[mode] attempting target multiplexing");

    // If we already got a targetId from Target.targetCreated events, use it
    if (this.targetId) {
      this.useTargetMultiplexing = true;
      this.pushDebugLog(`[mode] target multiplexing with ${this.targetId}`);
      return;
    }

    // Explicitly ask for targets
    try {
      const result = await this.sendDirect("Target.getTargets");
      const targets = result?.targetInfos || result?.targets || [];
      const pageTarget = targets.find((t: any) => t.type === "page") || targets[0];
      if (pageTarget?.targetId) {
        this.targetId = pageTarget.targetId;
        this.useTargetMultiplexing = true;
        this.pushDebugLog(`[mode] target multiplexing with ${this.targetId} (from getTargets)`);
        return;
      }
    } catch {
      // getTargets not available
    }

    // Wait briefly for Target.targetCreated events
    await new Promise((r) => setTimeout(r, 1000));
    if (this.targetId) {
      this.useTargetMultiplexing = true;
      this.pushDebugLog(`[mode] target multiplexing with ${this.targetId} (from events)`);
      return;
    }

    this.pushDebugLog("[mode] no target found, using direct (may fail on iOS 26+)");
  }

  // Send directly on the WebSocket (no target wrapping)
  private sendDirect(method: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const id = ++this.commandId;
    const msg = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Command ${method} timed out`));
      }, 10000);

      this.pendingCommands.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.pushDebugLog(`>> ${msg}`);
      this.ws!.send(msg);
    });
  }

  // Send a command, routing through target if needed
  async send(method: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    if (this.useTargetMultiplexing && this.targetId) {
      return this.sendToTarget(method, params);
    }

    return this.sendDirect(method, params);
  }

  private sendToTarget(method: string, params: Record<string, any> = {}): Promise<any> {
    // The inner message gets its own ID for response matching
    const innerId = ++this.commandId;
    const innerMessage = JSON.stringify({ id: innerId, method, params });

    // The outer Target.sendMessageToTarget also gets an ID
    const outerId = ++this.commandId;
    const outerMsg = JSON.stringify({
      id: outerId,
      method: "Target.sendMessageToTarget",
      params: {
        targetId: this.targetId,
        message: innerMessage,
      },
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(innerId);
        this.pendingCommands.delete(outerId);
        reject(new Error(`Command ${method} timed out`));
      }, 30000);

      // We care about the inner response (the actual domain command result)
      this.pendingCommands.set(innerId, {
        resolve: (v) => {
          clearTimeout(timeout);
          this.pendingCommands.delete(outerId);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          this.pendingCommands.delete(outerId);
          reject(e);
        },
      });

      // The outer response is just an ack — resolve it silently
      this.pendingCommands.set(outerId, {
        resolve: () => { /* ack, wait for inner */ },
        reject: (e) => {
          clearTimeout(timeout);
          this.pendingCommands.delete(innerId);
          reject(e);
        },
      });

      this.pushDebugLog(`>> [target] ${innerMessage}`);
      this.ws!.send(outerMsg);
    });
  }

  onEvent(method: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  private dispatchEvent(method: string, params: any): void {
    const handlers = this.eventHandlers.get(method) || [];
    for (const handler of handlers) {
      handler(params);
    }
  }

  private async enableCoreDomains(): Promise<void> {
    const domains = ["Runtime", "Page", "DOM"];
    for (const domain of domains) {
      try {
        await this.send(`${domain}.enable`);
      } catch {
        // Domain may not be available in this protocol version
      }
    }
  }

  async enableNetworkCapture(): Promise<void> {
    try {
      await this.send("Network.enable");
    } catch {
      // Domain may not be available — register handlers anyway
    }

    this.onEvent("Network.requestWillBeSent", (params) => {
      this.networkBuffer.add({
        request_id: params.requestId,
        method: params.request?.method || "GET",
        url: params.request?.url || "",
        status: null,
        mime_type: null,
        response_headers: null,
        request_headers: params.request?.headers || null,
        redirected_from: params.redirectResponse ? params.requestId : null,
        redirected_to: null,
        timing: { start: params.timestamp || Date.now(), end: null },
        error: null,
      });
    });

    this.onEvent("Network.responseReceived", (params) => {
      this.networkBuffer.update(params.requestId, {
        status: params.response?.status || null,
        mime_type: params.response?.mimeType || null,
        response_headers: params.response?.headers || null,
        timing: {
          start: 0,
          end: params.timestamp || Date.now(),
        },
      });
    });

    this.onEvent("Network.loadingFailed", (params) => {
      this.networkBuffer.update(params.requestId, {
        error: params.errorText || "Loading failed",
      });
    });
  }

  async enableConsoleCapture(): Promise<void> {
    try {
      await this.send("Console.enable");
    } catch {
      // Domain may not be available — register handlers anyway
    }

    this.onEvent("Console.messageAdded", (params) => {
      const msg = params.message || params;
      if (this.consoleLog.length >= this.maxConsoleEntries) {
        this.consoleLog.shift();
      }
      this.consoleLog.push({
        level: msg.level || "log",
        text: msg.text || "",
        timestamp: msg.timestamp || Date.now(),
        source_url: msg.url || null,
        line_number: msg.line || null,
      });
    });
  }

  clearConsoleLog(): void {
    this.consoleLog = [];
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pendingCommands.clear();
    this.eventHandlers.clear();
    this.targetId = null;
    this.useTargetMultiplexing = false;
  }
}
