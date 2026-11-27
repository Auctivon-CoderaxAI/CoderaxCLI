import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.js";

// Runs the real `coderax chat` command inside a PTY (test/terminal-chat-pty.test.js)
// against a local SSE deployment. READY is written once the interactive prompt
// appears, so the harness only types after raw mode is active.

const realWrite = process.stdout.write.bind(process.stdout);
let announced = false;

const announce = () => {
  if (announced) return;
  announced = true;
  realWrite("READY\r\n");
};

function serve() {
  const server = createServer(async (req, res) => {
    if (!(req.url ?? "").startsWith("/api/work/chat")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;
    const text = JSON.parse(raw === "" ? "{}" : raw).text ?? "";
    realWrite("TURN STARTED\r\n");
    const answer = `echo ${JSON.stringify(text)}`;

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    // The delay is what makes the wait indicator paint before the first byte.
    await new Promise((resolve) => setTimeout(resolve, 300));
    res.write(`data: ${JSON.stringify({ type: "text", text: answer, index: 0 })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        final: true,
        responseMessage: { text: answer, messageId: "m1", conversationId: "c1" },
      })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  return server;
}

const server = serve();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();

const directory = await mkdtemp(join(tmpdir(), "coderax-pty-chat-"));
const env = {
  ...process.env,
  CODERAX_CONFIG: join(directory, "config.json"),
  CODERAX_BASE_URL: `http://127.0.0.1:${port}`,
  CODERAX_TOKEN: "pty-chat-token",
};

process.stdout.write = (chunk, ...rest) => {
  const written = realWrite(chunk, ...rest);
  if (String(chunk).includes("coderax> ")) announce();
  return written;
};

const code = await runCli(["chat"], { env });
process.exit(code);
