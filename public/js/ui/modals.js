/**
 * GatherMap Modals UI Controller
 * Modal opening, closing, keyboard listener (ESC), and map redraw alignment.
 */
window.createModalsController = function() {
    return {
        openGroupModal() {
            this.showGroupModal = true;
        },

        closeGroupModal() {
            this.showGroupModal = false;
            this.triggerMapResize(100);
        },

        openFriendsModal() {
            this.showGroupModal = true;
        },

        closeFriendsModal() {
            this.closeGroupModal();
        },

        closeWishModal() {
            this.closeGroupModal();
        },

        closeReviewersModal() {
            this.showReviewersModal = false;
            this.triggerMapResize(100);
        },

        closeShareModal() {
            this.showShareModal = false;
        },

        triggerMapResize(delayMs = 80) {
            this.$nextTick(() => {
                setTimeout(() => {
                    if (this.map && typeof this.map.invalidateSize === 'function') {
                        this.map.invalidateSize();
                    }
                }, delayMs);
            });
        },

        initKeyboardShortcuts() {
            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    if (this.showGroupModal) this.closeGroupModal();
                    if (this.showReviewersModal) this.closeReviewersModal();
                    if (this.showShareModal) this.closeShareModal();
                }
            });
        }
    };
};
