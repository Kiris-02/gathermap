/**
 * GatherMap Notifications UI Controller
 * Toast alerts, error banners, and non-blocking user feedback.
 */
window.createNotificationsController = function() {
    return {
        showToast(msg, type = 'info') {
            this.toastMessage = msg;
            this.toastType = type;
            if (this.toastTimer) {
                clearTimeout(this.toastTimer);
            }
            this.toastTimer = setTimeout(() => {
                this.toastMessage = '';
            }, 3800);
        },

        getToastIcon() {
            switch (this.toastType) {
                case 'success':
                    return 'fa-circle-check text-emerald-400';
                case 'warning':
                    return 'fa-triangle-exclamation text-amber-400';
                case 'error':
                    return 'fa-circle-xmark text-rose-400';
                default:
                    return 'fa-circle-info text-blue-400';
            }
        }
    };
};
