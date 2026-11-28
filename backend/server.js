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

// ---------- TMDB metadata sync (metadata/posters only; never downloads video) ----------
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';
const imdbRatingCache = new Map();
const IMDB_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

async function getImdbMetadata(movie) {
  const title = String(movie.title || '').trim();
  if (!OMDB_API_KEY || !title) return movie;
  const year = String(movie.year || '').match(/\\d{4}/)?.[0] || '';
  const cacheKey = title.toLowerCase() + '|' + year;
  const cached = imdbRatingCache.get(cacheKey);
  if (cached && Date.now() - cached.at < IMDB_CACHE_TTL_MS) return { ...movie, ...cached.data };
  try {
    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('apikey', OMDB_API_KEY);
    url.searchParams.set('t', title);
    if (year) url.searchParams.set('y', year);
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('OMDb HTTP ' + response.status);
    const data = await response.json();
    const rating = data.Response === 'True' && /^\\d+(\\.\\d+)?$/.test(data.imdbRating || '') ? data.imdbRating : '';
    const metadata = {
      imdbRating: rating,
      imdbVotes: data.imdbVotes && data.imdbVotes !== 'N/A' ? data.imdbVotes : '',
      imdbID: data.imdbID && data.imdbID !== 'N/A' ? data.imdbID : ''
    };
    imdbRatingCache.set(cacheKey, { at: Date.now(), data: metadata });
    return { ...movie, ...metadata };
  } catch (err) {
    console.error('IMDb rating lookup failed for "' + title + '":', err.message);
    return movie;
  }
}

let imdbWarmupInProgress = false;

async function addImdbRatings(movies) {
  if (!OMDB_API_KEY || !movies.length) return movies;

  // Never make the public catalogue wait for dozens of third-party OMDb calls.
  // Return immediately with cached ratings; warm the cache in the background.
  const now = Date.now();
  const response = movies.map(movie => {
    const title = String(movie.title || '').trim();
    const year = String(movie.year || '').match(/\d{4}/)?.[0] || '';
    const cached = imdbRatingCache.get(title.toLowerCase() + '|' + year);
    return cached && now - cached.at < IMDB_CACHE_TTL_MS
      ? { ...movie, ...cached.data }
      : movie;
  });

  if (!imdbWarmupInProgress) {
    imdbWarmupInProgress = true;
    (async () => {
      try {
        for (let i = 0; i < movies.length; i += 5) {
          await Promise.all(movies.slice(i, i + 5).map(getImdbMetadata));
        }
      } finally {
        imdbWarmupInProgress = false;
      }
    })().catch(err => console.error('IMDb background lookup failed:', err.message));
  }

  return response;
}

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_READ_ACCESS_TOKEN = process.env.TMDB_READ_ACCESS_TOKEN || '';
let lastTmdbSyncAt = 0;
let tmdbSyncInFlight = null;

async function syncTmdbMetadata() {
  if (!TMDB_API_KEY && !TMDB_READ_ACCESS_TOKEN) {
    return { enabled: false, imported: 0, message: 'TMDB credentials are not configured.' };
  }
  if (tmdbSyncInFlight) return tmdbSyncInFlight;
  tmdbSyncInFlight = (async () => {
    const endpoints = ['now_playing', 'upcoming', 'popular'];
    const headers = { accept: 'application/json' };
    const results = await Promise.all(endpoints.map(async endpoint => {
      const url = new URL(`https://api.themoviedb.org/3/movie/${endpoint}`);
      url.searchParams.set('language', 'en-US');
      url.searchParams.set('region', 'IN');
      url.searchParams.set('page', '1');
      if (TMDB_API_KEY) url.searchParams.set('api_key', TMDB_API_KEY);
      if (TMDB_READ_ACCESS_TOKEN) headers.Authorization = `Bearer ${TMDB_READ_ACCESS_TOKEN}`;
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`TMDB ${endpoint} request failed: HTTP ${response.status}`);
      const body = await response.json();
      return body.results || [];
    }));
    const unique = new Map();
    results.flat().forEach(movie => { if (movie && movie.id) unique.set(movie.id, movie); });
    let imported = 0;
    for (const movie of unique.values()) {
      const year = movie.release_date ? movie.release_date.slice(0, 4) : '';
      const category = movie.original_language === 'hi' ? 'Bollywood' : (['ta', 'te', 'ml', 'kn'].includes(movie.original_language) ? 'South Dubbed' : 'Hollywood');
      const doc = {
        id: `tmdb_${movie.id}`,
        title: movie.title || movie.original_title || 'Untitled',
        category,
        year: year || String(new Date().getFullYear()),
        qualityTag: 'MOVIE INFO',
        language: movie.original_language || 'Unknown',
        size: '',
        poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : '',
        synopsis: movie.overview || 'Synopsis not available.',
        links: { '480p': '', '720p': '', '1080p': '' }
      };
      const result = await Movie.updateOne(
        { id: doc.id },
        { $setOnInsert: doc },
        { upsert: true }
      );
      if (result.upsertedCount) imported++;
    }
    lastTmdbSyncAt = Date.now();
    console.log(`TMDB metadata sync complete: ${imported} new titles`);
    return { enabled: true, imported, checked: unique.size, syncedAt: new Date(lastTmdbSyncAt).toISOString() };
  })();
  try { return await tmdbSyncInFlight; }
  finally { tmdbSyncInFlight = null; }
}

function maybeSyncTmdb() {
  if ((TMDB_API_KEY || TMDB_READ_ACCESS_TOKEN) && Date.now() - lastTmdbSyncAt > 12 * 60 * 60 * 1000) {
    syncTmdbMetadata().catch(err => console.error('TMDB metadata sync failed:', err.message));
  }
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
  maybeSyncTmdb();
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
    const ratedMovies = await addImdbRatings(movies);
    res.json(ratedMovies);
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

// PUBLIC: TMDB metadata sync status (never exposes credentials)
app.get('/api/tmdb/status', (_req, res) => {
  res.json({
    configured: Boolean(TMDB_API_KEY || TMDB_READ_ACCESS_TOKEN),
    lastSync: lastTmdbSyncAt ? new Date(lastTmdbSyncAt).toISOString() : null,
    intervalHours: 12,
    source: 'TMDB metadata and posters only'
  });
});

// ADMIN: trigger a metadata-only TMDB import
app.post('/api/admin/tmdb-sync', requireAdmin, async (_req, res) => {
  try {
    const result = await syncTmdbMetadata();
    if (!result.enabled) return res.status(503).json(result);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('TMDB metadata sync failed:', err.message);
    res.status(502).json({ success: false, error: 'TMDB sync failed. Check the server configuration and TMDB credentials.' });
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
  maybeSyncTmdb();
  const tmdbTimer = setInterval(maybeSyncTmdb, 60 * 60 * 1000);
  if (tmdbTimer.unref) tmdbTimer.unref();
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
