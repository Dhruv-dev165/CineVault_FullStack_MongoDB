const API_BASE = window.CINEVAULT_API_URL || "";
const grid = document.getElementById("movieGrid");
const status = document.getElementById("searchStatus");
const title = document.getElementById("resultsTitle");
let movies = [];
let activeCategory = "All";
let searchTerm = "";

const safe = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""), window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function posterMarkup(movie) {
  const poster = safeHttpUrl(movie.poster || movie.posterUrl || movie.image);
  const rating = Number.parseFloat(movie.imdbRating);
  const ratingBadge = Number.isFinite(rating)
    ? '<span class="imdb-rating-badge" title="IMDb rating' + (movie.imdbVotes ? ' · ' + safe(movie.imdbVotes) + ' votes' : '') + '"><span class="imdb-star">★</span> IMDb ' + rating.toFixed(1) + '</span>'
    : '';
  const art = poster
    ? '<img class="movie-poster-image" src="' + safe(poster) + '" alt="' + safe(movie.title || movie.name || "Movie poster") + '" loading="lazy" onerror="this.style.display=\\'none\\';this.nextElementSibling.style.display=\\'grid\\'"><div class="movie-poster-fallback" style="display:none">🎬</div>'
    : '<div class="movie-poster-fallback">🎬</div>';
  return '<div class="poster-art">' + art + '</div>' + ratingBadge;
}

function getFilteredMovies() {
  return movies.filter(movie => {
    const category = String(movie.category || movie.type || "").toLowerCase();
    const searchable = [movie.title, movie.name, movie.category, movie.language, movie.synopsis, movie.year]
      .join(" ").toLowerCase();
    const categoryMatch = activeCategory === "All"
      || category.includes(activeCategory.toLowerCase())
      || (activeCategory === "Web Series" && String(movie.type || "").toLowerCase().includes("series"));
    return categoryMatch && searchable.includes(searchTerm);
  });
}

function render() {
  const filtered = getFilteredMovies();
  title.textContent = activeCategory === "All"
    ? (searchTerm ? "Search results" : "Latest titles")
    : activeCategory;

  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state">No matching titles found. Try another category or search.</div>';
    return;
  }

  grid.innerHTML = filtered.map((movie, index) =>
    '<article class="movie-card" data-movie-index="' + index + '" tabindex="0" role="button" aria-label="Open details for ' +
    safe(movie.title || movie.name || "Untitled") + '">' +
      '<div class="movie-poster">' + posterMarkup(movie) + '</div>' +
      '<div class="movie-info"><h3>' + safe(movie.title || movie.name || "Untitled") + '</h3>' +
      '<p>' + safe(movie.category || movie.type || "Movie") + ' · ' +
      safe(movie.year || "") + (movie.language ? ' · ' + safe(movie.language) : "") + '</p></div>' +
    '</article>'
  ).join("");
}

function openMovie(movie) {
  const oldDialog = document.getElementById("movieDetailsDialog");
  if (oldDialog) oldDialog.remove();

  const links = movie.links && typeof movie.links === "object" ? movie.links : {};
  const qualities = ["480p", "720p", "1080p"];
  const linkButtons = qualities.map(quality => {
    const url = safeHttpUrl(links[quality]);
    return url
      ? '<a class="movie-link-button" href="' + safe(url) + '" target="_blank" rel="noopener noreferrer">' +
        'Open authorized ' + quality + ' link</a>'
      : "";
  }).filter(Boolean).join("");

  const poster = safeHttpUrl(movie.poster || movie.posterUrl || movie.image);
  const dialog = document.createElement("dialog");
  dialog.id = "movieDetailsDialog";
  dialog.style.cssText = "max-width: min(92vw,520px); width:100%; max-height:85vh; overflow:auto; padding:22px; border:1px solid #334155; border-radius:18px; background:#101722; color:#f8fafc";
  dialog.innerHTML =
    '<button type="button" id="closeMovieDialog" aria-label="Close" style="float:right;padding:8px 12px">✕</button>' +
    (poster ? '<img src="' + safe(poster) + '" alt="' + safe(movie.title || "Movie poster") + '" style="display:block;max-height:260px;max-width:100%;object-fit:contain;margin:12px auto;border-radius:10px">' : "") +
    '<h2 style="margin:12px 0">' + safe(movie.title || movie.name || "Untitled") + '</h2>' +
    '<p>' + safe(movie.category || movie.type || "Movie") + ' · ' + safe(movie.year || "") + ' · ' + safe(movie.language || "") + '</p>' +
    '<p style="line-height:1.6">' + safe(movie.synopsis || "No description available.") + '</p>' +
    (linkButtons ? '<div style="display:grid;gap:10px;margin-top:18px">' + linkButtons + '</div>' :
      '<p style="margin-top:18px;color:#fbbf24">No authorized viewing links have been added for this title yet.</p>');
  document.body.appendChild(dialog);
  dialog.showModal();
  document.getElementById("closeMovieDialog").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
}

async function loadMovies() {
  try {
    const response = await fetch(API_BASE + "/api/movies", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("API returned HTTP " + response.status);
    const data = await response.json();
    movies = Array.isArray(data) ? data : (Array.isArray(data.movies) ? data.movies : []);
    status.textContent = movies.length
      ? movies.length + " titles loaded from CineVault"
      : "Catalogue is connected, but no titles are saved yet";
    render();
  } catch (error) {
    movies = [];
    status.textContent = "Could not connect to the movie catalogue";
    grid.innerHTML = '<div class="empty-state">CineVault could not load the catalogue. Please refresh in a moment.</div>';
    console.error("CineVault catalogue error:", error);
  }
}

grid.addEventListener("click", event => {
  const card = event.target.closest("[data-movie-index]");
  if (!card) return;
  const movie = getFilteredMovies()[Number(card.dataset.movieIndex)];
  if (movie) openMovie(movie);
});

grid.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-movie-index]");
  if (!card) return;
  event.preventDefault();
  const movie = getFilteredMovies()[Number(card.dataset.movieIndex)];
  if (movie) openMovie(movie);
});

document.getElementById("categoryList").addEventListener("click", event => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  activeCategory = button.dataset.category;
  document.querySelectorAll(".category-chip").forEach(chip =>
    chip.classList.toggle("active", chip === button)
  );
  render();
});

document.getElementById("clearFilter").addEventListener("click", () => {
  activeCategory = "All";
  searchTerm = "";
  document.getElementById("searchInput").value = "";
  document.querySelectorAll(".category-chip").forEach(chip =>
    chip.classList.toggle("active", chip.dataset.category === "All")
  );
  render();
});

document.getElementById("searchForm").addEventListener("submit", event => {
  event.preventDefault();
  searchTerm = document.getElementById("searchInput").value.trim().toLowerCase();
  status.textContent = searchTerm
    ? 'Filtering catalogue for "' + searchTerm + '"'
    : "Showing all catalogue titles";
  render();
});

const menu = document.getElementById("menuToggle");
menu.addEventListener("click", () => {
  const nav = document.getElementById("mainNav");
  const isOpen = nav.classList.toggle("open");
  menu.setAttribute("aria-expanded", String(isOpen));
});

loadMovies();
