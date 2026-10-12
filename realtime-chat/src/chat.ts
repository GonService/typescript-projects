import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { TokenBucket } from "./rate.js";

/** Transport-independent view of a connection, so the hub can be tested without sockets. */
export interface Connection {
  send(data: string): void;
  close(code: number, reason: string): void;
}

export interface ChatMessage {
  id: string;
  room: string;
  nick: string;
  text: string;
  at: string;
}

export type ServerEvent =
  | { type: "joined"; room: string; nick: string; members: string[]; history: ChatMessage[] }
  | { type: "presence"; event: "join" | "leave"; room: string; nick: string; members: string[]; at: string }
  | ({ type: "message" } & ChatMessage)
  | { type: "typing"; room: string; nick: string; typing: boolean }
  | { type: "error"; code: string; message: string };

const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NICK_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,23}$/u;

interface Client {
  id: string;
  conn: Connection;
  bucket: TokenBucket;
  /** Typing notifications have their own budget and are dropped silently when it runs out. */
  typingBucket: TokenBucket;
  violations: number;
  room?: string;
  nick?: string;
}

interface Room {
  clients: Set<Client>;
  history: ChatMessage[];
}

export class ChatHub {
  private clients = new Map<Connection, Client>();
  private rooms = new Map<string, Room>();

  constructor(
    private readonly config: Pick<Config, "historySize" | "burst" | "refillPerSecond" | "maxViolations" | "maxMessageLength">,
    private readonly now: () => number = Date.now,
  ) {}

  connect(conn: Connection): void {
    this.clients.set(conn, {
      id: randomUUID(),
      conn,
      bucket: new TokenBucket(this.config.burst, this.config.refillPerSecond, this.now),
      typingBucket: new TokenBucket(3, 1, this.now),
      violations: 0,
    });
  }

  disconnect(conn: Connection): void {
    const client = this.clients.get(conn);
    if (!client) return;
    this.leave(client);
    this.clients.delete(conn);
  }

  /** Handles one raw frame from a client. */
  receive(conn: Connection, raw: string): void {
    const client = this.clients.get(conn);
    if (!client) return;

    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      msg = undefined;
    }
    const m = typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : undefined;

    if (m?.type === "typing") {
      if (client.typingBucket.take()) this.typing(client, m.typing === true);
      return;
    }

    if (!client.bucket.take()) {
      client.violations += 1;
      if (client.violations >= this.config.maxViolations) {
        conn.close(1008, "flooding");
        return;
      }
      return this.error(client, "rate_limited", "Slow down: too many messages");
    }

    if (!m) return this.error(client, "bad_request", "Frames must be JSON objects");

    switch (m.type) {
      case "join":
        return this.join(client, m.room, m.nick);
      case "message":
        return this.message(client, m.text);
      case "leave":
        return this.leave(client);
      default:
        return this.error(client, "bad_request", "Unknown message type");
    }
  }

  listRooms(): { room: string; members: number }[] {
    return [...this.rooms.entries()]
      .map(([room, r]) => ({ room, members: r.clients.size }))
      .filter((r) => r.members > 0)
      .sort((a, b) => b.members - a.members || a.room.localeCompare(b.room));
  }

  private join(client: Client, rawRoom: unknown, rawNick: unknown): void {
    const room = typeof rawRoom === "string" ? rawRoom.trim().toLowerCase() : "";
    const nick = typeof rawNick === "string" ? rawNick.trim() : "";
    if (!ROOM_RE.test(room)) return this.error(client, "invalid_room", "Room: 1-32 characters, a-z, 0-9 and '-'");
    if (!NICK_RE.test(nick)) return this.error(client, "invalid_nick", "Nickname: 2-24 letters, digits, spaces, '.', '_' or '-'");

    const target = this.rooms.get(room) ?? { clients: new Set<Client>(), history: [] };
    const taken = [...target.clients].some((c) => c !== client && c.nick?.toLowerCase() === nick.toLowerCase());
    if (taken) return this.error(client, "nick_taken", `"${nick}" is already in #${room}`);

    this.leave(client);
    this.rooms.set(room, target);
    client.room = room;
    client.nick = nick;
    target.clients.add(client);

    const members = this.members(target);
    this.send(client, { type: "joined", room, nick, members, history: target.history });
    this.broadcast(target, { type: "presence", event: "join", room, nick, members, at: this.iso() }, client);
  }

  private leave(client: Client): void {
    if (!client.room || !client.nick) return;
    const room = this.rooms.get(client.room);
    const { nick } = client;
    const name = client.room;
    client.room = undefined;
    client.nick = undefined;
    if (!room) return;
    room.clients.delete(client);
    this.broadcast(room, { type: "presence", event: "leave", room: name, nick, members: this.members(room), at: this.iso() });
    // Empty rooms are kept while they have history, so the conversation is there when someone comes back.
    if (room.clients.size === 0 && room.history.length === 0) this.rooms.delete(name);
  }

  private message(client: Client, rawText: unknown): void {
    if (!client.room || !client.nick) return this.error(client, "not_joined", "Join a room first");
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) return this.error(client, "empty_message", "Message is empty");
    if (text.length > this.config.maxMessageLength) {
      return this.error(client, "message_too_long", `Messages are limited to ${this.config.maxMessageLength} characters`);
    }
    const room = this.rooms.get(client.room)!;
    const msg: ChatMessage = { id: randomUUID(), room: client.room, nick: client.nick, text, at: this.iso() };
    room.history.push(msg);
    if (room.history.length > this.config.historySize) room.history.splice(0, room.history.length - this.config.historySize);
    this.broadcast(room, { type: "message", ...msg });
  }

  private typing(client: Client, typing: boolean): void {
    if (!client.room || !client.nick) return;
    const room = this.rooms.get(client.room)!;
    this.broadcast(room, { type: "typing", room: client.room, nick: client.nick, typing }, client);
  }

  private members(room: Room): string[] {
    return [...room.clients].map((c) => c.nick!).sort((a, b) => a.localeCompare(b));
  }

  private broadcast(room: Room, event: ServerEvent, except?: Client): void {
    const data = JSON.stringify(event);
    for (const c of room.clients) if (c !== except) c.conn.send(data);
  }

  private send(client: Client, event: ServerEvent): void {
    client.conn.send(JSON.stringify(event));
  }

  private error(client: Client, code: string, message: string): void {
    this.send(client, { type: "error", code, message });
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
