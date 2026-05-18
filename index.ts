
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { glob } from "glob";

import * as os from "node:os";
import * as fs from "node:fs/promises";

export default function (pi: ExtensionAPI) {
  async function callRpc(server: string, method: string, params: any[] = [], timeoutMs = 15000, ctx?: any) {
    const correlationId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const replyEvent = `msgpack:rpc:response:${correlationId}`;

    ctx.ui.notify(`[pi-neovim callrpc] in rpc call ...`, "info");

    return new Promise((resolve, reject) => {
      const handler = (response: any) => {
        ctx.ui.notify(`[pi-neovim callrpc] in handler ... ${response.success} ${response.result}`, "info");
        response.success ? resolve(response.result) : reject(new Error(response.error));
      };

      pi.events.on(replyEvent, handler);

      pi.events.emit("msgpack:rpc:call", {
        server, method, params, timeoutMs,
        correlationId, replyEvent
      });
    });
  }

  pi.registerTool({
    name: "discover_neovim",
    label: "Discover Neovim",
    description: "Find runnning Neovim instances",
    promptGuidelines: [
      "If you find multiple instances of Neovim, use pi-ask-user if available to let the user chose one.",
      "",
      "Strict Neovim API Verification Policy:",
      "For any Neovim API call, the first time a specific function is used in a session, you MUST perform a \"Verification Loop\" before executing:",
      "1. Fetch: Use a web fetch tool to get the latest api.txt from https://raw.githubusercontent.com/neovim/neovim/refs/heads/master/runtime/doc/api.txt.",
      "2. Cross-Check: Explicitly look up the function signature and the Indexing section to confirm if it is 0-based or 1-based for lines and columns.",
      "3. Confirm: Only after this verification should you construct and execute the msgpack_rpc_call.",
      "4. Report: ALWAYS report resulting indexes to the user as 1-based (converting from 0-based if necessary).",
      "",
      "Do not rely on internal memory for indexing or parameter types on the first call of a session.",
    ],
    parameters: Type.Object({}),
    async execute(_, __, ___, ____, ctx) {
      ctx.ui.notify("[pi-neovim] Scanning for instances...", "info");

      const files = await glob([
        "/tmp/*nvim*",
        process.env.NVIM_LISTEN_ADDRESS || '',
        `${os.tmpdir()}/nvim.${os.userInfo().username}/*/nvim.*`,
        `/run/user/${process.getuid?.() || 1000}/*nvim*`,
        `${os.homedir()}/.cache/nvim/*`
      ])

      const candidates = new Set<string>(); for (const file of files) {
        const f = await fs.stat(file); if (f.isSocket()) candidates.add(file);
      }

      const verified = [];
      for (const socket of candidates) {
        try {
          ctx.ui.notify(`[pi-neovim] verifying ... ${socket}`, "info");

          const info: any = { socket };

          info.file    = await callRpc(socket, "nvim_buf_get_name", [0], 1000, ctx).catch(() => "(no file)");
          info.cwd     = await callRpc(socket, "nvim_call_function", ["getcwd", []], 1000, ctx).catch(() => "?");
          info.version = await callRpc(socket, "nvim_eval", ["matchstr(execute('version'), 'NVIM v\\zs\\d[^ \\n]*')"], 20000, ctx);

          verified.push(info);
        } catch (error) {
          ctx.ui.notify(`[pi-neovim] an error occurred: ${error.message} ${error}`, "error");
        }
      }

      if (verified.length === 0) return { content: [{ type: "text", text: "No running Neovim instances found." }] };

      const formattedList = verified.map((s, i) => 
        `${i+1}. file: ${s.file}\n   cwd: ${s.cwd}\n   server: ${s.socket}\n   version: ${s.version }`
      ).join("\n\n");

      return {
        content: [{ type: "text", text: `Found ${verified.length} Neovim instance(s):\n\n${formattedList}` }],
        details: { servers: verified }
      };
    },
  });
}
