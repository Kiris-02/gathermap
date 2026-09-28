# GatherMap 🗺️🍽️

> **Equal-Weight Geometric Group Eatery Matchmaker**
> Finds the fair meeting spot for friends using Weiszfeld geometric median, Gemini AI multi-criteria interpretation, and decoupled travel & preference satisfaction scoring.

Live Demo: [https://gathermap.onrender.com](https://gathermap.onrender.com)

---

## 🌟 Visual Preview

| Desktop View (1440×900) | Mobile View (390×844) |
| :---: | :---: |
| ![Desktop View](https://raw.githubusercontent.com/Kiris-02/gathermap/refactor/ui-map-architecture/tests/screenshots/after_desktop_1440x900.png) | ![Mobile View](https://raw.githubusercontent.com/Kiris-02/gathermap/refactor/ui-map-architecture/tests/screenshots/after_mobile_390x844.png) |

---

## 🏗️ Architecture

GatherMap is organized into a clean, decoupled architecture:

### Frontend (`public/`)
- `public/index.html`: Clean entrypoint loading modular CSS and Alpine.js controllers.
- `public/css/`:
  - `app.css`: Base typography, layout, custom scrollbars, beacon radar animations.
  - `map.css`: Safe Leaflet theming (dark zoom controls, dark tooltips, marker SVG drop shadows) with zero destructive `!important` pane overrides.
- `public/js/`:
  - `api-client.js`: Centralized fetch client with timeout, JSON parsing, and AbortController.
  - `state.js`: Reactive state factory, voter persistence (`localStorage`), URL parameter parser (`?outing=...`).
  - `map-controller.js`: Leaflet map lifecycle, watermark-free Esri Dark Gray canvas tiles, Weiszfeld center beacon, radius circles, and dynamic travel polylines.
  - `outing-controller.js`: Session management, URL syncing, deduplicated voting (toggle off & change vote), and 4s live polling with backoff.
  - `recommendation-controller.js`: Search and rank pipeline, geocoding, Weiszfeld recalculation, quick filters, and distinct empty states.
  - `review-controller.js`: Reviewer drawer, fetching social highlights, and optimistic review submissions.
  - `ui/venue-card.js`: Truthful 3-state opening hours badge, image fallbacks, and expandable member satisfaction breakdown.
  - `ui/modals.js`: Group modal, reviewers modal, share modal, and keyboard shortcuts (ESC).
  - `ui/notifications.js`: Non-blocking toast notifications (no native `alert()`).
  - `app.js`: Root Alpine component `gatherApp()` stitching all controllers via property descriptors.

### Backend (`src/`)
- `src/algorithms/`:
  - `geometric-median.js`: Pure Weiszfeld algorithm with Haversine distance.
  - `scoring.js`: Member satisfaction formula ($0.70 \times \text{pref} + 0.30 \times \text{travel}$) and group fairness formula ($0.65 \times \text{avg} + 0.35 \times \text{min}$).
- `src/repositories/`:
  - `db-client.js`: Dual-database manager supporting Supabase Cloud PostgreSQL and local SQLite (`better-sqlite3`).
  - `venue-repository.js`: Radius filtering, attribute normalization, truthful status computation.
  - `review-repository.js`: Review cache, social highlights, and user review persistence.
  - `outing-repository.js`: Session persistence, participant tracking, and deduplicated voting.
- `src/services/`:
  - `ai-service.js`: Gemini AI multi-model preferences parser with rule-based NLP fallback.
  - `geocoding-service.js`: In-memory landmark cache, Google Geocoding with OSM Nominatim fallback.
  - `recommendation-service.js`: End-to-end candidate ranking, member breakdown generation, and session persistence.
  - `outing-service.js`: Outing creation, voting coordination, and share link generation.
  - `places-service.js`: Navigation URLs and Google Places integration.
- `src/controllers/` & `src/routes/`: Express REST endpoints mounted in `src/app.js`.
- Backward-compatible entrypoints: `server.js` and `db.js`.

---

## 🚀 Quickstart

### 1. Installation
```bash
git clone https://github.com/Kiris-02/gathermap.git
cd gathermap
npm install
```

### 2. Environment Setup
Copy `.env.example` to `.env` and provide your API keys (optional: works with local SQLite and rule-based NLP out of the box):
```bash
cp .env.example .env
```

Configuration variables:
```ini
PORT=3000
GEMINI_API_KEY=your_gemini_api_key_here
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### 3. Run Tests
Execute the full automated test suite (39 deterministic tests):
```bash
npm test
```

### 4. Start Local Server
```bash
npm start
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📡 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/venues/search-and-rank` | Search, score, and rank venues around geometric median |
| `POST` | `/api/center/geometric-median` | Calculate Weiszfeld geometric center for group coordinates |
| `POST` | `/api/preferences/parse` | Extract structured dietary & ambience preferences via Gemini |
| `GET` | `/api/outings/:id` | Fetch session details, participants, and live vote counts |
| `POST` | `/api/outings/:id/vote` | Cast, toggle off, or change a vote for a venue |
| `POST` | `/api/outings/generate-share-text` | Generate invitation text for Zalo / Messenger |
| `GET` | `/api/venues/:id/reviewers` | Retrieve authentic reviews and social highlights |
| `POST` | `/api/venues/:id/reviews` | Submit a new user review |
| `GET` | `/api/geocode?q=...` | Multi-tier geocoding for landmarks and addresses |
| `GET` | `/api/presets` | Pre-configured test scenarios (District 1, Phú Nhuận, etc.) |
| `GET` | `/api/config` | Backend runtime capabilities check |

---

## 🔄 Rollback Instructions

If branch `refactor/ui-map-architecture` needs to be reverted after merge:
```bash
git checkout main
git revert <merge_commit_sha> -m 1
git push origin main
```
Or reset directly to the commit preceding the merge:
```bash
git reset --hard 31ad34b
git push origin main --force
```

---

## 📄 License
ISC
