import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeState } from "./device-tools.js";
import { ensureConnection, errorResult, textResult } from "./shared.js";

export function registerAutomationTools(server: McpServer, state: BridgeState): void {
  server.tool(
    "navigate",
    "Load a URL in the connected webview",
    { url: z.string().describe("The URL to navigate to") },
    async ({ url }) => {
      try {
        const conn = await ensureConnection(state);

        await conn.send("Runtime.evaluate", {
          expression: `window.location.href = ${JSON.stringify(url)}`,
          returnByValue: true,
        });

        // Wait briefly for navigation to start
        await new Promise((r) => setTimeout(r, 500));

        const titleResult = await conn.send("Runtime.evaluate", {
          expression: "document.title",
          returnByValue: true,
        });
        const urlResult = await conn.send("Runtime.evaluate", {
          expression: "window.location.href",
          returnByValue: true,
        });

        return textResult({
          url: urlResult.result?.value ?? urlResult.value,
          title: titleResult.result?.value ?? titleResult.value,
          status: "navigated",
        });
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "execute_javascript",
    "Evaluate a JavaScript expression in the page context",
    {
      expression: z.string().describe("JS code to evaluate"),
      await_promise: z.boolean().optional().default(true).describe("Await the result if it's a Promise"),
    },
    async ({ expression, await_promise }) => {
      try {
        const conn = await ensureConnection(state);
        const result = await conn.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: await_promise,
        });

        if (result.exceptionDetails || result.wasThrown) {
          const errMsg =
            result.exceptionDetails?.text ||
            result.result?.description ||
            "JavaScript evaluation error";
          return errorResult(errMsg);
        }

        return textResult({ result: result.result?.value ?? result.value });
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "patch_css",
    "Inject or replace a <style> element for live CSS tweaking — idempotent per id, so " +
      "re-patching the same id replaces the previous rules (ideal for iterating on a fix). " +
      "Pass an empty css string to remove the patch. Survives until the page reloads.",
    {
      css: z.string().describe("CSS text to inject. Empty string removes the patch."),
      id: z
        .string()
        .optional()
        .default("swib-css-patch")
        .describe("Style element id; re-patching the same id replaces it"),
    },
    async ({ css, id }) => {
      try {
        const conn = await ensureConnection(state);
        const expression = `
          (() => {
            const id = ${JSON.stringify(id)};
            const css = ${JSON.stringify(css)};
            let el = document.getElementById(id);
            if (!css) {
              if (el) el.remove();
              return { id, removed: true };
            }
            if (!el || el.tagName !== 'STYLE') {
              el = document.createElement('style');
              el.id = id;
              document.head.appendChild(el);
            }
            el.textContent = css;
            return { id, applied: true, bytes: css.length };
          })()
        `;

        const result = await conn.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        });

        if (result.exceptionDetails || result.wasThrown) {
          return errorResult(result.exceptionDetails?.text || "patch_css evaluation error");
        }
        return textResult(result.result?.value ?? result.value);
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "click_element",
    "Click a DOM element identified by CSS selector",
    {
      selector: z.string().describe("CSS selector for the target element"),
      index: z.number().optional().default(0).describe("Which match to click if selector matches multiple"),
    },
    async ({ selector, index }) => {
      try {
        const conn = await ensureConnection(state);
        const expression = `
          (() => {
            const els = document.querySelectorAll(${JSON.stringify(selector)});
            if (els.length === 0) return { error: 'No elements found for selector: ${selector.replace(/'/g, "\\'")}' };
            if (${index} >= els.length) return { error: 'Index ${index} out of range, found ' + els.length + ' elements' };
            const el = els[${index}];
            el.click();
            return { clicked: true, selector: ${JSON.stringify(selector)}, tag_name: el.tagName.toLowerCase() };
          })()
        `;

        const result = await conn.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        });

        const value = result.result?.value ?? result.value;
        if (value?.error) {
          return errorResult(value.error);
        }
        return textResult(value);
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "type_text",
    "Type text into the currently focused element or a specified element",
    {
      text: z.string().describe("The text to type"),
      selector: z.string().optional().describe("Focus this element first"),
    },
    async ({ text, selector }) => {
      try {
        const conn = await ensureConnection(state);

        const selectorJson = JSON.stringify(selector || "");
        const textJson = JSON.stringify(text);

        const expression = selector
          ? `(() => {
              const el = document.querySelector(${selectorJson});
              if (!el) return { error: 'No element found for selector: ' + ${selectorJson} };
              el.focus();
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value += ${textJson};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else {
                document.execCommand('insertText', false, ${textJson});
              }
              return { typed: true };
            })()`
          : `(() => {
              const el = document.activeElement;
              if (!el || el === document.body) return { error: 'No focused element; pass a selector' };
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value += ${textJson};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else {
                document.execCommand('insertText', false, ${textJson});
              }
              return { typed: true };
            })()`;

        const result = await conn.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        });

        const value = result.result?.value ?? result.value;
        if (value?.error) {
          return errorResult(value.error);
        }
        return textResult(value);
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "wait_for",
    "Wait for a condition before proceeding",
    {
      selector: z.string().optional().describe("Wait for a CSS selector to appear in the DOM"),
      url_contains: z.string().optional().describe("Wait for the page URL to contain a substring"),
      network_idle: z.number().optional().describe("Wait for no network requests for N milliseconds"),
      timeout_ms: z.number().optional().default(10000).describe("Max wait time in milliseconds"),
    },
    async ({ selector, url_contains, network_idle, timeout_ms }) => {
      try {
        const conn = await ensureConnection(state);
        const startTime = Date.now();

        if (selector) {
          const expression = `
            new Promise((resolve, reject) => {
              if (document.querySelector(${JSON.stringify(selector)})) {
                resolve({ matched: true, elapsed_ms: 0 });
                return;
              }
              const observer = new MutationObserver(() => {
                if (document.querySelector(${JSON.stringify(selector)})) {
                  observer.disconnect();
                  resolve({ matched: true, elapsed_ms: Date.now() - ${startTime} });
                }
              });
              observer.observe(document.documentElement, { childList: true, subtree: true });
              setTimeout(() => {
                observer.disconnect();
                reject(new Error('Timeout waiting for selector: ${selector.replace(/'/g, "\\'")}'));
              }, ${timeout_ms});
            })
          `;

          const result = await conn.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });

          if (result.exceptionDetails || result.wasThrown) {
            return errorResult(`Timeout waiting for selector: ${selector}`);
          }
          return textResult(result.result?.value ?? result.value);
        }

        if (url_contains) {
          while (Date.now() - startTime < timeout_ms) {
            try {
              // Re-acquire each poll: the inspector socket commonly drops *during* the
              // very navigation we're waiting for, so reconnect transparently instead
              // of failing the wait.
              const live = await ensureConnection(state);
              const result = await live.send("Runtime.evaluate", {
                expression: "window.location.href",
                returnByValue: true,
              });
              const currentUrl = (result.result?.value ?? result.value) || "";
              if (currentUrl.includes(url_contains)) {
                return textResult({ matched: true, elapsed_ms: Date.now() - startTime });
              }
            } catch {
              // Connection is mid-navigation; retry on the next tick.
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          return errorResult(`Timeout waiting for URL to contain: ${url_contains}`);
        }

        if (network_idle) {
          let lastCount = conn.networkBuffer.size;
          let idleStart = Date.now();

          while (Date.now() - startTime < timeout_ms) {
            const currentCount = conn.networkBuffer.size;
            if (currentCount !== lastCount) {
              lastCount = currentCount;
              idleStart = Date.now();
            } else if (Date.now() - idleStart >= network_idle) {
              return textResult({ matched: true, elapsed_ms: Date.now() - startTime });
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          return errorResult(`Timeout waiting for network idle (${network_idle}ms)`);
        }

        return errorResult("Must specify one of: selector, url_contains, network_idle");
      } catch (e: any) {
        return errorResult(e.message);
      }
    }
  );
}
