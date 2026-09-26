/**
 * GatherMap Leaflet Map Controller
 * Initializes map, tiles, friend pins, center beacon, radius circles, and travel polylines.
 * Strict anti-regression: avoids destructive !important CSS rules and layer memory leaks.
 */
window.createMapController = function() {
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    return {
        map: null,
        centerMarker: null,
        radiusCircle: null,
        friendMarkers: [],
        venueMarkers: [],
        travelLines: [],
        tileLayers: {},
        currentMapStyle: 'dark',

        initMap() {
            const mapContainer = document.getElementById('map');
            if (!mapContainer || this.map) return;

            this.map = L.map('map', {
                center: [this.centerCoords.lat, this.centerCoords.lng],
                zoom: 14,
                zoomControl: false
            });

            L.control.zoom({ position: 'bottomleft' }).addTo(this.map);

            this.tileLayers = {
                osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    maxZoom: 19,
                    attribution: '&copy; OpenStreetMap contributors'
                }),
                dark: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
                    maxZoom: 18,
                    attribution: '&copy; Esri &copy; DeLorme, NAVTEQ'
                }),
                street: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
                    maxZoom: 18,
                    attribution: '&copy; Esri'
                })
            };

            const attachTileListeners = (layer, styleName) => {
                let errorCount = 0;
                layer.on('tileerror', () => {
                    errorCount++;
                    if (errorCount >= 4 && this.currentMapStyle === styleName) {
                        this.mapTileError = true;
                    }
                });
                layer.on('tileload', () => {
                    errorCount = 0;
                    if (this.currentMapStyle === styleName) {
                        this.mapTileError = false;
                    }
                });
            };

            attachTileListeners(this.tileLayers.osm, 'osm');
            attachTileListeners(this.tileLayers.dark, 'dark');
            attachTileListeners(this.tileLayers.street, 'street');

            this.currentMapStyle = 'dark';
            this.tileLayers.dark.addTo(this.map);

            this.renderCenterMarker();
            this.renderFriendMarkers();

            setTimeout(() => {
                if (this.map) this.map.invalidateSize();
            }, 250);
        },

        retryMapTiles() {
            this.mapTileError = false;
            if (this.map && this.tileLayers && this.tileLayers[this.currentMapStyle]) {
                const current = this.tileLayers[this.currentMapStyle];
                if (this.map.hasLayer(current)) {
                    this.map.removeLayer(current);
                    current.addTo(this.map);
                }
            }
        },

        switchMapStyle(style) {
            if (!this.map || !this.tileLayers || this.currentMapStyle === style) return;
            this.mapTileError = false;
            if (this.tileLayers[this.currentMapStyle] && this.map.hasLayer(this.tileLayers[this.currentMapStyle])) {
                this.map.removeLayer(this.tileLayers[this.currentMapStyle]);
            }
            if (this.tileLayers[style]) {
                this.tileLayers[style].addTo(this.map);
                this.currentMapStyle = style;
            }
        },

        renderCenterMarker() {
            if (!this.map) return;
            if (this.centerMarker) {
                this.map.removeLayer(this.centerMarker);
                this.centerMarker = null;
            }

            const icon = L.divIcon({
                className: 'center-beacon-outer',
                html: '<div style="background:#f59e0b; width:26px; height:26px; border-radius:50%; border:3px solid #ffffff; box-shadow:0 0 18px rgba(245,158,11,1); display:flex; align-items:center; justify-content:center; cursor:default;"><div style="width:7px; height:7px; background:#ffffff; border-radius:50%;"></div></div>',
                iconSize: [26, 26],
                iconAnchor: [13, 13],
                popupAnchor: [0, -13]
            });

            this.centerMarker = L.marker([this.centerCoords.lat, this.centerCoords.lng], {
                icon,
                draggable: false,
                zIndexOffset: 1000
            }).addTo(this.map);

            this.centerMarker.bindTooltip('<strong>📍 Tâm điểm gặp mặt (Weiszfeld)</strong>', {
                permanent: false,
                direction: 'top',
                offset: [0, -14]
            });

            this.updateRadiusCircle();
        },

        updateRadiusCircle() {
            if (!this.map) return;
            if (this.radiusCircle) {
                this.map.removeLayer(this.radiusCircle);
                this.radiusCircle = null;
            }
            this.radiusCircle = L.circle([this.centerCoords.lat, this.centerCoords.lng], {
                radius: this.searchRadiusMeters,
                color: '#f59e0b',
                weight: 2,
                dashArray: '5, 6',
                fillColor: '#f59e0b',
                fillOpacity: 0.08
            }).addTo(this.map);
        },

        renderFriendMarkers() {
            if (!this.map) return;
            this.friendMarkers.forEach(m => this.map.removeLayer(m));
            this.friendMarkers = [];

            this.friends.forEach((f) => {
                const isMe = (f.name || '').includes('You');
                const fillColor = isMe ? '#2563eb' : (f.color === 'bg-emerald-500' ? '#10b981' : '#6366f1');
                const initialChar = escapeHtml((f.name || 'F').charAt(0));

                const icon = L.divIcon({
                    className: 'friend-pin',
                    html: `<svg width="30" height="38" viewBox="0 0 30 38" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M15 37C15 37 2 24 2 14C2 6.82 7.82 1 15 1C22.18 1 28 6.82 28 14C28 24 15 37 15 37Z" fill="${fillColor}" stroke="#ffffff" stroke-width="2"/>
                        <circle cx="15" cy="14" r="9.5" fill="#ffffff"/>
                        <text x="15" y="18" text-anchor="middle" fill="#0b0f19" font-size="11" font-weight="900" font-family="sans-serif">${initialChar}</text>
                    </svg>`,
                    iconSize: [30, 38],
                    iconAnchor: [15, 37],
                    popupAnchor: [0, -37]
                });

                const m = L.marker([f.lat, f.lng], { icon, draggable: false }).addTo(this.map);
                const safeName = escapeHtml(f.name);
                const safeWish = f.wish ? `<br><span style="font-size:10px; opacity:0.8">${escapeHtml(f.wish)}</span>` : '';
                m.bindTooltip(`<strong>${safeName}</strong>${safeWish}`, {
                    direction: 'top',
                    offset: [0, -35]
                });

                this.friendMarkers.push(m);
            });
        },

        renderVenueMarkers() {
            if (!this.map) return;
            this.venueMarkers.forEach(m => this.map.removeLayer(m));
            this.venueMarkers = [];

            this.shortlist.forEach((venue, idx) => {
                const isTop = idx === 0;
                const pinColor = isTop ? '#10b981' : '#f59e0b';
                const icon = L.divIcon({
                    className: 'venue-pin',
                    html: `<svg width="34" height="44" viewBox="0 0 34 44" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M17 43C17 43 3 28.5 3 17C3 9.27 9.27 3 17 3C24.73 3 31 9.27 31 17C31 28.5 17 43 17 43Z" fill="${pinColor}" stroke="#ffffff" stroke-width="2.2"/>
                        <circle cx="17" cy="17" r="9.5" fill="#ffffff"/>
                        <text x="17" y="21" text-anchor="middle" fill="#0b0f19" font-size="11" font-weight="900" font-family="sans-serif">${idx + 1}</text>
                    </svg>`,
                    iconSize: [34, 44],
                    iconAnchor: [17, 43],
                    popupAnchor: [0, -43]
                });

                const m = L.marker([venue.lat, venue.lng], { icon }).addTo(this.map);
                const safeVenueName = escapeHtml(venue.name);
                const safeCategory = escapeHtml(venue.category);
                m.bindTooltip(`<strong>#${idx + 1} ${safeVenueName}</strong><br>${safeCategory} (${venue.groupScore}/100)`, {
                    direction: 'top',
                    offset: [0, -40]
                });

                m.on('click', () => {
                    this.selectVenue(venue);
                });

                this.venueMarkers.push(m);
            });
        },

        drawTravelLines(venue) {
            this.clearTravelLines();
            if (!this.map || !venue) return;

            this.friends.forEach((f) => {
                const line = L.polyline([[f.lat, f.lng], [venue.lat, venue.lng]], {
                    color: '#38bdf8',
                    weight: 2.5,
                    dashArray: '6, 8',
                    opacity: 0.8
                }).addTo(this.map);

                this.travelLines.push(line);
            });
        },

        clearTravelLines() {
            if (!this.map) return;
            this.travelLines.forEach(l => this.map.removeLayer(l));
            this.travelLines = [];
        },

        fitMapToAll() {
            if (!this.map) return;
            const points = this.friends.map(f => [f.lat, f.lng]);
            if (this.centerCoords && this.centerCoords.lat) {
                points.push([this.centerCoords.lat, this.centerCoords.lng]);
            }
            if (this.shortlist && this.shortlist.length > 0) {
                points.push([this.shortlist[0].lat, this.shortlist[0].lng]);
            }
            if (points.length > 0) {
                const bounds = L.latLngBounds(points);
                this.map.fitBounds(bounds.pad(0.2));
            }
        }
    };
};
