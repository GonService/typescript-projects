import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Pem } from "./certs.js";

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface Running {
  url: string;
  close: () => Promise<void>;
}

async function listen(server: http.Server, scheme: "http" | "https", host: string, port: number): Promise<Running> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `${scheme}://${host}:${actual}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const startHttp = (handler: Handler, port = 0, host = "127.0.0.1") => listen(http.createServer(handler), "http", host, port);
export const startHttps = (pem: Pem, handler: Handler, port = 0, host = "localhost") =>
  listen(https.createServer({ cert: pem.cert, key: pem.key }, handler), "https", host, port);

export const SECURE_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** Routes by path: each entry returns [status, headers, body]. */
export function routes(table: Record<string, () => [number, Record<string, string>, string?]>): Handler {
  return (req, res) => {
    const route = table[req.url ?? "/"];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const [status, headers, body] = route();
    res.writeHead(status, { "content-type": "text/html", ...headers }).end(body ?? "<h1>ok</h1>");
  };
}
