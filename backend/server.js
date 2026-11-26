require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const Movie = require('./models/Movie');

const PORT = process.env.PORT || 5000;
const IS_PROD = process.env.NODE_ENV === 'production';
const MONGODB_URI = process.env.MONGODB_URI;
const SEED_FILE = path.join(__dirname, 'data', 'movies.json');
const QUALITIES = ['480p', '720p', '1080p'];

// ---------- Configuration checks ----------
if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Add it to backend/.env (or your host dashboard) and start again.');
  process.exit(1);
}

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  if (IS_PROD) {
    console.error('ADMIN_PASSWORD is not set. Refusing to start in production without it.');
    process.exit(1);
  }
  ADMIN_PASSWORD = 'admin123';
  console.warn('WARNING: ADMIN_PASSWORD not set. Using development default "admin123". Do not deploy like this.');
}
if (IS_PROD && ADMIN_PASSWORD.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters in production.');
  process.exit(1);
}

// ---------- Helpers ----------
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const isHttpUrl = value => {
  try {
    const u = new URL(String(value).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

// Simple in-memory limiter: max 10 login attempts per IP per 15 minutes.
const loginAttempts = new Map();
function loginLimiter(req, res, next) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const rec = loginAttempts.get(req.ip) || { count: 0, start: now };
  if (now - rec.start > windowMs) { rec.count = 0; rec.start = now; }
  if (rec.count >= 10) {
    return res.status(429).json({ success: false, error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  rec.count++;
  loginAttempts.set(req.ip, rec);
  next();
}

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!pw || !safeEqual(pw, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin Password' });
  }
  next();
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // needed behind Render/Railway proxies so req.ip is the real client
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// Health check (used by Render/Railway)
app.get('/api/health', (_req, res) => res.json({ status: 'ok', app: 'CineVault' }));

// PUBLIC: list movies (?category=, ?search=, ?quality=)
app.get('/api/movies', async (req, res) => {
  try {
    const { category, search, quality } = req.query;
    const filter = {};
    if (category && category !== 'All') {
      filter.category = new RegExp(`^${escapeRegex(String(category))}$`, 'i');
    }
    if (QUALITIES.includes(quality)) {
      filter[`links.${quality}`] = { $nin: ['', null] };
    }
    if (search && String(search).trim()) {
      const rx = new RegExp(escapeRegex(String(search).trim().slice(0, 100)), 'i');
      filter.$or = [{ title: rx }, { synopsis: rx }, { language: rx }];
    }
    const movies = await Movie.find(filter).sort({ createdAt: -1 }).select('-_id -__v').lean();
    res.json(movies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load movies' });
  }
});

// PUBLIC: one movie
app.get('/api/movies/:id', async (req, res) => {
  try {
    const movie = await Movie.findOne({ id: req.params.id }).select('-_id -__v').lean();
    if (!movie) return res.status(404).json({ error: 'Movie not found' });
    res.json(movie);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load movie' });
  }
});

// ADMIN: check password
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (password && safeEqual(password, ADMIN_PASSWORD)) {
    return res.json({ success: true, message: 'Authenticated' });
  }
  return res.status(401).json({ success: false, error: 'Wrong Admin Password' });
});

// ADMIN: add movie
app.post('/api/movies', requireAdmin, async (req, res) => {
  try {
    const { title, category, year, qualityTag, language, size, poster, synopsis, links = {} } = req.body || {};
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Title is required.' });
    }
    const cleanLinks = {};
    for (const q of QUALITIES) {
      const val = typeof links[q] === 'string' ? links[q].trim() : '';
      cleanLinks[q] = val && isHttpUrl(val) ? val : '';
    }
    if (!Object.values(cleanLinks).some(Boolean)) {
      return res.status(400).json({ error: 'Add at least one valid http(s) download link (480p/720p/1080p).' });
    }
    const movie = await Movie.create({
      id: 'mov_' + Date.now(),
      title: title.trim(),
      category: category || 'Bollywood',
      year: year || '2026',
      qualityTag: qualityTag || '1080p WEB-DL',
      language: language || 'Hindi / Dual Audio',
      size: size || '',
      poster: typeof poster === 'string' && isHttpUrl(poster) ? poster.trim() : '',
      synopsis: synopsis || 'Full HD movie available for direct download.',
      links: cleanLinks
    });
    const out = movie.toObject();
    delete out._id; delete out.__v;
    res.status(201).json({ success: true, movie: out });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save movie' });
  }
});

// ADMIN: delete movie
app.delete('/api/movies/:id', requireAdmin, async (req, res) => {
  try {
    const result = await Movie.deleteOne({ id: req.params.id });
    if (!result.deletedCount) return res.status(404).json({ error: 'Movie not found' });
    res.json({ success: true, message: 'Movie deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete movie' });
  }
});

// Unknown API routes -> JSON 404
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Static: admin panel at /admin, public website at /
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Error handler (bad JSON, oversized body, anything unexpected)
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------- Startup ----------
async function seedIfEmpty() {
  const count = await Movie.countDocuments();
  if (count > 0 || !fs.existsSync(SEED_FILE)) return;
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  await Movie.insertMany(seed.map(({ createdAt, updatedAt, ...m }) => m));
  console.log(`Seeded ${seed.length} movies from data/movies.json`);
}

let server;
async function start() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('MongoDB connected');
  await seedIfEmpty();
  server = app.listen(PORT, () => {
    console.log('=================================================');
    console.log(` CineVault website:  http://localhost:${PORT}`);
    console.log(` Admin panel:        http://localhost:${PORT}/admin`);
    console.log(` API:                http://localhost:${PORT}/api/movies`);
    console.log('=================================================');
  });
}

start().catch(err => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});

async function shutdown() {
  if (server) server.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
