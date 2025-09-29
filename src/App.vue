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
import { ref, reactive, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import axios from "axios";
import * as StompJs from "@stomp/stompjs";
import SockJS from "sockjs-client/dist/sockjs.js";

/* --------- Config (change to your backend URLs) ---------- */
const API_BASE = "http://localhost:8485/api"; // e.g. http://localhost:8080/api
const WS_ENDPOINT = "/ws"; // e.g. ws endpoint registered in Spring Boot (SockJS)
const currentUser = "me"; // replace with your auth username or id from auth token
/* -------------------------------------------------------- */

/* state */
const chats = ref([]);
const selectedChat = ref(null);
const messages = ref([]);
const newMessage = ref("");
const wsConnected = ref(false);
const stompClient = ref(null);
const subscriptions = reactive({}); // map chatId -> subscription

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
    const res = await axios.get(`${API_BASE}/messages/conversations`);
    chats.value = res.data;
    if (!selectedChat.value && chats.value.length) {
      selectChat(chats.value[0]);
    }
  } catch (err) {
    console.error("Failed to load chats", err);
  }
};

const loadMessages = async (chatId) => {
  try {
    const res = await axios.get(`${API_BASE}/messages/conversations/${chatId}`);
    messages.value = res.data || [];
    await scrollToBottom();
  } catch (err) {
    console.error("Failed to load messages", err);
  }
};

/* ----- WebSocket / STOMP ----- */
const connectWebsocket = () => {
  if (stompClient.value && stompClient.value.connected) return;

  // Create STOMP client over SockJS
  const socket = new SockJS(WS_ENDPOINT);
  const client = new StompJs.Client({
    webSocketFactory: () => socket,
    reconnectDelay: 5000,
    heartbeatIncoming: 10000,
    heartbeatOutgoing: 10000,
    onConnect: () => {
      console.log("STOMP connected");
      wsConnected.value = true;

      // re-subscribe to current chat if exists
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
  });

  client.activate();
  stompClient.value = client;
};

const disconnectWebsocket = () => {
  if (stompClient.value) {
    stompClient.value.deactivate();
    stompClient.value = null;
    wsConnected.value = false;
  }
};

const subscribeToChat = (chatId) => {
  if (!stompClient.value || !stompClient.value.connected) {
    console.warn("STOMP not connected yet; connect first");
    return;
  }
  // unsubscribe previous subscription for this chat if exists
  if (subscriptions[chatId]) {
    subscriptions[chatId].unsubscribe();
    delete subscriptions[chatId];
  }

  // Topic configured server side should be /topic/chat.{chatId}
  const topic = `/topic/conversation.${chatId}`;
  const sub = stompClient.value.subscribe(topic, (message) => {
    if (!message.body) return;
    const msg = JSON.parse(message.body);
    // push incoming message if for current chat
    if (selectedChat.value && selectedChat.value.id === chatId) {
      messages.value.push(msg);
      scrollToBottom();
    }
    // optionally update chat preview in chat list
    const c = chats.value.find((x) => x.id === chatId);
    if (c) c.lastMessage = msg.text;
  });

  subscriptions[chatId] = sub;
};

const unsubscribeFromChat = (chatId) => {
  if (subscriptions[chatId]) {
    subscriptions[chatId].unsubscribe();
    delete subscriptions[chatId];
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
    // subscription will be made in onConnect
    // but if already connected, subscribe now:
    if (stompClient.value && stompClient.value.connected) {
      subscribeToChat(chat.id);
    }
  } else {
    subscribeToChat(chat.id);
  }
};

/* Send message: publish to STOMP destination; also POST to REST (optional) */
const onSend = async () => {
  const txt = newMessage.value && newMessage.value.trim();
  if (!txt || !selectedChat.value) return;

  // message payload
  const payload = {
    chatId: selectedChat.value.id,
    from: currentUser,
    text: txt,
    sentAt: new Date().toISOString(),
  };

  // send via STOMP to /app/chat/{chatId}
  try {
    if (stompClient.value && stompClient.value.connected) {
      const dest = `/app/chat.${selectedChat.value.id}`;
      stompClient.value.publish({
        destination: dest,
        body: JSON.stringify(payload),
      });
      // optimistically add to UI
      messages.value.push({ ...payload });
      newMessage.value = "";
      await scrollToBottom();
      return;
    }
  } catch (err) {
    console.warn("STOMP send failed, will fallback to REST POST", err);
  }

  // fallback: POST to REST endpoint (server should broadcast too)
  try {
    await axios.post(`${API_BASE}/chats/${selectedChat.value.id}/messages`, payload);
    newMessage.value = "";
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
  // any extra logic when selected chat changes
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