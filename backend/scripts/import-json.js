// Imports backend/data/movies.json into MongoDB. Safe to run multiple times:
// movies whose "id" already exists in the database are skipped.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Movie = require('../models/Movie');

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in backend/.env');
  await mongoose.connect(process.env.MONGODB_URI);
  const file = path.join(__dirname, '..', 'data', 'movies.json');
  const movies = JSON.parse(fs.readFileSync(file, 'utf8'));

  let added = 0;
  for (const { createdAt, updatedAt, ...m } of movies) {
    if (await Movie.exists({ id: m.id })) continue;
    await Movie.create(m);
    added++;
  }
  console.log(`Imported ${added} new movie(s). ${movies.length - added} already existed.`);
  await mongoose.disconnect();
})().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
