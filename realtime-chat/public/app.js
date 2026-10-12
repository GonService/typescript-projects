"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let ws = null;
  let me = null;
  let room = null;
  let lastTypingSent = 0;
  let retry = 0;
  const typers = new Map(); // nick -> timeout

  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function scrollDown() {
    const list = $("messages");
    list.scrollTop = list.scrollHeight;
  }

  function addMessage(m) {
    const li = el("li", "msg" + (m.nick === me ? " mine" : ""));
    const meta = el("div", "meta");
    meta.append(el("b", "", m.nick), el("span", "", time(m.at)));
    li.append(meta, el("div", "body", m.text));
    $("messages").append(li);
    scrollDown();
  }

  function addEvent(text, cls = "event") {
    const li = el("li", cls);
    if (cls === "divider") li.append(el("span", "", text));
    else li.textContent = text;
    $("messages").append(li);
    scrollDown();
  }

  function renderMembers(members) {
    const ul = $("members");
    ul.replaceChildren(...members.map((n) => el("li", n === me ? "me" : "", n === me ? `${n} (you)` : n)));
    $("count").textContent = `(${members.length})`;
  }

  function renderTyping() {
    const names = [...typers.keys()];
    $("typing").textContent =
      names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing...` : `${names.slice(0, 2).join(" and ")}${names.length > 2 ? " and others" : ""} are typing...`;
  }

  function setTyping(nick, typing) {
    clearTimeout(typers.get(nick));
    typers.delete(nick);
    if (typing) typers.set(nick, setTimeout(() => setTyping(nick, false), 4000));
    renderTyping();
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function handle(ev) {
    switch (ev.type) {
      case "joined":
        me = ev.nick;
        room = ev.room;
        history.replaceState(null, "", `?room=${encodeURIComponent(room)}`);
        $("login").hidden = true;
        $("chat").hidden = false;
        $("room-name").textContent = room;
        $("messages").replaceChildren();
        typers.clear();
        renderTyping();
        ev.history.forEach(addMessage);
        if (ev.history.length) addEvent("new messages", "divider");
        addEvent(`You joined #${room}`);
        renderMembers(ev.members);
        $("text").focus();
        break;
      case "presence":
        addEvent(`${ev.nick} ${ev.event === "join" ? "joined" : "left"} · ${time(ev.at)}`);
        if (ev.event === "leave") setTyping(ev.nick, false);
        renderMembers(ev.members);
        break;
      case "message":
        setTyping(ev.nick, false);
        addMessage(ev);
        break;
      case "typing":
        setTyping(ev.nick, ev.typing);
        break;
      case "error":
        if (!me) $("login-error").textContent = ev.message;
        else addEvent(ev.message, "event error");
        break;
    }
  }

  function connect(nick, roomName) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      $("status").textContent = "connected";
      $("status").className = "status online";
      send({ type: "join", room: roomName, nick });
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = (e) => {
      $("status").textContent = e.code === 1008 ? "disconnected: too many messages" : "reconnecting...";
      $("status").className = "status";
      if (e.code === 1008 || !me) return;
      const delay = Math.min(10000, 500 * 2 ** retry++);
      setTimeout(() => connect(me, room), delay);
    };
  }

  $("room").value = params.get("room") || "general";

  $("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    $("login-error").textContent = "";
    connect($("nick").value.trim(), $("room").value.trim().toLowerCase());
  });

  $("switch-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const next = $("switch-room").value.trim().toLowerCase();
    if (next && next !== room) send({ type: "join", room: next, nick: me });
    $("switch-room").value = "";
  });

  $("send-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("text").value.trim();
    if (!text) return;
    send({ type: "message", text });
    $("text").value = "";
    lastTypingSent = 0;
  });

  $("text").addEventListener("input", () => {
    const now = Date.now();
    if ($("text").value && now - lastTypingSent > 2500) {
      send({ type: "typing", typing: true });
      lastTypingSent = now;
    } else if (!$("text").value && lastTypingSent) {
      send({ type: "typing", typing: false });
      lastTypingSent = 0;
    }
  });
})();
