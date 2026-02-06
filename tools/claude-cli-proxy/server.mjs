#!/usr/bin/env node

/**
 * Claude CLI Proxy - STREAMING version for Pi-AI SDK compatibility
 *
 * This proxy returns Server-Sent Events (SSE) streaming format
 * that the Pi-AI SDK expects for openai-completions API.
 */

import { spawn } from "child_process";
import http from "http";

const PORT = 11435;
const CLAUDE_CLI_PATH = "/Users/lionroot/.local/bin/claude";

const MODEL_MAP = {
  sonnet: "sonnet",
  opus: "opus",
  haiku: "haiku",
  "claude-sonnet-4-5": "sonnet",
  "claude-opus-4-6": "opus",
  "claude-haiku-4-5": "haiku",
};

function convertMessagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const formattedMessages = messages.map((msg) => {
    const role = msg.role === "assistant" ? "Assistant" : "User";
    let content = msg.content;

    if (Array.isArray(content)) {
      content = content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }

    return `${role}: ${content}`;
  });

  return formattedMessages.join("\n\n");
}

async function callClaudeCLI(prompt, model = "sonnet") {
  return new Promise((resolve, reject) => {
    const claudeModel = MODEL_MAP[model] || "sonnet";

    console.log(`[${new Date().toISOString()}] Calling Claude CLI with model: ${claudeModel}`);
    console.log(`[${new Date().toISOString()}] Prompt length: ${prompt.length} chars`);

    const args = ["--print", "--model", claudeModel, "--dangerously-skip-permissions", prompt];

    const claude = spawn(CLAUDE_CLI_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: process.env.HOME,
      },
    });

    let stdout = "";
    let stderr = "";

    claude.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    claude.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    claude.on("close", (code) => {
      if (code !== 0) {
        console.error(`[${new Date().toISOString()}] Claude CLI error (exit ${code}):`, stderr);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        return;
      }

      const response = stdout.trim();
      console.log(`[${new Date().toISOString()}] Response received, ${response.length} chars`);
      resolve(response);
    });

    claude.on("error", (err) => {
      console.error(`[${new Date().toISOString()}] Failed to spawn Claude CLI:`, err);
      reject(err);
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Models list endpoint
  if (req.url === "/v1/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "sonnet", object: "model", created: Date.now(), owned_by: "anthropic" },
          { id: "opus", object: "model", created: Date.now(), owned_by: "anthropic" },
          { id: "haiku", object: "model", created: Date.now(), owned_by: "anthropic" },
        ],
      }),
    );
    return;
  }

  // Chat completions endpoint - STREAMING
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const messages = data.messages || [];
        const model = data.model || "sonnet";

        const prompt = convertMessagesToPrompt(messages);
        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "No messages provided", type: "invalid_request" },
            }),
          );
          return;
        }

        // Get the full response from Claude CLI
        const responseText = await callClaudeCLI(prompt, model);

        // Return as Server-Sent Events (SSE) stream
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // Send initial chunk with content
        const initialChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: responseText, // Send all content at once
              },
              finish_reason: null,
            },
          ],
        };

        res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

        // Send final chunk with finish_reason
        const finalChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: Math.ceil(prompt.length / 4),
            completion_tokens: Math.ceil(responseText.length / 4),
            total_tokens: Math.ceil((prompt.length + responseText.length) / 4),
          },
        };

        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Proxy error:`, error);

        // Send error in streaming format
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const errorChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          error: {
            message: error.message,
            type: "proxy_error",
          },
        };

        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🦞 Claude CLI Streaming Proxy running on http://127.0.0.1:${PORT}`);
  console.log(`Using Claude CLI: ${CLAUDE_CLI_PATH}`);
  console.log(`Models available: sonnet, opus, haiku`);
  console.log(`\n✨ Streaming format - compatible with Pi-AI SDK!`);
  console.log(`Ready!\n`);
});
