<template>
  <div class="chat-container">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <h2>Chats</h2>
        <button @click="loadChats">Refresh</button>
      </div>

      <ul>
        <li
          v-for="chat in chats"
          :key="chat.id"
          :class="{ active: selectedChat && selectedChat.id === chat.id }"
          @click="selectChat(chat)"
        >
          <div class="chat-row">
            <div class="chat-name">{{ chat.name }}</div>
            <div class="last-msg">{{ chat.lastMessage }}</div>
          </div>
        </li>
      </ul>
    </aside>

    <!-- Chat Area -->
    <section class="chat-area">
      <header class="chat-header" v-if="selectedChat">
        <h3>{{ selectedChat.name }}</h3>
        <small>Connected: {{ wsConnected ? "yes" : "no" }}</small>
      </header>

      <div class="messages" ref="messagesContainer">
        <div
          v-for="(msg, idx) in messages"
          :key="msg.id ?? idx"
          :class="['message', msg.from === currentUser ? 'me' : 'other']"
        >
          <div class="meta">
            <strong>{{ msg.from }}</strong>
            <small>{{ formatTime(msg.sentAt) }}</small>
          </div>
          <div class="text">{{ msg.text }}</div>
        </div>
      </div>

      <footer class="chat-input" v-if="selectedChat">
        <input
          type="text"
          v-model="newMessage"
          placeholder="Type a message..."
          @keyup.enter="onSend"
        />
        <button @click="onSend">Send</button>
      </footer>

      <div v-else class="empty-state">
        <p>Select a chat to start messaging.</p>
      </div>
    </section>
  </div>
</template>

<script setup>
/**
 * Full, copy-pastable Vue 3 single-file component (script setup).
 *
 * Notes:
 * - Adjust API_BASE and WS_URL to match your backend host/ports.
 * - currentUser: replace with your auth-derived user id/username (e.g., from JWT or Vuex).
 * - This file expects:
 *    GET  {API_BASE}/messages/conversations                -> list conversations
 *    GET  {API_BASE}/messages/conversations/{conversationId} -> messages list
 *    POST {API_BASE}/messages/conversations                -> create conversation (not used here)
 *
 * - WebSocket / STOMP:
 *    Register:   /app/chat.register  (payload: { senderId })
 *    Send:       /app/chat.send      (payload: { conversationId, senderId, content })
 *    Server broadcast topic: /topic/conversation.{conversationId}
 *    Optional server-to-user status: /user/queue/message.status
 */

import { ref, reactive, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import axios from "axios";
import * as StompJs from "@stomp/stompjs";
import SockJS from "sockjs-client";

/* --------- Config (change to your backend URLs) ---------- */
const API_BASE = "http://localhost:8485/api"; // <-- change to your API base
const WS_URL = "http://localhost:8485/ws"; // <-- full SockJS endpoint (must match Spring mapping)
const currentUser = localStorage.getItem("username") || "me"; // replace with auth-derived id/username
/* -------------------------------------------------------- */

/* state */
const chats = ref([]); // { id, name, lastMessage }
const selectedChat = ref(null); // { id, name, ... }
const messages = ref([]); // { id, from, text, sentAt }
const newMessage = ref("");
const wsConnected = ref(false);

const stompClient = ref(null);
const subscriptions = reactive({}); // map conversationId -> subscription (Stomp subscription)
const userQueueSub = ref(null);

const messagesContainer = ref(null);

/* helper: autoscroll to bottom */
const scrollToBottom = async () => {
  await nextTick();
  const el = messagesContainer.value;
  if (el) el.scrollTop = el.scrollHeight;
};

/* Format timestamp (basic) */
const formatTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString();
};

/* ----- REST calls ----- */
const loadChats = async () => {
  try {
    // GET /api/messages/conversations
    const res = await axios.get(`${API_BASE}/messages/conversations`);
    // normalize to {id, name, lastMessage}
    chats.value = (res.data || []).map((c) => ({
      id: c.id,
      name: c.name || c.title || `Conversation ${c.id}`,
      lastMessage: c.lastMessage || (c.last_message ? c.last_message : ""),
      raw: c,
    }));
    if (!selectedChat.value && chats.value.length) {
      selectChat(chats.value[0]);
    }
  } catch (err) {
    console.error("Failed to load chats", err);
  }
};

const loadMessages = async (conversationId) => {
  try {
    // GET /api/messages/conversations/{conversationId}
    const res = await axios.get(`${API_BASE}/messages/conversations/${conversationId}`);
    // normalize incoming message objects to UI shape: { id, from, text, sentAt }
    messages.value = (res.data || []).map((m) => normalizeIncomingMessage(m));
    await scrollToBottom();
  } catch (err) {
    console.error("Failed to load messages", err);
    messages.value = [];
  }
};

/* normalize different backend message shapes to UI */
const normalizeIncomingMessage = (m) => {
  return {
    id: m.messageId ?? m.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    from: m.senderId ?? m.from ?? m.user ?? "unknown",
    text: m.content ?? m.text ?? m.body ?? "",
    sentAt: m.sentAt ?? m.createdAt ?? m.timestamp ?? new Date().toISOString(),
    raw: m,
  };
};

/* ----- WebSocket / STOMP ----- */
const connectWebsocket = () => {
  if (stompClient.value && stompClient.value.connected) return;

  // Create STOMP client over SockJS
  const client = new StompJs.Client({
    // give STOMP a factory that returns a SockJS instance
    webSocketFactory: () => new SockJS(WS_URL),
    reconnectDelay: 5000,
    heartbeatIncoming: 10000,
    heartbeatOutgoing: 10000,
    onConnect: (frame) => {
      console.log("STOMP connected", frame);
      wsConnected.value = true;

      // Register user on server so server can target messages to /user/{username}
      try {
        client.publish({
          destination: "/app/chat.register",
          body: JSON.stringify({ senderId: currentUser }),
        });
      } catch (err) {
        console.warn("Failed to publish register", err);
      }

      // subscribe to server-to-user queue for message status updates (optional)
      try {
        // server sends to user using convertAndSendToUser(..., "/queue/message.status", ...)
        userQueueSub.value = client.subscribe("/user/queue/message.status", (frame) => {
          if (!frame.body) return;
          try {
            const statusMsg = JSON.parse(frame.body);
            // you can handle delivery status here (e.g., mark message by messageId as SENT/DELIVERED)
            console.log("message.status", statusMsg);
          } catch (e) {
            console.log("message.status (non-json)", frame.body);
          }
        });
      } catch (err) {
        console.warn("Failed to subscribe to user queue", err);
      }

      // if a chat is selected, subscribe
      if (selectedChat.value) {
        subscribeToChat(selectedChat.value.id);
      }
    },
    onStompError: (frame) => {
      console.error("STOMP error: ", frame);
    },
    onDisconnect: () => {
      wsConnected.value = false;
    },
    onWebSocketClose: () => {
      wsConnected.value = false;
    },
  });

  client.activate();
  stompClient.value = client;
};

const disconnectWebsocket = () => {
  if (stompClient.value) {
    try {
      // unsubscribe user queue
      if (userQueueSub.value) {
        userQueueSub.value.unsubscribe();
        userQueueSub.value = null;
      }
      Object.keys(subscriptions).forEach((id) => {
        if (subscriptions[id]) {
          subscriptions[id].unsubscribe();
        }
      });
    } catch (err) {
      // ignore
    }

    stompClient.value.deactivate();
    stompClient.value = null;
    wsConnected.value = false;
  }
};

const subscribeToChat = (conversationId) => {
  if (!stompClient.value || !stompClient.value.connected) {
    console.warn("STOMP not connected yet; connect first");
    return;
  }
  // unsubscribe previous subscription for this conversation if exists
  if (subscriptions[conversationId]) {
    try {
      subscriptions[conversationId].unsubscribe();
    } catch (err) {
      // ignore
    }
    delete subscriptions[conversationId];
  }

  // Server broadcasts to /topic/conversation.{conversationId}
  const topic = `/topic/conversation.${conversationId}`;
  const sub = stompClient.value.subscribe(topic, (message) => {
    if (!message.body) return;
    let msgObj;
    try {
      const parsed = JSON.parse(message.body);
      msgObj = normalizeIncomingMessage(parsed);
    } catch (e) {
      // fallback simple parse
      msgObj = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        from: "unknown",
        text: message.body,
        sentAt: new Date().toISOString(),
      };
    }

    // push incoming message if for current chat
    if (selectedChat.value && selectedChat.value.id === conversationId) {
      messages.value.push({
        id: msgObj.id,
        from: msgObj.from,
        text: msgObj.text,
        sentAt: msgObj.sentAt,
        raw: msgObj.raw,
      });
      scrollToBottom();
    }

    // optionally update chat preview in chat list
    const c = chats.value.find((x) => x.id === conversationId);
    if (c) c.lastMessage = msgObj.text;
  });

  subscriptions[conversationId] = sub;
};

const unsubscribeFromChat = (conversationId) => {
  if (subscriptions[conversationId]) {
    try {
      subscriptions[conversationId].unsubscribe();
    } catch (err) {
      // ignore
    }
    delete subscriptions[conversationId];
  }
};

/* ----- user actions ----- */
const selectChat = async (chat) => {
  if (!chat) return;
  // unsubscribe from old chat(s)
  if (selectedChat.value && selectedChat.value.id !== chat.id) {
    unsubscribeFromChat(selectedChat.value.id);
  }

  selectedChat.value = chat;
  await loadMessages(chat.id);

  // ensure websocket connected
  if (!stompClient.value || !stompClient.value.connected) {
    connectWebsocket();
    // subscription will be made in onConnect; if already connected, subscribe now:
    // small delay to wait for onConnect to trigger registration & then subscribe
    const waitForConnect = () =>
      new Promise((resolve) => {
        const check = () => {
          if (stompClient.value && stompClient.value.connected) return resolve();
          setTimeout(check, 100);
        };
        check();
      });
    waitForConnect().then(() => subscribeToChat(chat.id));
  } else {
    subscribeToChat(chat.id);
  }
};

/* Send message: publish to STOMP destination; also fallback to REST POST */
const onSend = async () => {
  const txt = newMessage.value && newMessage.value.trim();
  if (!txt || !selectedChat.value) return;

  // message payload expected by backend ChatController.sendMessage(SendMessageRequest)
  const payload = {
    conversationId: selectedChat.value.id,
    senderId: currentUser, // must match server expectations (your auth user id)
    content: txt,
  };

  // optimistic UI entry (use temporary id)
  const optimistic = {
    id: `temp-${Date.now()}`,
    from: currentUser,
    text: txt,
    sentAt: new Date().toISOString(),
    optimistic: true,
  };

  try {
    if (stompClient.value && stompClient.value.connected) {
      // server expects destination /app/chat.send
      stompClient.value.publish({
        destination: "/app/chat.send",
        body: JSON.stringify(payload),
      });

      // add optimistic message to UI
      messages.value.push(optimistic);
      newMessage.value = "";
      await scrollToBottom();
      return;
    }
  } catch (err) {
    console.warn("STOMP send failed, will fallback to REST POST", err);
  }

  // fallback: POST to REST endpoint (server should broadcast too)
  try {
    await axios.post(
      `${API_BASE}/messages/conversations/${selectedChat.value.id}/messages` /* optional route on server */,
      payload
    );
    newMessage.value = "";
    // server should broadcast; optionally you can append optimistic message until server confirms
  } catch (err) {
    console.error("Failed to send message via REST", err);
  }
};

/* lifecycle */
onMounted(() => {
  loadChats();
  connectWebsocket();
});

onBeforeUnmount(() => {
  // unsubscribe all
  Object.keys(subscriptions).forEach((id) => unsubscribeFromChat(id));
  disconnectWebsocket();
});

watch(selectedChat, () => {
  // placeholder for extra logic on conversation change
});
</script>

<style scoped>
.chat-container {
  display: flex;
  height: 100vh;
  font-family: Inter, Arial, sans-serif;
}

/* Sidebar */
.sidebar {
  width: 300px;
  background: #1f2937;
  color: white;
  padding: 12px;
  box-sizing: border-box;
}
.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.sidebar ul {
  list-style: none;
  padding: 0;
  margin-top: 12px;
  overflow-y: auto;
  max-height: calc(100vh - 80px);
}
.sidebar li {
  padding: 10px;
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  background: #111827;
}
.sidebar li.active {
  background: #374151;
}
.chat-name {
  font-weight: 600;
}
.last-msg {
  font-size: 12px;
  color: #9ca3af;
}

/* Chat area */
.chat-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #f3f4f6;
}
.chat-header {
  padding: 12px 16px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.messages {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.message {
  max-width: 70%;
  padding: 10px;
  border-radius: 10px;
}
.message.me {
  margin-left: auto;
  background: #0ea5e9;
  color: white;
}
.message.other {
  margin-right: auto;
  background: #e5e7eb;
}
.chat-input {
  display: flex;
  padding: 12px;
  background: #fff;
  border-top: 1px solid #e5e7eb;
}
.chat-input input {
  flex: 1;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid #d1d5db;
}
.chat-input button {
  margin-left: 8px;
  padding: 8px 14px;
  border-radius: 8px;
  background: #0ea5e9;
  color: white;
  border: none;
  cursor: pointer;
}
.empty-state {
  padding: 32px;
  text-align: center;
}
</style>