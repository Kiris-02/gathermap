/**
 * GatherMap Recommendation Controller
 * Handles search-and-rank pipeline, NLP preferences parsing, address geocoding, and quick filters.
 */
window.createRecommendationController = function() {
    return {
        get filteredShortlist() {
            if (!this.shortlist || !Array.isArray(this.shortlist)) return [];
            if (this.activeQuickFilter === 'all') return this.shortlist;
            return this.shortlist.filter(venue => {
                if (this.activeQuickFilter === 'car') {
                    const ease = venue.attributes?.parking?.ease;
                    const note = (venue.attributes?.parking?.note || '').toLowerCase();
                    const unknowns = (venue.unknowns || []).join(' ').toLowerCase();
                    return ease === 'easy' || note.includes('ô tô') || note.includes('oto') || note.includes('car') || unknowns.includes('ô tô');
                }
                if (this.activeQuickFilter === 'late_night') {
                    const badge = this.getOpeningBadge ? this.getOpeningBadge(venue) : null;
                    const oh = venue.openingHours;
                    return (badge && badge.type === '24_7') ||
                        (oh && oh.close && (oh.close >= '23:00' || oh.close <= '04:00')) ||
                        (venue.tags || []).some(t => {
                            const str = String(t).toLowerCase();
                            return str.includes('night') || str.includes('24h') || str.includes('24/7') || str.includes('khuya');
                        });
                }
                if (this.activeQuickFilter === 'budget') {
                    const price = venue.pricePerPersonVnd || 0;
                    return price > 0 && price <= 100000;
                }
                if (this.activeQuickFilter === 'quiet') {
                    const noise = venue.attributes?.noiseLevel?.value;
                    return noise === 'quiet' || (venue.tags || []).some(t => {
                        const str = String(t).toLowerCase();
                        return str.includes('quiet') || str.includes('yên tĩnh');
                    });
                }
                if (this.activeQuickFilter === 'view') {
                    const name = (venue.name || '').toLowerCase();
                    const cat = (venue.category || '').toLowerCase();
                    const tags = (venue.tags || []).map(t => String(t).toLowerCase());
                    return tags.some(t => t.includes('view') || t.includes('aesthetic') || t.includes('rooftop')) ||
                           name.includes('rooftop') || cat.includes('lounge');
                }
                return true;
            });
        },

        setQuickFilter(filterKey) {
            this.activeQuickFilter = filterKey;
            if (this.filteredShortlist.length > 0) {
                this.selectVenue(this.filteredShortlist[0]);
            }
        },

        async setRadius(meters) {
            const previousRadius = this.searchRadiusMeters;
            if (this.outingCode) {
                let putSucceeded = false;
                try {
                    const radiusKm = Number((meters / 1000).toFixed(2));
                    await window.ApiClient.put(`/api/outings/${this.outingCode}`, {
                        radiusKm
                    }, {
                        shareToken: this.shareToken
                    });
                    putSucceeded = true;
                    this.searchRadiusMeters = meters;
                    this.updateRadiusCircle();
                    this.showToast(`📏 Đã cập nhật bán kính: ${(meters/1000).toFixed(1)} km`, 'success');
                } catch (err) {
                    console.error('Update radius PUT error:', err);
                    // Phase 1 failed: Revert UI slider and circle to previous valid radius
                    this.searchRadiusMeters = previousRadius;
                    this.updateRadiusCircle();
                    if (err.status === 401 || err.status === 403) {
                        this.showToast('🔒 Không có quyền đổi bán kính kèo này (Yêu cầu share token hợp lệ).', 'error');
                    } else {
                        this.showToast(`⚠️ Không thể lưu bán kính mới: ${err.message}`, 'error');
                    }
                    return;
                }

                // Phase 2: Execute search. If search fails, keep updated radius and mark shortlist as stale
                if (putSucceeded) {
                    try {
                        await this.executeSearchAndRank();
                    } catch (searchErr) {
                        console.error('Search after radius update failed:', searchErr);
                        this.searchFailed = true;
                        this.isShortlistStale = true;
                        this.searchErrorMessage = searchErr.message || 'Lỗi kết nối máy chủ';
                    }
                }
            } else {
                this.searchRadiusMeters = meters;
                this.updateRadiusCircle();
                await this.executeSearchAndRank();
            }
        },

        async retrySearchOnly() {
            if (this.ranking) return;
            this.showToast('🔄 Đang thử tìm lại quán theo bán kính mới...', 'info');
            await this.executeSearchAndRank();
        },

        selectVenue(venue) {
            if (!venue) return;
            this.selectedVenue = venue;
            this.drawTravelLines(venue);

            if (this.map && this.map.getBounds && !this.map.getBounds().contains([venue.lat, venue.lng])) {
                this.map.panTo([venue.lat, venue.lng], { animate: true, duration: 0.4 });
            }

            this.$nextTick(() => {
                const el = document.getElementById('venue-card-' + venue.id);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            });
        },

        async executeSearchAndRank() {
            this.ranking = true;
            this.emptyStateReason = null;
            this.searchRequestId = (this.searchRequestId || 0) + 1;
            const currentReqId = this.searchRequestId;

            if (this.searchAbortController) {
                try { this.searchAbortController.abort(); } catch (_) {}
            }
            this.searchAbortController = new AbortController();

            try {
                const requestPayload = {
                    outingId: this.outingCode || undefined,
                    center: this.centerCoords,
                    radiusMeters: this.searchRadiusMeters,
                    requiredConstraints: this.confirmedConstraints,
                    softPreferences: this.confirmedSoftPreferences,
                    interpretation: this.parsedInterpretation,
                    friends: this.friends
                };

                const data = await window.ApiClient.post('/api/venues/search-and-rank', requestPayload, {
                    signal: this.searchAbortController.signal,
                    timeoutMs: 15000,
                    shareToken: this.shareToken
                });

                if (currentReqId !== this.searchRequestId) return;

                // Reset search failure flags on success
                this.searchFailed = false;
                this.isShortlistStale = false;
                this.searchErrorMessage = '';

                // Sync outing code and share token if assigned/created by backend
                if (data.outingId) {
                    this.setOutingCodeAndSyncUrl(data.outingId, data.shareToken);
                }

                this.shortlist = data.shortlist || [];
                this.nearbyAlternatives = data.nearbyAlternatives || [];
                this.searchMessage = data.message || '';

                if (this.shortlist.length === 0) {
                    const hasStrictConstraints = this.confirmedConstraints.vegetarian || 
                                                this.confirmedConstraints.no_alcohol || 
                                                this.confirmedConstraints.quiet_only;
                    this.emptyStateReason = hasStrictConstraints ? 'hard_constraint_filtered' : 'no_data';
                }

                this.renderVenueMarkers();

                if (this.shortlist.length > 0) {
                    this.selectVenue(this.shortlist[0]);
                } else {
                    this.clearTravelLines();
                }
            } catch (err) {
                if (err.name === 'AbortError' || err.name === 'TimeoutError') return;
                console.error('Search and rank error:', err);
                this.searchFailed = true;
                this.isShortlistStale = true;
                this.searchErrorMessage = err.message || 'Lỗi kết nối máy chủ';
                this.emptyStateReason = 'api_error';
                this.showToast(`⚠️ Không thể tải danh sách gợi ý: ${err.message}`, 'error');
            } finally {
                if (currentReqId === this.searchRequestId) {
                    this.ranking = false;
                }
            }
        },

        async calculateCenter() {
            if (this.isCustomCenter) {
                this.renderCenterMarker();
                this.renderFriendMarkers();
                return;
            }
            const points = this.friends.map(f => ({ name: f.name, lat: f.lat, lng: f.lng }));
            try {
                const data = await window.ApiClient.post('/api/center/geometric-median', { points });
                if (data && data.median) {
                    this.centerCoords = data.median;
                    this.renderCenterMarker();
                    this.renderFriendMarkers();
                }
            } catch (err) {
                console.warn('Calculate center error:', err);
            }
        },

        async searchAddressForFriend(friend, query) {
            if (!query || !query.trim()) return;
            friend.locating = true;
            try {
                const data = await window.ApiClient.get('/api/geocode?q=' + encodeURIComponent(query.trim()));
                if (data && data.lat && data.lng) {
                    friend.lat = Number(data.lat);
                    friend.lng = Number(data.lng);
                    friend.customAddress = data.name && data.address && !data.address.startsWith(data.name)
                        ? `${data.name} (${data.address})`
                        : (data.address || data.name || query);
                    friend.lastResolvedAddress = query.trim();

                    const msg = data.source === 'gemini_nlp'
                        ? `✨ AI đã định vị: ${data.name}`
                        : `📍 Đã định vị: ${data.name || data.address}`;
                    this.showToast(msg, 'success');

                    this.renderFriendMarkers();
                    await this.calculateCenter();
                    this.executeSearchAndRank();
                } else {
                    this.showToast('⚠️ Không tìm thấy tọa độ cho địa điểm này.', 'warning');
                }
            } catch (err) {
                this.showToast(`⚠️ Lỗi định vị: ${err.message}`, 'error');
            } finally {
                friend.locating = false;
            }
        },

        async searchCustomCenter(query) {
            if (!query || !query.trim()) return;
            this.searchingCenter = true;
            try {
                const data = await window.ApiClient.get('/api/geocode?q=' + encodeURIComponent(query.trim()));
                if (data && data.lat && data.lng) {
                    this.centerCoords = { lat: Number(data.lat), lng: Number(data.lng) };
                    this.isCustomCenter = true;
                    this.customCenterAddress = data.name || data.address || query.trim();
                    this.lastResolvedCenterAddress = this.customCenterAddress;
                    this.showToast(`📍 Đã đặt tâm điểm tại: ${this.customCenterAddress}`, 'success');

                    this.renderCenterMarker();
                    if (this.map) {
                        this.map.panTo([this.centerCoords.lat, this.centerCoords.lng]);
                    }
                    this.executeSearchAndRank();
                } else {
                    this.showToast('⚠️ Không tìm thấy tọa độ cho địa điểm này.', 'warning');
                }
            } catch (err) {
                this.showToast(`⚠️ Lỗi tìm tâm điểm: ${err.message}`, 'error');
            } finally {
                this.searchingCenter = false;
            }
        },

        resetToGeometricCenter() {
            this.isCustomCenter = false;
            this.customCenterAddress = '';
            this.calculateCenter().then(() => {
                this.showToast('🔄 Đã tính lại tâm Weiszfeld chuẩn xác!', 'success');
                this.executeSearchAndRank();
            });
        },

        async saveAndParseGroup() {
            this.parsing = true;
            try {
                // Auto-resolve typed addresses for friends
                for (const f of this.friends) {
                    const addr = (f.customAddress || '').trim();
                    if (addr && addr !== f.lastResolvedAddress) {
                        try {
                            const geoData = await window.ApiClient.get('/api/geocode?q=' + encodeURIComponent(addr));
                            if (geoData && geoData.lat && geoData.lng) {
                                f.lat = Number(geoData.lat);
                                f.lng = Number(geoData.lng);
                                f.lastResolvedAddress = addr;
                                f.customAddress = geoData.name || geoData.address || addr;
                            }
                        } catch (_) {}
                    }
                }
                this.renderFriendMarkers();

                // Auto-resolve custom center if specified
                const customCenter = (this.customCenterAddress || '').trim();
                if (customCenter && (!this.isCustomCenter || customCenter !== this.lastResolvedCenterAddress)) {
                    try {
                        const centerData = await window.ApiClient.get('/api/geocode?q=' + encodeURIComponent(customCenter));
                        if (centerData && centerData.lat && centerData.lng) {
                            this.centerCoords = { lat: Number(centerData.lat), lng: Number(centerData.lng) };
                            this.isCustomCenter = true;
                            this.lastResolvedCenterAddress = customCenter;
                            this.customCenterAddress = centerData.name || centerData.address || customCenter;
                        }
                    } catch (_) {}
                }

                await this.calculateCenter();

                if (this.map && this.friends.length > 0) {
                    this.fitMapToAll();
                }

                // AI Discussion Parsing
                let textToSend = (this.discussionText || '').trim();
                if (!textToSend) {
                    textToSend = this.friends.map(f => `${f.name}: ${f.wish || 'ăn uống thoải mái'}`).join('. ');
                }

                const data = await window.ApiClient.post('/api/preferences/parse', {
                    discussionText: textToSend,
                    friends: this.friends
                });

                this.parsedInterpretation = data;
                if (data.hardConstraints) {
                    this.confirmedConstraints = {
                        vegetarian: !!data.hardConstraints.vegetarian,
                        no_alcohol: !!data.hardConstraints.no_alcohol,
                        quiet_only: !!data.hardConstraints.quiet_only,
                        max_price_vnd: data.hardConstraints.max_price_vnd || 500000
                    };
                }
                if (Array.isArray(data.softPreferences)) {
                    this.confirmedSoftPreferences = data.softPreferences;
                }

                await this.executeSearchAndRank();
            } catch (err) {
                console.error('saveAndParseGroup error:', err);
                await this.executeSearchAndRank();
            } finally {
                this.parsing = false;
                this.closeGroupModal();
            }
        },

        addFriendAtCenter() {
            const presets = [
                { name: 'David (D4)', lat: 10.7608, lng: 106.7050 },
                { name: 'Emma (Phu Nhuan)', lat: 10.7965, lng: 106.6890 },
                { name: 'Frank (D7)', lat: 10.7330, lng: 106.7055 }
            ];
            const p = presets[this.friends.length % presets.length];
            const colors = ['bg-purple-500', 'bg-cyan-500', 'bg-pink-500', 'bg-teal-500'];
            const color = colors[this.friends.length % colors.length];

            this.friends.push({
                id: Date.now(),
                name: p.name,
                lat: p.lat,
                lng: p.lng,
                color,
                wish: '',
                customAddress: ''
            });

            this.calculateCenter().then(() => this.executeSearchAndRank());
        },

        removeFriend(idx) {
            if (this.friends.length <= 1) return;
            this.friends.splice(idx, 1);
            this.calculateCenter().then(() => this.executeSearchAndRank());
        },

        useCurrentLocation() {
            if (!navigator.geolocation) {
                this.showToast('⚠️ Trình duyệt của bạn không hỗ trợ định vị GPS.', 'warning');
                return;
            }
            this.locating = true;
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    this.locating = false;
                    const lat = Number(pos.coords.latitude.toFixed(6));
                    const lng = Number(pos.coords.longitude.toFixed(6));
                    if (this.friends.length > 0) {
                        this.friends[0].name = 'You (GPS)';
                        this.friends[0].lat = lat;
                        this.friends[0].lng = lng;
                        this.friends[0].customAddress = 'Vị trí GPS hiện tại';
                    }
                    this.showToast('📍 Đã định vị thành công vị trí GPS của bạn!', 'success');
                    this.renderFriendMarkers();
                    this.calculateCenter().then(() => this.executeSearchAndRank());
                },
                (err) => {
                    this.locating = false;
                    this.showToast(`⚠️ Không thể lấy GPS (${err.message}). Đang dùng vị trí mặc định TP.HCM.`, 'warning');
                },
                { timeout: 8000, enableHighAccuracy: true }
            );
        },

        async fetchPresets() {
            try {
                const data = await window.ApiClient.get('/api/presets');
                this.presetsList = data.presets || [];
            } catch (_) {}
        },

        async loadPreset(presetId) {
            this.activePresetId = presetId;
            let preset = this.presetsList.find(p => p.id === presetId);
            if (!preset) {
                await this.fetchPresets();
                preset = this.presetsList.find(p => p.id === presetId);
            }
            if (!preset) return;

            this.friends = JSON.parse(JSON.stringify(preset.friends));
            this.searchRadiusMeters = preset.radiusMeters || 3000;
            if (preset.constraints) {
                this.confirmedConstraints = { ...this.confirmedConstraints, ...preset.constraints };
            }
            if (preset.softPreferences) {
                this.confirmedSoftPreferences = preset.softPreferences;
            }

            this.renderFriendMarkers();
            await this.calculateCenter();
            this.fitMapToAll();
            this.executeSearchAndRank();
            this.showToast(`⚡ Đã tải kịch bản: ${preset.title}`, 'success');
        },

        switchMobileView(v) {
            this.mobileView = v;
            if (v === 'map') {
                this.triggerMapResize(60);
                this.triggerMapResize(220);
            }
        }
    };
};
