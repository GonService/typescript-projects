# TypeScript projects

Back-end services and tools in Node.js and TypeScript by [GonService](https://gonserviceit.com.br/software-sob-demanda).
Each folder is an independent project with its own README, tests and Dockerfile; CI type-checks,
tests, builds and runs an end-to-end check for every one of them.

| Project | What it shows | Stack |
| --- | --- | --- |
| [webhook-relay](webhook-relay) | Receives webhooks, verifies HMAC signatures and delivers them with retries, a durable queue, admin API and metrics | Node 22, Fastify, SQLite, Vitest |
| [jwt-auth-api](jwt-auth-api) | Register and login with bcrypt, short-lived access JWTs, rotating refresh tokens with reuse detection, roles, rate limiting, OpenAPI docs | Node 22, Fastify, JWT, SQLite, Swagger UI |
| [url-shortener](url-shortener) | Short links with custom aliases and expiry, click analytics (day, referrer, browser) and a server-rendered stats page with an SVG chart | Node 22, Fastify, SQLite, Vitest |
| [realtime-chat](realtime-chat) | WebSocket chat with rooms, presence, typing indicator, per-room history, flood protection and a minimal web client | Node 22, Fastify, WebSocket, Vitest |
| [site-audit-cli](site-audit-cli) | CLI that checks status, redirects, response time, TLS certificate and security headers of many URLs and writes HTML and JSON reports | Node 22, TypeScript, zero runtime dependencies |

## Em português

Serviços e ferramentas em Node.js e TypeScript: gateway de webhooks, API de autenticação com JWT,
encurtador de links com estatísticas, chat em tempo real e auditoria de sites pela linha de comando.
Precisa integrar sistemas, receber webhooks ou criar uma API?
Fale com a GonService: [gonserviceit.com.br/software-sob-demanda](https://gonserviceit.com.br/software-sob-demanda) ·
[contato@gonserviceit.com.br](mailto:contato@gonserviceit.com.br)

## License

[MIT](LICENSE)
