# CineVault — Movie Portal (Frontend + Backend)

```
CineVault_FullStack/
├── backend/                 API + MongoDB + admin panel (keep private)
│   ├── admin/index.html     Admin panel (served at /admin)
│   ├── data/movies.json     Seed data (imported automatically on first start)
│   ├── models/Movie.js      MongoDB schema
│   ├── scripts/import-json.js
│   ├── server.js            Express server (API + website + admin)
│   ├── .env.example         Copy to .env
│   ├── render.yaml          Render deploy config
│   ├── railway.json         Railway deploy config
│   └── Procfile
└── frontend/                User website (public)
    ├── config.js            API address (auto-detected)
    └── index.html
```

## 1. Local setup

### a) MongoDB
Choose one:
- **MongoDB Atlas (cloud, recommended):** create a free M0 cluster, add a database user, allow your IP under
  Network Access, and copy the connection string from *Connect → Drivers*.
- **Local MongoDB:** `docker run -d -p 27017:27017 --name cinevault-mongo mongo`

### b) Backend
```bash
cd backend
cp .env.example .env        # Windows: copy .env.example .env
```
Edit `.env`:
- `MONGODB_URI` — your Atlas string or `mongodb://127.0.0.1:27017/cinevault`
- `ADMIN_PASSWORD` — your admin password (12+ characters for production)

Then:
```bash
npm install
npm start
```
Open:
- Website: http://localhost:5000
- Admin panel: http://localhost:5000/admin
- API check: http://localhost:5000/api/movies

On the first start, the 4 sample movies from `data/movies.json` are loaded into MongoDB automatically. After that, the database is the source of truth.

### c) Frontend
The backend already serves the website at `/`, so you only need the backend running.
To open `frontend/index.html` directly from disk, it connects to `http://localhost:5000`.

## 2. Managing movies
Use the admin panel (`/admin`). Add a movie with title, category, poster, synopsis and up to three download links
(480p, 720p, 1080p). Only `http(s)` links are accepted. Delete movies from the same page.

To import the JSON file again (for example, after editing `data/movies.json`), run:
```bash
npm run import
```
It adds only movies whose `id` does not already exist, so existing data is never overwritten.

## 3. Deploy

### Option A: Render (recommended, one service)
1. Push the **contents** of the `CineVault_FullStack` folder to a GitHub repo, so `backend/` and `frontend/` sit at the root.
2. In Render: **New → Blueprint** and choose the repo. It reads `backend/render.yaml`.
3. In the Render dashboard, set:
   - `MONGODB_URI` — Atlas connection string
   - `ADMIN_PASSWORD` — strong password (12+ characters)
4. Deploy. Your site is at `https://<your-service>.onrender.com`, admin at `/admin`.

### Option B: Railway
1. Create a new project from the GitHub repo and set the **Root Directory** to `backend`.
2. Add variables: `MONGODB_URI`, `ADMIN_PASSWORD`, `NODE_ENV=production`.
3. Railway reads `backend/railway.json` (start command `npm start`, health check `/api/health`).

### MongoDB Atlas for deployment
Hosting providers use changing IP addresses, so in Atlas **Network Access** either add `0.0.0.0/0` (protect
the database user with a strong password) or add the provider's static outbound IPs if your plan offers them.

### Production notes
- `NODE_ENV=production` makes the server refuse to start without a strong `ADMIN_PASSWORD`.
- Login is limited to 10 attempts per IP every 15 minutes.
- Never commit `.env` to GitHub (it is in `.gitignore`).
- The site links to external sources and does not host movie files. Only publish films whose specific
  edition is verified as public domain or licensed in your territory.

## Troubleshooting
- **`MONGODB_URI is not set`**: create `backend/.env` from `.env.example`.
- **`MongoDB connection failed`**: check the password (URL-encode special characters), the database user, and
  Atlas Network Access.
- **`ADMIN_PASSWORD is not set`**: needed when `NODE_ENV=production`.
- **Login says "Too many login attempts"**: wait 15 minutes or restart the server (limit is in memory).
