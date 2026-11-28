const mongoose = require('mongoose');

const movieSchema = new mongoose.Schema({
  id:         { type: String, required: true, unique: true, index: true },
  title:      { type: String, required: true, trim: true, maxlength: 300 },
  category:   { type: String, default: 'Bollywood' },
  year:       { type: String, default: '2026' },
  qualityTag: { type: String, default: '1080p WEB-DL' },
  language:   { type: String, default: 'Hindi / Dual Audio' },
  size:       { type: String, default: '' },
  poster:     { type: String, default: '' },
  synopsis:   { type: String, default: '' },
  tmdbId:     { type: Number, default: null },
  imdbID:     { type: String, default: '' },
  imdbRating: { type: String, default: '' },
  imdbVotes:  { type: String, default: '' },
  genres:     { type: [String], default: [] },
  director:   { type: String, default: '' },
  cast:       { type: [String], default: [] },
  runtime:    { type: Number, default: null },
  backdrop:   { type: String, default: '' },
  releaseDate:{ type: String, default: '' },
  links: {
    '480p':  { type: String, default: '' },
    '720p':  { type: String, default: '' },
    '1080p': { type: String, default: '' }
  }
}, { timestamps: true });

movieSchema.index({ category: 1 });
movieSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Movie', movieSchema);
