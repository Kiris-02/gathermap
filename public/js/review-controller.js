/**
 * GatherMap Review Controller
 * Handles reviewer drawer display, review fetching, and user review submissions.
 */
window.createReviewController = function() {
    return {
        async openReviewersDrawer(venue) {
            if (!venue) return;
            this.activeReviewerVenue = venue;
            this.showReviewersModal = true;

            try {
                const data = await window.ApiClient.get(`/api/venues/${venue.id}/reviewers`);
                if (data && data.reviewers) {
                    this.activeReviewerVenue = {
                        ...venue,
                        reviewers: data.reviewers,
                        reviewerCount: data.reviewerCount ?? data.reviewers.length,
                        socialHighlights: data.socialHighlights || venue.socialHighlights || {}
                    };
                }
            } catch (err) {
                console.warn('Failed to load reviewers:', err);
            }
        },

        async submitReviewFromDrawer() {
            if (!this.drawerNewReview.content || !this.drawerNewReview.content.trim() || !this.activeReviewerVenue) {
                return;
            }

            const venueId = this.activeReviewerVenue.id;
            const content = this.drawerNewReview.content.trim();
            const rating = Number(this.drawerNewReview.rating || 5.0);

            try {
                const data = await window.ApiClient.post(`/api/venues/${venueId}/reviews`, {
                    source: 'user',
                    authorName: this.voterName || 'Bạn (Người dùng)',
                    rating,
                    content
                });

                if (data && data.success) {
                    this.showToast('🎉 Nhận xét của bạn đã được đăng thành công!', 'success');

                    if (!this.activeReviewerVenue.reviewers) {
                        this.activeReviewerVenue.reviewers = [];
                    }

                    this.activeReviewerVenue.reviewers.unshift({
                        id: data.id || ('rev_' + Date.now()),
                        authorName: this.voterName || 'Bạn (Người dùng)',
                        source: 'user',
                        rating,
                        content,
                        reviewDate: 'Vừa xong'
                    });

                    this.activeReviewerVenue.reviewerCount = (this.activeReviewerVenue.reviewerCount || 0) + 1;
                    this.drawerNewReview.content = '';
                }
            } catch (err) {
                console.error('Submit review error:', err);
                this.showToast(`⚠️ Không thể gửi nhận xét: ${err.message}`, 'error');
            }
        }
    };
};
