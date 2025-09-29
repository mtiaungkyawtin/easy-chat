// api.js
import axios from "axios";

const API_BASE = "http://localhost:8485/api";

// replace with your backend username/password
const username = "admin";
const password = "Admin@123";

// encode credentials in base64
const basicAuth = "Basic " + btoa(`${username}:${password}`);

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    "Content-Type": "application/json",
    Authorization: basicAuth,
  },
});

export default api;