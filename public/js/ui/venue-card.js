/**
 * GatherMap Venue Card UI Controller
 * Truthful opening hour calculations, image fallback, and breakdown helpers.
 */
window.createVenueCardController = function() {
    return {
        expandedBreakdownVenueId: null,

        toggleBreakdown(venueId) {
            if (this.expandedBreakdownVenueId === venueId) {
                this.expandedBreakdownVenueId = null;
            } else {
                this.expandedBreakdownVenueId = venueId;
            }
        },

        isBreakdownExpanded(venueId) {
            return this.expandedBreakdownVenueId === venueId;
        },

        getOpeningBadge(venue) {
            if (!venue) {
                return {
                    type: 'unverified',
                    label: '⚪ Chưa xác minh',
                    colorClass: 'bg-slate-800 text-slate-400 border-slate-700',
                    icon: 'fa-clock'
                };
            }

            const oh = venue.openingHours;
            const tags = Array.isArray(venue.tags) ? venue.tags : [];
            const is24_7 = (oh && (oh.is24_7 || oh.is24h)) || 
                           tags.some(t => String(t).toLowerCase().includes('24/7') || 
                                          String(t).toLowerCase().includes('24h') || 
                                          String(t).toLowerCase().includes('xuyên đêm'));

            if (is24_7) {
                return {
                    type: '24_7',
                    label: '⚡ Mở 24/7',
                    colorClass: 'bg-purple-500/25 text-purple-300 border-purple-500/40',
                    icon: 'fa-bolt'
                };
            }

            // If opening hours are missing or neither open nor close is specified
            if (!oh || (!oh.open && !oh.close)) {
                return {
                    type: 'unverified',
                    label: '⚪ Giờ mở cửa: Chưa xác minh',
                    colorClass: 'bg-slate-800/90 text-slate-400 border-slate-700',
                    icon: 'fa-clock'
                };
            }

            // Accurate GMT+7 Vietnam Time calculation
            try {
                const now = new Date();
                const vnTimeStr = now.toLocaleTimeString('en-US', {
                    timeZone: 'Asia/Ho_Chi_Minh',
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit'
                });
                const [currH, currM] = vnTimeStr.split(':').map(Number);
                const currentTotalMin = (currH || 0) * 60 + (currM || 0);

                const openStr = oh.open || '09:00';
                const closeStr = oh.close || '22:00';

                const [ohH, ohM] = openStr.split(':').map(Number);
                const [chH, chM] = closeStr.split(':').map(Number);

                const openMin = (ohH || 0) * 60 + (ohM || 0);
                const closeMin = (chH || 0) * 60 + (chM || 0);

                let isOpen = true;
                if (closeMin > openMin) {
                    isOpen = currentTotalMin >= openMin && currentTotalMin < closeMin;
                } else {
                    // Overnight venue (e.g. 17:00 to 02:00)
                    isOpen = currentTotalMin >= openMin || currentTotalMin < closeMin;
                }

                if (isOpen) {
                    return {
                        type: 'open',
                        label: '🟢 Đang mở · Đến ' + closeStr,
                        colorClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
                        icon: 'fa-circle'
                    };
                } else {
                    return {
                        type: 'closed',
                        label: '🔴 Đã đóng · Mở ' + openStr,
                        colorClass: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
                        icon: 'fa-circle-xmark'
                    };
                }
            } catch (_) {
                return {
                    type: 'unverified',
                    label: '⚪ Giờ mở cửa: Chưa rõ',
                    colorClass: 'bg-slate-800 text-slate-400 border-slate-700',
                    icon: 'fa-clock'
                };
            }
        },

        getOpeningHoursDetail(venue) {
            const badge = this.getOpeningBadge(venue);
            if (badge.type === '24_7') {
                return 'Quán mở cửa liên tục 24/7 (Phục vụ xuyên đêm)';
            }
            if (badge.type === 'unverified') {
                return 'Chưa có thông tin giờ mở cửa chính xác từ quán';
            }
            const oh = venue.openingHours;
            const text = (oh && oh.displayText) ? oh.displayText : `${oh.open} - ${oh.close}`;
            return (badge.type === 'open' ? 'Đang mở cửa: ' : 'Đã đóng cửa: ') + text + (oh && oh.openDays ? ' (' + oh.openDays + ')' : '');
        },

        getVenueImage(venue) {
            if (venue && venue.heroImage && typeof venue.heroImage === 'string' && venue.heroImage.startsWith('http')) {
                return venue.heroImage;
            }
            if (venue && venue.photos && Array.isArray(venue.photos) && venue.photos.length > 0 && typeof venue.photos[0] === 'string' && venue.photos[0].startsWith('http')) {
                return venue.photos[0];
            }

            const name = (venue?.name || '').toLowerCase();
            const cat = (venue?.category || '').toLowerCase();

            if (cat.includes('vegetarian') || cat.includes('chay')) {
                return 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=600&auto=format&fit=crop&q=80';
            }
            if (name.includes('matcha') || cat.includes('matcha')) {
                return 'https://images.unsplash.com/photo-1536256263959-770b48d82b0a?w=600&auto=format&fit=crop&q=80';
            }
            if (venue?.isAlley || cat.includes('alley') || cat.includes('hẻm') || cat.includes('street food')) {
                return 'https://images.unsplash.com/photo-1503764654157-72d979d9af2f?w=600&auto=format&fit=crop&q=80';
            }
            if (cat.includes('music') || cat.includes('pub') || cat.includes('bar')) {
                return 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=600&auto=format&fit=crop&q=80';
            }
            if (cat.includes('coffee') || cat.includes('workspace') || cat.includes('cà phê')) {
                return 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=600&auto=format&fit=crop&q=80';
            }
            return 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=600&auto=format&fit=crop&q=80';
        }
    };
};
