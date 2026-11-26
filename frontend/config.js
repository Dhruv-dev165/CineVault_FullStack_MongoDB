// API address for the user website.
// - When the site is served by the backend (same server), it uses the current address automatically.
// - When opening index.html directly from disk, it uses http://localhost:5000.
// - To point to a separate API host, set window.CINEVAULT_API_URL before this file loads, e.g.:
//   <script>window.CINEVAULT_API_URL = "https://api.yourdomain.com";</script>
const API_BASE_URL = window.CINEVAULT_API_URL ||
  (location.protocol === "file:" ? "http://localhost:5000" : location.origin);
