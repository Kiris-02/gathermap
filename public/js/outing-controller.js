/**
 * GatherMap Outing Controller
 * Manages outing session lifecycle, URL syncing, voting deduplication, live polling, and sharing.
 */
window.createOutingController = function() {
    return {
        pollTimer: null,
        consecutivePollErrors: 0,
        myVotedVenueId: null,

        async initOutingSession() {
            if (this.outingCode) {
                try {
                    const sessionData = await window.ApiClient.get(`/api/outings/${this.outingCode}`, {
                        shareToken: this.shareToken
                    });
                    if (sessionData && sessionData.outing) {
                        if (sessionData.isLegacyUpgraded && sessionData.shareToken) {
                            this.setOutingCodeAndSyncUrl(this.outingCode, sessionData.shareToken);
                            this.showToast('🎉 Kèo đã được nâng cấp bảo mật! Link mới đã sẵn sàng.', 'success');
                        }
                        this.applyLoadedSession(sessionData);
                        return;
                    }
                } catch (err) {
                    console.warn(`Outing ${this.outingCode} could not be loaded (${err.message}). Starting fresh session.`);
                    if (err.data?.code === 'legacy_link_expired') {
                        this.showToast('🔒 ' + (err.message || 'Kèo này đã được nâng cấp bảo mật. Vui lòng mở lại bằng link mới.'), 'warning');
                    } else if (err.status === 401 || err.status === 403) {
                        this.showToast('🔒 Bạn không có quyền xem kèo này (cần link chia sẻ có mã xác thực).', 'error');
                    } else {
                        this.showToast('ℹ️ Không tìm thấy kèo cũ, đã tạo kèo mới cho bạn.', 'info');
                    }
                    this.outingCode = '';
                    this.shareToken = '';
                }
            }

            // Start live vote polling
            this.startLiveVotePolling();
        },

        applyLoadedSession(sessionData) {
            const outing = sessionData.outing || sessionData;

            // Harmonized friends/participants loading
            const friendsList = outing.friends || outing.participants || sessionData.friends || sessionData.participants;
            if (Array.isArray(friendsList) && friendsList.length > 0) {
                this.friends = friendsList.map((f, idx) => ({
                    id: f.id || `friend-${idx}`,
                    name: f.name || 'Friend',
                    lat: Number(f.lat),
                    lng: Number(f.lng),
                    wish: f.wish || '',
                    isMe: Boolean(f.isMe || f.is_me)
                }));
                this.renderFriendMarkers();
            }

            // Harmonized center coordinates
            const cLat = outing.centerLat ?? outing.center_lat ?? (outing.center?.lat ?? sessionData.centerLat);
            const cLng = outing.centerLng ?? outing.center_lng ?? (outing.center?.lng ?? sessionData.centerLng);
            if (cLat != null && cLng != null) {
                this.centerCoords = { lat: Number(cLat), lng: Number(cLng) };
                this.renderCenterMarker();
            }

            // Harmonized search radius
            const rMeters = outing.radiusMeters ?? outing.radius_meters ?? (outing.radiusKm != null ? Math.round(outing.radiusKm * 1000) : (outing.radius_km != null ? Math.round(outing.radius_km * 1000) : null));
            if (rMeters != null) {
                this.searchRadiusMeters = Number(rMeters);
                this.updateRadiusCircle();
            }

            // Restore saved recommendations / shortlist
            const savedShortlist = sessionData.shortlist || sessionData.recommendations || outing.shortlist || outing.recommendations;
            if (Array.isArray(savedShortlist) && savedShortlist.length > 0) {
                this.shortlist = savedShortlist;
                this.emptyStateReason = null;
                this.renderVenueMarkers();
                if (this.shortlist.length > 0) {
                    this.selectVenue(this.shortlist[0]);
                }
            }

            // Sync votes
            const votes = sessionData.votes || outing.votes;
            if (Array.isArray(votes)) {
                this.syncVoteCountsFromList(votes);
            }

            this.sessionLoaded = true;
            this.showToast(`✨ Đã kết nối vào kèo: #${this.outingCode}`, 'success');
            this.startLiveVotePolling();
        },

        setOutingCodeAndSyncUrl(code, token = null) {
            if (!code) return;
            this.outingCode = code;
            if (token) {
                this.shareToken = token;
                window._currentShareToken = token;
            }
            try {
                const newUrl = new URL(window.location.href);
                newUrl.searchParams.set('outing', code);
                if (this.shareToken) {
                    newUrl.searchParams.set('token', this.shareToken);
                }
                window.history.replaceState({}, '', newUrl.toString());
            } catch (_) {}
        },

        async voteForVenue(venue) {
            if (!venue) return;
            if (!this.outingCode) {
                this.showToast('⚠️ Vui lòng bấm Let\'s Go để bắt đầu kèo trước khi bình chọn.', 'warning');
                return;
            }

            const previousVotedVenueId = this.myVotedVenueId;
            const isTogglingOff = previousVotedVenueId === venue.id;

            // Optimistic UI updates
            if (isTogglingOff) {
                venue.votes = Math.max(0, (venue.votes || 1) - 1);
                this.myVotedVenueId = null;
                this.showToast(`Đã thu hồi phiếu cho "${venue.name}"`, 'info');
            } else {
                if (previousVotedVenueId) {
                    const prevVenue = this.shortlist.find(v => v.id === previousVotedVenueId);
                    if (prevVenue) {
                        prevVenue.votes = Math.max(0, (prevVenue.votes || 1) - 1);
                    }
                }
                venue.votes = (venue.votes || 0) + 1;
                this.myVotedVenueId = venue.id;
                this.votedVenueId = venue.id;
                setTimeout(() => { this.votedVenueId = null; }, 500);
                this.showToast(`🗳️ +1 phiếu cho "${venue.name}"! (Tổng: ${venue.votes})`, 'success');
            }

            try {
                const res = await window.ApiClient.post(`/api/outings/${this.outingCode}/vote`, {
                    venueId: venue.id,
                    voterId: this.voterId,
                    voterName: this.voterName || 'You'
                });

                if (res && res.action === 'unvoted') {
                    this.myVotedVenueId = null;
                } else if (res && res.action) {
                    this.myVotedVenueId = venue.id;
                }
            } catch (err) {
                console.error('Vote failed, rolling back:', err);
                // Rollback optimistic update correctly for both toggle-off and vote-change
                if (isTogglingOff) {
                    venue.votes = (venue.votes || 0) + 1;
                    this.myVotedVenueId = venue.id;
                } else {
                    venue.votes = Math.max(0, (venue.votes || 1) - 1);
                    if (previousVotedVenueId) {
                        const prevVenue = this.shortlist.find(v => v.id === previousVotedVenueId);
                        if (prevVenue) {
                            prevVenue.votes = (prevVenue.votes || 0) + 1;
                        }
                    }
                    this.myVotedVenueId = previousVotedVenueId;
                }
                this.showToast(`⚠️ Không thể lưu bình chọn: ${err.message}`, 'error');
            }
        },

        startLiveVotePolling() {
            if (this.pollTimer) clearInterval(this.pollTimer);
            this.consecutivePollErrors = 0;

            this.pollTimer = setInterval(async () => {
                if (!this.outingCode || !this.shortlist || this.shortlist.length === 0) return;
                if (this.consecutivePollErrors >= 5) {
                    // Back off polling if server returns continuous errors
                    return;
                }

                try {
                    const data = await window.ApiClient.get(`/api/outings/${this.outingCode}`, {
                        shareToken: this.shareToken
                    });
                    this.consecutivePollErrors = 0;
                    if (data && Array.isArray(data.votes)) {
                        this.syncVoteCountsFromList(data.votes);
                    }
                } catch (e) {
                    this.consecutivePollErrors++;
                }
            }, 4000);
        },

        syncVoteCountsFromList(votesList) {
            const counts = {};
            let myVoteFound = false;

            votesList.forEach(v => {
                const vId = v.venue_id || v.venueId;
                counts[vId] = (counts[vId] || 0) + 1;

                const voter = v.voter_id || v.voterId || v.voter_name || v.voterName;
                if (voter === this.voterId || voter === this.voterName) {
                    this.myVotedVenueId = vId;
                    myVoteFound = true;
                }
            });

            if (!myVoteFound && this.myVotedVenueId !== null) {
                this.myVotedVenueId = null;
            }

            this.shortlist.forEach(v => {
                const serverCount = counts[v.id] || 0;
                if (v.votes !== serverCount) {
                    v.votes = serverCount;
                }
            });

            this.votesMap = counts;
            this.votesList = votesList;
        },

        copyShareLink() {
            const params = new URLSearchParams();
            if (this.outingCode) params.set('outing', this.outingCode);
            if (this.shareToken) params.set('token', this.shareToken);
            const queryStr = params.toString() ? `?${params.toString()}` : '';
            const shareUrl = `${window.location.origin}/${queryStr}`;
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(shareUrl).then(() => {
                    this.copied = true;
                    setTimeout(() => { this.copied = false; }, 2500);
                    this.showToast('📋 Đã sao chép link chia sẻ (kèm mã bảo mật) vào clipboard!', 'success');
                }).catch(() => {
                    this.showToast('⚠️ Không thể tự động sao chép. Hãy copy đường dẫn từ thanh địa chỉ.', 'warning');
                });
            }
        },

        async shareVenuePlan(venue) {
            try {
                const shareRes = await window.ApiClient.post('/api/outings/generate-share-text', {
                    venue,
                    friends: this.friends,
                    groupScore: venue.groupScore || 90,
                    outingCode: this.outingCode,
                    shareToken: this.shareToken
                });

                if (shareRes && shareRes.message) {
                    this.shareModalData = {
                        message: shareRes.message,
                        shareUrl: shareRes.shareUrl || `https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lng}`,
                        venueName: shareRes.venueName || venue.name,
                        appUrl: shareRes.appUrl || window.location.origin
                    };

                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(shareRes.message).catch(() => {});
                    }

                    this.showShareModal = true;
                    this.showToast('🎉 Đã tạo tin nhắn rủ bạn bè! Hãy dán vào Zalo/Messenger.', 'success');
                }
            } catch (err) {
                console.error('Share plan error:', err);
                this.showToast('⚠️ Đã có lỗi khi tạo tin nhắn chia sẻ.', 'error');
            }
        },

        copyShareMessage() {
            if (this.shareModalData && this.shareModalData.message) {
                navigator.clipboard.writeText(this.shareModalData.message).then(() => {
                    this.showToast('📋 Đã sao chép tin nhắn rủ bạn vào clipboard!', 'success');
                });
            }
        }
    };
};
